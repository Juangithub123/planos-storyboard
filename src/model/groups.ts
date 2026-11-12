import type { Clip, Group, Id, Layer } from './types';

/**
 * Grupos/carpetas de capas. Las capas de un grupo son siempre contiguas en clip.layers;
 * el grupo se dibuja como encabezado antes de su primera capa.
 */

/** Quita grupos sin capas. */
export function normalizeGroups(c: Clip): Clip {
  if (!c.groups?.length) return c;
  const used = new Set(c.layers.map((l) => l.groupId).filter(Boolean));
  const groups = c.groups.filter((g) => used.has(g.id));
  return groups.length === c.groups.length ? c : { ...c, groups };
}

/** Crea un grupo nuevo que contiene la capa `lid`. */
export function groupLayer(c: Clip, lid: Id, makeId: () => Id, name = 'Grupo'): { clip: Clip; group: Group | null } {
  const L = c.layers.find((l) => l.id === lid);
  if (!L || L.groupId) return { clip: c, group: null };
  const g: Group = { id: makeId(), name, visible: true, locked: false, opacity: 1, collapsed: false };
  return {
    clip: { ...c, groups: [...(c.groups ?? []), g], layers: c.layers.map((l) => (l.id === lid ? { ...l, groupId: g.id } : l)) },
    group: g,
  };
}

/** Saca una capa de su grupo y la ubica justo debajo del bloque del grupo. */
export function ungroupLayer(c: Clip, lid: Id): Clip {
  const i = c.layers.findIndex((l) => l.id === lid);
  if (i < 0 || !c.layers[i].groupId) return c;
  const gid = c.layers[i].groupId;
  const layers = c.layers.slice();
  const [L] = layers.splice(i, 1);
  let last = -1;
  layers.forEach((l, k) => l.groupId === gid && (last = k));
  layers.splice(last + 1, 0, { ...L, groupId: null });
  return normalizeGroups({ ...c, layers });
}

/** Elimina el grupo; sus capas quedan sueltas en el mismo lugar. */
export function dissolveGroup(c: Clip, gid: Id): Clip {
  return {
    ...c,
    groups: (c.groups ?? []).filter((g) => g.id !== gid),
    layers: c.layers.map((l) => (l.groupId === gid ? { ...l, groupId: null } : l)),
  };
}

/**
 * Mueve una capa una posición (dir -1 = arriba). Si el vecino está en otro grupo,
 * en vez de saltar sobre él la capa entra o sale del grupo (como en las carpetas de TVPaint/PS).
 */
export function moveLayerStep(c: Clip, lid: Id, dir: -1 | 1): Clip {
  const i = c.layers.findIndex((l) => l.id === lid);
  const j = i + dir;
  if (i < 0) return c;
  const cur = c.layers[i];
  const nb = c.layers[j];
  const layers = c.layers.slice();
  if (!nb) {
    if (!cur.groupId) return c;
    layers[i] = { ...cur, groupId: null }; // sale del grupo por el borde
    return normalizeGroups({ ...c, layers });
  }
  if ((nb.groupId ?? null) !== (cur.groupId ?? null)) {
    layers[i] = { ...cur, groupId: cur.groupId ? null : nb.groupId };
    return normalizeGroups({ ...c, layers });
  }
  [layers[i], layers[j]] = [layers[j], layers[i]];
  return { ...c, layers };
}

export function updateGroup(c: Clip, gid: Id, fn: (g: Group) => Group): Clip {
  return { ...c, groups: (c.groups ?? []).map((g) => (g.id === gid ? fn(g) : g)) };
}

/** Las capas nuevas que se insertan en el índice `at` heredan el grupo de la capa que ocupaba ese lugar. */
export function inheritGroup(c: Clip, at: number, L: Layer): Layer {
  const ref = c.layers[at];
  return ref?.groupId ? { ...L, groupId: ref.groupId } : L;
}
