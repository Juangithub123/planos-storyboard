import { describe, expect, it } from 'vitest';
import type { Clip, Layer } from './types';
import { dissolveGroup, groupLayer, moveLayerStep, ungroupLayer } from './groups';
import { isLocked, isVisible, timelineRows } from './evaluate';

const L = (id: string, groupId: string | null = null): Layer => ({
  kind: 'paint', id, name: id, visible: true, locked: false, opacity: 1, blend: 'normal',
  start: 0, pre: 'none', post: 'none', instances: [], groupId,
});
const clip = (layers: Layer[], groups: Clip['groups'] = []): Clip => ({
  id: 'c', name: 'c', layers, groups, playIn: null, playOut: null, trimIn: null, trimOut: null,
});
const G = (id: string, extra = {}) => ({ id, name: id, visible: true, locked: false, opacity: 1, collapsed: false, ...extra });
const order = (c: Clip) => c.layers.map((l) => l.id + (l.groupId ? '@' + l.groupId : ''));

describe('grupos', () => {
  it('agrupar y filas de la timeline', () => {
    const { clip: c, group } = groupLayer(clip([L('a'), L('b')]), 'b', () => 'g');
    expect(group?.id).toBe('g');
    expect(timelineRows(c).map((r) => (r.type === 'group' ? 'G' : r.layer.id))).toEqual(['a', 'G', 'b']);
  });
  it('grupo plegado oculta sus capas', () => {
    const c = clip([L('a', 'g'), L('b', 'g'), L('c')], [G('g', { collapsed: true })]);
    expect(timelineRows(c).map((r) => (r.type === 'group' ? 'G' : r.layer.id))).toEqual(['G', 'c']);
  });
  it('mover entra y sale de grupos en vez de saltarlos', () => {
    let c = clip([L('a'), L('b', 'g'), L('c', 'g'), L('d')], [G('g')]);
    c = moveLayerStep(c, 'a', 1); // a entra al grupo
    expect(order(c)).toEqual(['a@g', 'b@g', 'c@g', 'd']);
    c = moveLayerStep(c, 'a', 1); // dentro del grupo: intercambia
    expect(order(c)).toEqual(['b@g', 'a@g', 'c@g', 'd']);
    c = moveLayerStep(c, 'c', 1); // c sale por abajo
    expect(order(c)).toEqual(['b@g', 'a@g', 'c', 'd']);
  });
  it('desagrupar una capa la deja debajo del grupo; grupo vacío se elimina', () => {
    let c = clip([L('a', 'g'), L('b', 'g'), L('c')], [G('g')]);
    c = ungroupLayer(c, 'a');
    expect(order(c)).toEqual(['b@g', 'a', 'c']);
    c = ungroupLayer(c, 'b');
    expect(c.groups).toEqual([]);
  });
  it('disolver grupo', () => {
    const c = dissolveGroup(clip([L('a', 'g')], [G('g')]), 'g');
    expect(order(c)).toEqual(['a']);
    expect(c.groups).toEqual([]);
  });
  it('visibilidad y bloqueo heredados del grupo', () => {
    const c = clip([L('a', 'g'), L('b')], [G('g', { visible: false, locked: true })]);
    expect(isVisible(c, c.layers[0])).toBe(false);
    expect(isLocked(c, c.layers[0])).toBe(true);
    expect(isVisible(c, c.layers[1])).toBe(true);
  });
});
