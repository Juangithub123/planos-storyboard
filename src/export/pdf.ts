import type { Project } from '../model/types';
import { segments } from '../model/sequence';
import { preloadClipDrawings, prepareFrame, renderOutputFrame } from '../render/output';
import type { ExportJob } from './video';

/**
 * PDF de storyboard: grilla de paneles (primer frame del recorte de cada plano, con cámara)
 * con número de plano, nombre y duración. Escritor de PDF mínimo: imágenes JPEG + Helvetica.
 */

export interface PdfOptions {
  cols: number;
  rows: number;
}

/** Texto a bytes WinAnsi (Latin-1 alcanza para el español) escapado para un string PDF. */
function pdfText(s: string): string {
  let out = '';
  for (const ch of s) {
    let code = ch.charCodeAt(0);
    if (ch === '…') code = 0x85;
    else if (ch === '—' || ch === '–') code = 0x96;
    else if (ch === '·') code = 0xb7;
    else if (code > 255) code = 0x3f; // '?'
    const c = String.fromCharCode(code);
    out += c === '(' || c === ')' || c === '\\' ? '\\' + c : c;
  }
  return out;
}

class PdfWriter {
  private parts: Uint8Array[] = [];
  private len = 0;
  private offsets: number[] = [];
  private enc = new TextEncoder();

  private raw(s: string) {
    // los strings PDF van en Latin-1 (un byte por carácter)
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
    this.push(b);
  }
  private push(b: Uint8Array) {
    this.parts.push(b);
    this.len += b.length;
  }
  /** Reserva un número de objeto. */
  alloc(): number {
    this.offsets.push(-1);
    return this.offsets.length;
  }
  obj(n: number, body: string) {
    this.offsets[n - 1] = this.len;
    this.raw(`${n} 0 obj\n${body}\nendobj\n`);
  }
  stream(n: number, dict: string, data: Uint8Array) {
    this.offsets[n - 1] = this.len;
    this.raw(`${n} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`);
    this.push(data);
    this.raw('\nendstream\nendobj\n');
  }
  begin() {
    this.raw('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  }
  finish(root: number): Blob {
    const xref = this.len;
    let s = `xref\n0 ${this.offsets.length + 1}\n0000000000 65535 f \n`;
    for (const o of this.offsets) s += `${String(o).padStart(10, '0')} 00000 n \n`;
    s += `trailer\n<< /Size ${this.offsets.length + 1} /Root ${root} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    this.raw(s);
    void this.enc;
    return new Blob(this.parts as BlobPart[], { type: 'application/pdf' });
  }
}

async function jpeg(cv: HTMLCanvasElement): Promise<Uint8Array> {
  const b = await new Promise<Blob | null>((r) => cv.toBlob(r, 'image/jpeg', 0.88));
  return new Uint8Array(await b!.arrayBuffer());
}

export async function exportPdf(p: Project, o: PdfOptions, job: ExportJob): Promise<Blob> {
  const PW = 842;
  const PH = 595; // A4 apaisado (pt)
  const M = 28;
  const HEAD = 26;
  const CAP = 26;
  const GAP = 12;
  const segs = segments(p);
  const perPage = o.cols * o.rows;
  const pages = Math.max(1, Math.ceil(segs.length / perPage));
  const cellW = (PW - 2 * M - (o.cols - 1) * GAP) / o.cols;
  const cellH = (PH - 2 * M - HEAD - (o.rows - 1) * GAP) / o.rows;
  const ar = p.width / p.height;
  let imgW = cellW;
  let imgH = imgW / ar;
  if (imgH > cellH - CAP) {
    imgH = cellH - CAP;
    imgW = imgH * ar;
  }
  // resolución de cada panel (~2× los puntos)
  const cv = document.createElement('canvas');
  cv.width = Math.round(imgW * 2.2);
  cv.height = Math.round((cv.width * p.height) / p.width);

  const w = new PdfWriter();
  w.begin();
  const catalog = w.alloc();
  const pagesObj = w.alloc();
  const font = w.alloc();
  const fontB = w.alloc();
  w.obj(font, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  w.obj(fontB, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pageIds: number[] = [];
  const date = new Date().toLocaleDateString();

  for (let pg = 0; pg < pages; pg++) {
    const items = segs.slice(pg * perPage, (pg + 1) * perPage);
    const imgs: { id: number; x: number; y: number }[] = [];
    let content = '';
    // encabezado
    content += `BT /F2 13 Tf ${M} ${PH - M - 12} Td (${pdfText(p.name)}) Tj ET\n`;
    content += `BT /F1 9 Tf ${PW - M - 150} ${PH - M - 12} Td (${pdfText(`${date}  ·  Página ${pg + 1} / ${pages}`)}) Tj ET\n`;
    content += `0.75 G 0.5 w ${M} ${PH - M - HEAD + 6} m ${PW - M} ${PH - M - HEAD + 6} l S\n`;
    for (let i = 0; i < items.length; i++) {
      if (job.cancelled) throw new Error('cancelado');
      const s = items[i];
      const col = i % o.cols;
      const row = Math.floor(i / o.cols);
      const x = M + col * (cellW + GAP);
      const top = PH - M - HEAD - row * (cellH + GAP);
      const y = top - imgH;
      await preloadClipDrawings(s.clip);
      await prepareFrame(p, s.clip, s.a);
      renderOutputFrame(cv, p, s.clip, s.a);
      const id = w.alloc();
      w.stream(id, `/Type /XObject /Subtype /Image /Width ${cv.width} /Height ${cv.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, await jpeg(cv));
      imgs.push({ id, x, y });
      content += `q ${imgW.toFixed(2)} 0 0 ${imgH.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im${id} Do Q\n`;
      content += `0 G 0.6 w ${x.toFixed(2)} ${y.toFixed(2)} ${imgW.toFixed(2)} ${imgH.toFixed(2)} re S\n`;
      const num = p.clipOrder.indexOf(s.clip.id) + 1;
      const dur = `${s.n} f  ·  ${(s.n / p.fps).toFixed(2)} s`;
      content += `BT /F2 10 Tf ${x.toFixed(2)} ${(y - 13).toFixed(2)} Td (${pdfText(`${num}.  ${s.clip.name}`)}) Tj ET\n`;
      content += `BT /F1 9 Tf ${(x + imgW - 90).toFixed(2)} ${(y - 13).toFixed(2)} Td (${pdfText(dur)}) Tj ET\n`;
      job.onProgress(pg * perPage + i + 1, segs.length, s.clip.name);
    }
    const cs = w.alloc();
    const bytes = new Uint8Array(content.length);
    for (let i = 0; i < content.length; i++) bytes[i] = content.charCodeAt(i) & 255;
    w.stream(cs, '', bytes);
    const pid = w.alloc();
    const xobj = imgs.map((im) => `/Im${im.id} ${im.id} 0 R`).join(' ');
    w.obj(pid, `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PW} ${PH}] /Contents ${cs} 0 R /Resources << /Font << /F1 ${font} 0 R /F2 ${fontB} 0 R >> /XObject << ${xobj} >> >> >>`);
    pageIds.push(pid);
  }
  w.obj(pagesObj, `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  w.obj(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  return w.finish(catalog);
}
