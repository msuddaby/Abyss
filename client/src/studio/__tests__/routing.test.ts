import { describe, expect, it } from 'vitest';
import type { StudioDoc, StudioTrack } from '@abyss/shared';
import { resolveOutput, audibleUnderSolo, isReturnOnlySolo, isSidechainCycle, displayOrder, ancestors, clipPlayback } from '../engine/routing';
import { buildTempoMap } from '@abyss/shared';
import { nearestInScale, projectScale } from '../scales';

const t = (kind: StudioTrack['kind'], extra: Partial<StudioTrack> = {}): StudioTrack =>
  ({ name: kind, kind, order: 0, volume: 0, pan: 0, mute: false, solo: false, ...extra });

const mk = (tracks: Record<string, StudioTrack>): StudioDoc => ({
  meta: { bpm: 120, timeSigNum: 4, timeSigDen: 4, loopEnabled: false, loopStart: 0, loopEnd: 16 },
  tracks, clips: {},
});

describe('routing', () => {
  it('routes into groups and falls back to master on bad targets and cycles', () => {
    const d = mk({
      kick: t('audio', { output: 'drums' }), drums: t('group', { output: 'all' }), all: t('group'),
      lost: t('audio', { output: 'nope' }), toAudio: t('audio', { output: 'kick' }),
      g1: t('group', { output: 'g2' }), g2: t('group', { output: 'g1' }),
    });
    expect(resolveOutput(d, 'kick')).toBe('drums');
    expect(ancestors(d, 'kick')).toEqual(['drums', 'all']);
    expect(resolveOutput(d, 'lost')).toBe('');
    expect(resolveOutput(d, 'toAudio')).toBe('');
    expect(resolveOutput(d, 'g1')).toBe('');
    expect(resolveOutput(d, 'g2')).toBe('');
  });

  it('solo keeps the groups a track plays through, a soloed group\'s children, and returns', () => {
    const d = mk({
      kick: t('audio', { output: 'drums', solo: true }), snare: t('audio', { output: 'drums' }), drums: t('group'),
      bass: t('instrument'), verb: t('return'),
    });
    expect([...audibleUnderSolo(d)].sort()).toEqual(['drums', 'kick', 'verb']);
    d.tracks.kick.solo = false;
    d.tracks.drums.solo = true;
    expect([...audibleUnderSolo(d)].sort()).toEqual(['drums', 'kick', 'snare', 'verb']);
  });

  it('nests children under groups, hides folded ones, puts returns last', () => {
    const d = mk({ ret: t('return'), g: t('group', { collapsed: true }), a: t('audio', { output: 'g' }), b: t('audio') });
    const rows = displayOrder(d, ['ret', 'g', 'a', 'b']);
    expect(rows.map((r) => [r.id, r.depth, r.hidden])).toEqual([['g', 0, false], ['a', 1, true], ['b', 0, false], ['ret', 0, false]]);
  });

  it('computes clip playback rates', () => {
    const map = buildTempoMap({ meta: { bpm: 120, timeSigNum: 4, timeSigDen: 4, loopEnabled: false, loopStart: 0, loopEnd: 16 } });
    const clip = { trackId: 'a', kind: 'audio' as const, start: 0, length: 8, gain: 0 };
    expect(clipPlayback(clip, map)).toEqual({ warp: false, rate: 1, timelineSec: 4 });
    expect(clipPlayback({ ...clip, pitch: 12 }, map).rate).toBeCloseTo(2);
    expect(clipPlayback({ ...clip, warp: true, srcBpm: 90 }, map).rate).toBeCloseTo(120 / 90);
  });

  it('detects return-only solo and sidechain cycles', () => {
    const d = mk({
      kick: t('audio', { output: 'drums', sends: { verb: -6 } }),
      drums: t('group'),
      verb: t('return', { solo: true }),
      delay: t('return'),
    });
    expect(isReturnOnlySolo(d)).toBe(true);
    expect([...audibleUnderSolo(d)]).toEqual(['verb']);
    // Sidechain cycle checks: self, ancestor group, return fed by track, deleted track
    expect(isSidechainCycle(d, 'kick', 'kick')).toBe(true);
    expect(isSidechainCycle(d, 'kick', 'drums')).toBe(true);
    expect(isSidechainCycle(d, 'kick', 'verb')).toBe(true);
    expect(isSidechainCycle(d, 'kick', 'delay')).toBe(false);
    expect(isSidechainCycle(d, 'kick', 'deleted')).toBe(true);
    expect(isSidechainCycle(d, '', 'kick')).toBe(false);
  });

  it('keeps nearestInScale within MIDI 0..127 bounds', () => {
    const dMaj = projectScale({ bpm: 120, timeSigNum: 4, timeSigDen: 4, loopEnabled: false, loopStart: 0, loopEnd: 16, scaleRoot: 2, scaleMode: 'major' })!;
    const fMinPent = projectScale({ bpm: 120, timeSigNum: 4, timeSigDen: 4, loopEnabled: false, loopStart: 0, loopEnd: 16, scaleRoot: 5, scaleMode: 'minorPentatonic' })!;
    expect(nearestInScale(dMaj, 0)).toBeGreaterThanOrEqual(0);
    expect(nearestInScale(fMinPent, 127)).toBeLessThanOrEqual(127);
  });
});
