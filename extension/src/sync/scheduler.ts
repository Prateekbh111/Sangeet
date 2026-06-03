// Pure scheduling math for BeatSync drift correction.
// clockOffset = peerClock - localClock, so localWall = peerWall - clockOffset.

import type { State } from './protocol';

export interface Action {
  kind: 'seek' | 'rate' | 'none';
  value?: number;
}

export function expectedPosition(
  state: State,
  stateReceivedLocal: number,
  nowLocal: number,
  _clockOffset: number,
): number {
  if (state.paused) return state.position;
  const elapsedMs = nowLocal - stateReceivedLocal;
  return state.position + elapsedMs / 1000;
}

export function decideAction(drift: number): Action {
  const abs = Math.abs(drift);
  if (abs > 0.5) return { kind: 'seek', value: 0 };
  if (abs <= 0.08) return { kind: 'none' };
  // 0.08 < |drift| <= 0.5
  if (drift > 0) return { kind: 'rate', value: 0.98 };
  return { kind: 'rate', value: 1.02 };
}

export function leaderToLocalWall(leaderWall: number, clockOffset: number): number {
  return leaderWall - clockOffset;
}

export function localStartTime(state: State, clockOffset: number): number {
  return leaderToLocalWall(state.scheduledWallTime, clockOffset);
}
