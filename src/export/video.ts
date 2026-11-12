import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from 'webm-muxer';
import type { Project } from '../model/types';
import { segments, totalFrames } from '../model/sequence';
import { mixdown } from '../audio/engine';
import { preloadClipDrawings, prepareFrame, renderOutputFrame } from '../render/output';

export interface ExportJob {
  cancelled: boolean;
  onProgress: (done: number, total: number, stage: string) => void;
}

type Format = { container: 'mp4' | 'webm'; vcodec: string; acodec: string | null };

const SR = 48000;

async function pickFormat(w: number, h: number, fps: number, withAudio: boolean): Promise<Format | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  const vOk = async (codec: string) => {
    try {
      return (await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate: 8e6, framerate: fps })).supported;
    } catch {
      return false;
    }
  };
  const aOk = async (codec: string) => {
    if (typeof AudioEncoder === 'undefined') return false;
    try {
      return (await AudioEncoder.isConfigSupported({ codec, sampleRate: SR, numberOfChannels: 2, bitrate: 128000 })).supported;
    } catch {
      return false;
    }
  };
  for (const vc of ['avc1.640028', 'avc1.4d0028', 'avc1.42002a', 'avc1.42001f']) {
    if (!(await vOk(vc))) continue;
    if (!withAudio) return { container: 'mp4', vcodec: vc, acodec: null };
    if (await aOk('mp4a.40.2')) return { container: 'mp4', vcodec: vc, acodec: 'mp4a.40.2' };
    break; // H.264 sí pero AAC no: probar WebM con Opus
  }
  for (const vc of ['vp09.00.10.08', 'vp8']) {
    if (!(await vOk(vc))) continue;
    if (!withAudio) return { container: 'webm', vcodec: vc, acodec: null };
    if (await aOk('opus')) return { container: 'webm', vcodec: vc, acodec: 'opus' };
    return { container: 'webm', vcodec: vc, acodec: null };
  }
  return null;
}

/** Renderiza el animatic completo (con cámara y audio) a MP4 o WebM. */
export async function exportVideo(p: Project, scale: number, job: ExportJob): Promise<{ blob: Blob; ext: string; note?: string }> {
  const W = Math.max(2, Math.round((p.width * scale) / 2) * 2);
  const H = Math.max(2, Math.round((p.height * scale) / 2) * 2);
  const total = totalFrames(p);
  job.onProgress(0, total, 'Preparando audio…');
  const audio = await mixdown(p, total, SR);
  const fmt = await pickFormat(W, H, p.fps, !!audio);
  if (!fmt) throw new Error('Este navegador no puede codificar video (WebCodecs). Probá con Chrome actualizado.');
  const note = audio && !fmt.acodec ? 'El dispositivo no puede codificar audio: el video sale sin sonido.' : undefined;

  const isMp4 = fmt.container === 'mp4';
  const target = isMp4 ? new Mp4Target() : new WebmTarget();
  const muxer: Mp4Muxer<Mp4Target> | WebmMuxer<WebmTarget> = isMp4
    ? new Mp4Muxer({
      target: target as Mp4Target,
      video: { codec: 'avc', width: W, height: H, frameRate: p.fps },
      audio: fmt.acodec ? { codec: 'aac', numberOfChannels: 2, sampleRate: SR } : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    })
    : new WebmMuxer({
      target: target as WebmTarget,
      video: { codec: fmt.vcodec === 'vp8' ? 'V_VP8' : 'V_VP9', width: W, height: H, frameRate: p.fps },
      audio: fmt.acodec ? { codec: 'A_OPUS', numberOfChannels: 2, sampleRate: SR } : undefined,
      firstTimestampBehavior: 'offset',
    });

  let failure: Error | null = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (failure = e as Error),
  });
  venc.configure({ codec: fmt.vcodec, width: W, height: H, bitrate: Math.round(W * H * p.fps * 0.15), framerate: p.fps, latencyMode: 'quality' });

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const segs = segments(p);
  let gf = 0;
  for (const seg of segs) {
    await preloadClipDrawings(seg.clip);
    for (let i = 0; i < seg.n; i++, gf++) {
      if (job.cancelled) {
        venc.close();
        throw new Error('cancelado');
      }
      if (failure) throw failure;
      const local = seg.a + i;
      await prepareFrame(p, seg.clip, local);
      renderOutputFrame(canvas, p, seg.clip, local);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((gf * 1e6) / p.fps), duration: Math.round(1e6 / p.fps) });
      venc.encode(frame, { keyFrame: gf % (p.fps * 2) === 0 });
      frame.close();
      while (venc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 5));
      if (gf % 4 === 0) job.onProgress(gf, total, 'Video');
    }
  }
  await venc.flush();
  venc.close();

  if (audio && fmt.acodec) {
    job.onProgress(total, total, 'Audio…');
    const aenc = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => (failure = e as Error),
    });
    aenc.configure({ codec: fmt.acodec, sampleRate: SR, numberOfChannels: 2, bitrate: 160000 });
    const L = audio.getChannelData(0);
    const R = audio.numberOfChannels > 1 ? audio.getChannelData(1) : L;
    const CH = 4096;
    for (let s = 0; s < audio.length; s += CH) {
      const n = Math.min(CH, audio.length - s);
      const data = new Float32Array(n * 2);
      data.set(L.subarray(s, s + n), 0);
      data.set(R.subarray(s, s + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((s / SR) * 1e6), data });
      aenc.encode(ad);
      ad.close();
      while (aenc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
    }
    await aenc.flush();
    aenc.close();
  }
  if (failure) throw failure;
  muxer.finalize();
  const buf = (target as Mp4Target | WebmTarget).buffer;
  return { blob: new Blob([buf], { type: isMp4 ? 'video/mp4' : 'video/webm' }), ext: fmt.container, note };
}
