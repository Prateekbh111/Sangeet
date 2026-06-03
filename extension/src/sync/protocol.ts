// Wire protocol for BeatSync over RTCDataChannel. JSON-encoded.

export type Role = 'leader' | 'follower';

export interface Ping {
  t: 'PING';
  id: string;
  t1: number; // sender wall time (ms)
}

export interface Pong {
  t: 'PONG';
  id: string;
  t1: number; // echoed
  t2: number; // responder recv time
  t3: number; // responder send time
}

export interface State {
  t: 'STATE';
  videoId: string;
  position: number;          // seconds
  paused: boolean;
  volume: number;            // 0..1
  scheduledWallTime: number; // leader wall clock ms when action should take effect
  seq: number;
}

export type RequestAction = 'play' | 'pause' | 'next' | 'prev' | 'seek' | 'volume';

export interface PeerRequest {
  t: 'REQUEST';
  action: RequestAction;
  payload?: unknown;
  from: string;
}

export interface Hello {
  t: 'HELLO';
  peerId: string;
  role: Role;
  name?: string;
}

export type Msg = Ping | Pong | State | PeerRequest | Hello;

export function encode(m: Msg): string {
  return JSON.stringify(m);
}

export function decode(s: string): Msg | null {
  let parsed: unknown;
  try { parsed = JSON.parse(s); } catch { return null; }
  if (!isObj(parsed)) return null;
  const t = (parsed as { t?: unknown }).t;
  switch (t) {
    case 'PING':    return isPing(parsed)    ? (parsed as unknown as Ping)    : null;
    case 'PONG':    return isPong(parsed)    ? (parsed as unknown as Pong)    : null;
    case 'STATE':   return isState(parsed)   ? (parsed as unknown as State)   : null;
    case 'REQUEST': return isRequest(parsed) ? (parsed as unknown as PeerRequest) : null;
    case 'HELLO':   return isHello(parsed)   ? (parsed as unknown as Hello)   : null;
    default: return null;
  }
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null;
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isBool = (x: unknown): x is boolean => typeof x === 'boolean';

function isPing(x: Record<string, unknown>): boolean {
  return isStr(x.id) && isNum(x.t1);
}
function isPong(x: Record<string, unknown>): boolean {
  return isStr(x.id) && isNum(x.t1) && isNum(x.t2) && isNum(x.t3);
}
function isState(x: Record<string, unknown>): boolean {
  return isStr(x.videoId) && isNum(x.position) && isBool(x.paused)
      && isNum(x.volume) && isNum(x.scheduledWallTime) && isNum(x.seq);
}
function isRequest(x: Record<string, unknown>): boolean {
  const allowed: RequestAction[] = ['play','pause','next','prev','seek','volume'];
  return isStr(x.from) && typeof x.action === 'string'
      && (allowed as string[]).includes(x.action as string);
}
function isHello(x: Record<string, unknown>): boolean {
  return isStr(x.peerId) && (x.role === 'leader' || x.role === 'follower');
}

// Internal messages between content script and service worker (chrome.runtime).
export type RuntimeMsg =
  | { kind: 'localState'; videoId: string; position: number; paused: boolean; volume: number }
  | { kind: 'applyState'; state: State; expectedLocalStart: number; clockOffset: number }
  | { kind: 'navigate'; videoId: string }
  | { kind: 'queryMedia' }
  | { kind: 'mediaSnapshot'; videoId: string | null; position: number; paused: boolean; volume: number; ready: boolean }
  | { kind: 'driftReport'; drift: number }
  | { kind: 'doAction'; action: 'play' | 'pause' | 'seek' | 'volume' | 'next' | 'prev'; payload?: unknown };
