import { describe, it, expect } from 'vitest';
import {
  expectedPosition,
  decideAction,
  localStartTime,
  leaderToLocalWall,
} from '../src/sync/scheduler';
import type { State } from '../src/sync/protocol';

function makeState(partial: Partial<State> = {}): State {
  return {
    t: 'STATE',
    videoId: 'abc',
    position: 10,
    paused: false,
    volume: 1,
    scheduledWallTime: 0,
    seq: 1,
    ...partial,
  };
}

describe('expectedPosition', () => {
  it('paused state returns position unchanged regardless of elapsed', () => {
    const s = makeState({ paused: true, position: 42 });
    expect(expectedPosition(s, 1000, 5000, 0)).toBe(42);
  });

  it('playing state advances by elapsed seconds', () => {
    const s = makeState({ paused: false, position: 10 });
    const got = expectedPosition(s, 1000, 2000, 0);
    expect(Math.abs(got - 11)).toBeLessThan(1e-6);
  });
});

describe('decideAction', () => {
  it('drift 0 -> none', () => {
    expect(decideAction(0).kind).toBe('none');
  });
  it('drift 0.05 -> none', () => {
    expect(decideAction(0.05).kind).toBe('none');
  });
  it('drift 0.1 -> rate 0.98', () => {
    const a = decideAction(0.1);
    expect(a.kind).toBe('rate');
    expect(a.value).toBe(0.98);
  });
  it('drift -0.1 -> rate 1.02', () => {
    const a = decideAction(-0.1);
    expect(a.kind).toBe('rate');
    expect(a.value).toBe(1.02);
  });
  it('drift 0.6 -> seek', () => {
    expect(decideAction(0.6).kind).toBe('seek');
  });
  it('drift -0.6 -> seek', () => {
    expect(decideAction(-0.6).kind).toBe('seek');
  });
});

describe('wall conversion', () => {
  it('localStartTime: 10000 with offset 200 -> 9800', () => {
    const s = makeState({ scheduledWallTime: 10000 });
    expect(localStartTime(s, 200)).toBe(9800);
  });
  it('leaderToLocalWall subtracts offset', () => {
    expect(leaderToLocalWall(5000, -50)).toBe(5050);
  });
});
