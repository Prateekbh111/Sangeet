// BeatSync offscreen document.
// MV3 service workers can't use RTCPeerConnection, so all WebRTC + signaling
// live here. Talks to the service worker via chrome.runtime.

import { Clock } from './sync/clock';
import {
  decode,
  encode,
  type Msg,
  type State,
} from './sync/protocol';
import { localStartTime } from './sync/scheduler';

type Role = 'leader' | 'follower';

interface PeerCtx {
  remoteId: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  clock: Clock;
  pingTimer: number | null;
  initiator: boolean;
}

interface Session {
  role: Role;
  selfId: string;
  peers: Map<string, PeerCtx>; // keyed by remoteId
  leaderSeq: number;
  ws: WebSocket | null;
  wsUrl: string | null;
  room: string | null;
  wsState: 'idle' | 'connecting' | 'open' | 'closed' | 'error';
  wsError: string | null;
  reconnectAttempt: number;
  reconnectTimer: number | null;
  wantConnected: boolean;
  heartbeatTimer: number | null;
  leaderPeerId: string | null;
  members: { peerId: string; role: Role }[];
  // On leader only: peerId of any pending host-transfer request, or null.
  pendingHostRequestFrom: string | null;
  // On follower only: peerId of leader who just denied our request, until popup acks.
  hostDeniedBy: string | null;
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

const session: Session = {
  role: 'follower', // server assigns the real role on JOIN
  selfId: crypto.randomUUID(),
  peers: new Map(),
  leaderSeq: 0,
  ws: null,
  wsUrl: null,
  room: null,
  wsState: 'idle',
  wsError: null,
  reconnectAttempt: 0,
  reconnectTimer: null,
  wantConnected: false,
  heartbeatTimer: null,
  leaderPeerId: null,
  members: [],
  pendingHostRequestFrom: null,
  hostDeniedBy: null,
};

console.log('[beatsync/offscreen] loaded selfId=', session.selfId);

// ---------- signaling ----------

interface SigJoined { t: 'JOINED'; peers: string[] }
interface SigPeerJoined { t: 'PEER_JOINED'; peerId: string }
interface SigPeerLeft { t: 'PEER_LEFT'; peerId: string }
interface SigSignal { t: 'SIGNAL'; from: string; payload: SignalPayload }
interface SigRoleAssign { t: 'ROLE_ASSIGN'; role: Role; leaderPeerId: string; members: { peerId: string; role: Role }[] }
interface SigHostRequest { t: 'HOST_REQUEST'; from: string }
interface SigHostDenied { t: 'HOST_DENIED'; from: string }
type SigMsg = SigJoined | SigPeerJoined | SigPeerLeft | SigSignal | SigRoleAssign | SigHostRequest | SigHostDenied;

type SignalPayload =
  | { kind: 'offer'; sdp: RTCSessionDescriptionInit }
  | { kind: 'answer'; sdp: RTCSessionDescriptionInit }
  | { kind: 'ice'; candidate: RTCIceCandidateInit | null };

function wsSend(obj: unknown): void {
  const ws = session.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function signal(to: string, payload: SignalPayload): void {
  wsSend({ t: 'SIGNAL', to, payload });
}

function disconnectWs(): void {
  session.wantConnected = false;
  if (session.reconnectTimer !== null) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
  if (session.ws) {
    try { session.ws.close(); } catch { /* ignore */ }
  }
  session.ws = null;
  session.wsState = 'closed';
  session.leaderPeerId = null;
  session.members = [];
  session.pendingHostRequestFrom = null;
  session.hostDeniedBy = null;
  // Tear down any peers — they're tied to this session.
  for (const id of [...session.peers.keys()]) teardownPeer(id);
}

function scheduleReconnect(): void {
  if (!session.wantConnected) return;
  if (session.reconnectTimer !== null) return;
  const attempt = ++session.reconnectAttempt;
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5));
  console.log(`[beatsync/offscreen] reconnect in ${delay}ms (attempt ${attempt})`);
  session.reconnectTimer = window.setTimeout(() => {
    session.reconnectTimer = null;
    if (session.wantConnected && session.wsUrl && session.room) {
      openWs(session.wsUrl, session.room);
    }
  }, delay);
}

function openWs(url: string, room: string): void {
  session.wsState = 'connecting';
  session.wsError = null;
  let ws: WebSocket;
  try { ws = new WebSocket(url); }
  catch (e) {
    session.wsState = 'error';
    session.wsError = String(e);
    scheduleReconnect();
    return;
  }
  session.ws = ws;

  ws.addEventListener('open', () => {
    session.wsState = 'open';
    session.wsError = null;
    session.reconnectAttempt = 0;
    console.log('[beatsync/offscreen] ws open', url);
    wsSend({ t: 'JOIN', room, peerId: session.selfId });
  });
  ws.addEventListener('close', () => {
    session.wsState = 'closed';
    session.ws = null;
    console.log('[beatsync/offscreen] ws closed');
    scheduleReconnect();
  });
  ws.addEventListener('error', () => {
    session.wsState = 'error';
    session.wsError = `cannot reach ${url} — is the signaling server running?`;
    console.warn('[beatsync/offscreen] ws error', url, 'readyState=', ws.readyState);
  });
  ws.addEventListener('message', (ev: MessageEvent) => {
    if (typeof ev.data !== 'string') return;
    let m: SigMsg;
    try { m = JSON.parse(ev.data) as SigMsg; } catch { return; }
    handleSig(m);
  });
}

function connectRoom(url: string, room: string): void {
  // Tear down existing session but keep wantConnected for reconnects after open.
  if (session.ws) {
    try { session.ws.close(); } catch { /* ignore */ }
  }
  if (session.reconnectTimer !== null) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
  for (const id of [...session.peers.keys()]) teardownPeer(id);
  session.wsUrl = url;
  session.room = room;
  session.wantConnected = true;
  session.reconnectAttempt = 0;
  openWs(url, room);
}

function handleSig(m: SigMsg): void {
  switch (m.t) {
    case 'JOINED': {
      console.log('[beatsync/offscreen] joined; existing peers:', m.peers);
      // We are the newcomer; initiate to each existing peer.
      for (const remoteId of m.peers) initiate(remoteId);
      return;
    }
    case 'PEER_JOINED': {
      console.log('[beatsync/offscreen] peer joined:', m.peerId);
      // Existing peer waits for offer from newcomer — do nothing here.
      return;
    }
    case 'PEER_LEFT': {
      console.log('[beatsync/offscreen] peer left:', m.peerId);
      teardownPeer(m.peerId);
      // If the leaver was the one requesting host, drop the request.
      if (session.pendingHostRequestFrom === m.peerId) {
        session.pendingHostRequestFrom = null;
      }
      return;
    }
    case 'SIGNAL': {
      handleSignalPayload(m.from, m.payload);
      return;
    }
    case 'ROLE_ASSIGN': {
      const prevRole = session.role;
      session.role = m.role;
      session.leaderPeerId = m.leaderPeerId;
      session.members = m.members;
      console.log('[beatsync/offscreen] role assigned:', m.role, 'leader=', m.leaderPeerId);
      // If we just became leader (e.g. previous leader left), push current
      // playback state to all open peers so followers stay in sync seamlessly.
      if (m.role === 'leader' && prevRole !== 'leader') {
        for (const peer of session.peers.values()) {
          if (peer.dc?.readyState === 'open') void sendStateToPeer(peer);
        }
        ensureHeartbeat();
      }
      // If we lost leader, clear any pending request panel.
      if (m.role !== 'leader') {
        session.pendingHostRequestFrom = null;
      }
      return;
    }
    case 'HOST_REQUEST': {
      // Only meaningful if we are leader.
      if (session.role !== 'leader') return;
      session.pendingHostRequestFrom = m.from;
      console.log('[beatsync/offscreen] HOST_REQUEST from', m.from);
      return;
    }
    case 'HOST_DENIED': {
      session.hostDeniedBy = m.from;
      console.log('[beatsync/offscreen] HOST_DENIED by', m.from);
      return;
    }
  }
}

async function initiate(remoteId: string): Promise<void> {
  if (session.peers.has(remoteId)) return;
  const peer = makePeer(remoteId, true);
  const dc = peer.pc.createDataChannel('beatsync');
  attachDataChannel(peer, dc);
  const offer = await peer.pc.createOffer();
  await peer.pc.setLocalDescription(offer);
  signal(remoteId, { kind: 'offer', sdp: offer });
}

async function handleSignalPayload(from: string, payload: SignalPayload): Promise<void> {
  if (payload.kind === 'offer') {
    // A fresh offer for an existing peer = remote restarted. Tear down + recreate.
    if (session.peers.has(from)) teardownPeer(from);
    const peer = makePeer(from, false);
    await peer.pc.setRemoteDescription(payload.sdp);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    signal(from, { kind: 'answer', sdp: answer });
  } else if (payload.kind === 'answer') {
    const peer = session.peers.get(from);
    if (!peer) return;
    if (peer.pc.signalingState === 'stable') return;
    await peer.pc.setRemoteDescription(payload.sdp);
  } else if (payload.kind === 'ice') {
    const peer = session.peers.get(from);
    if (!peer) return;
    if (!payload.candidate) return;
    try { await peer.pc.addIceCandidate(payload.candidate); }
    catch (e) { console.warn('[beatsync/offscreen] addIceCandidate failed', e); }
  }
}

// ---------- peer / WebRTC ----------

function makePeer(remoteId: string, initiator: boolean): PeerCtx {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const peer: PeerCtx = {
    remoteId,
    pc,
    dc: null,
    clock: new Clock(),
    pingTimer: null,
    initiator,
  };
  pc.addEventListener('icecandidate', (ev: RTCPeerConnectionIceEvent) => {
    signal(remoteId, { kind: 'ice', candidate: ev.candidate?.toJSON() ?? null });
  });
  pc.addEventListener('iceconnectionstatechange', () => {
    console.log(`[beatsync/offscreen] peer ${remoteId} ice=`, pc.iceConnectionState);
  });
  pc.addEventListener('connectionstatechange', () => {
    console.log(`[beatsync/offscreen] peer ${remoteId} conn=`, pc.connectionState);
    const s = pc.connectionState;
    if (s === 'failed' || s === 'closed' || s === 'disconnected') {
      const wasInitiator = peer.initiator;
      teardownPeer(remoteId);
      // Re-initiate after short delay if we were the initiator and signaling still up.
      // The other side will accept the new offer and replace its peer.
      if (wasInitiator && session.wsState === 'open' && session.wantConnected) {
        window.setTimeout(() => {
          if (!session.peers.has(remoteId) && session.wsState === 'open') {
            console.log(`[beatsync/offscreen] re-initiating peer ${remoteId}`);
            void initiate(remoteId);
          }
        }, 1500);
      }
    }
  });
  pc.addEventListener('datachannel', (ev: RTCDataChannelEvent) => {
    attachDataChannel(peer, ev.channel);
  });
  session.peers.set(remoteId, peer);
  return peer;
}

function teardownPeer(remoteId: string): void {
  const peer = session.peers.get(remoteId);
  if (!peer) return;
  if (peer.pingTimer !== null) clearInterval(peer.pingTimer);
  peer.pingTimer = null;
  try { peer.dc?.close(); } catch { /* ignore */ }
  try { peer.pc.close(); } catch { /* ignore */ }
  session.peers.delete(remoteId);
}

function attachDataChannel(peer: PeerCtx, dc: RTCDataChannel): void {
  peer.dc = dc;
  dc.addEventListener('open', () => {
    console.log(`[beatsync/offscreen] dc open peer=${peer.remoteId}`);
    sendMsg(peer, { t: 'HELLO', peerId: session.selfId, role: session.role });
    if (peer.pingTimer !== null) clearInterval(peer.pingTimer);
    peer.pingTimer = window.setInterval(() => {
      if (dc.readyState !== 'open') return;
      sendMsg(peer, { t: 'PING', id: crypto.randomUUID(), t1: Date.now() });
    }, 2000);
    // Leader: push current state to the freshly-connected follower.
    if (session.role === 'leader') void sendStateToPeer(peer);
    ensureHeartbeat();
  });
  dc.addEventListener('close', () => {
    console.log(`[beatsync/offscreen] dc close peer=${peer.remoteId}`);
    if (peer.pingTimer !== null) clearInterval(peer.pingTimer);
    peer.pingTimer = null;
  });
  dc.addEventListener('message', (ev: MessageEvent) => {
    if (typeof ev.data !== 'string') return;
    const msg = decode(ev.data);
    if (msg === null) return;
    handleWireMsg(peer, msg);
  });
}

function sendMsg(peer: PeerCtx, msg: Msg): void {
  const dc = peer.dc;
  if (dc === null || dc.readyState !== 'open') return;
  try { dc.send(encode(msg)); }
  catch (e) { console.warn('[beatsync/offscreen] send failed', e); }
}

function handleWireMsg(peer: PeerCtx, msg: Msg): void {
  switch (msg.t) {
    case 'PING': {
      const recvTime = Date.now();
      sendMsg(peer, { t: 'PONG', id: msg.id, t1: msg.t1, t2: recvTime, t3: Date.now() });
      return;
    }
    case 'PONG': {
      peer.clock.addSample(msg.t1, msg.t2, msg.t3, Date.now());
      return;
    }
    case 'STATE': {
      if (session.role !== 'follower') return;
      const offset = peer.clock.offset();
      const expectedLocalStart = localStartTime(msg, offset);
      chrome.runtime.sendMessage({
        kind: '_route:applyState',
        state: msg,
        expectedLocalStart,
        clockOffset: offset,
      }).catch(() => { /* no listener — ignore */ });
      return;
    }
    case 'REQUEST': {
      if (session.role !== 'leader') return;
      console.log(`[beatsync/offscreen] REQUEST ${msg.from}: ${msg.action}`, msg.payload);
      // Honor request by applying action on leader's local tab; the resulting
      // localState event will broadcast a fresh STATE to everyone.
      chrome.runtime.sendMessage({
        kind: '_route:doAction',
        action: msg.action,
        payload: msg.payload,
      }).catch(() => { /* ignore */ });
      return;
    }
    case 'HELLO': {
      console.log(`[beatsync/offscreen] HELLO peer=${peer.remoteId} role=${msg.role}`);
      return;
    }
  }
}

function maxPeerHalfRtt(): number {
  let best = 80;
  for (const peer of session.peers.values()) {
    if (peer.dc?.readyState !== 'open') continue;
    const rtt = peer.clock.rtt();
    if (!Number.isFinite(rtt)) continue;
    const half = rtt / 2;
    if (half > best) best = half;
  }
  return best;
}

function broadcastState(videoId: string, position: number, paused: boolean, volume: number): void {
  if (session.role !== 'leader') return;
  const seq = ++session.leaderSeq;
  const scheduledWallTime = Date.now() + maxPeerHalfRtt() + 150;
  const state: State = { t: 'STATE', videoId, position, paused, volume, scheduledWallTime, seq };
  for (const peer of session.peers.values()) {
    if (peer.dc?.readyState !== 'open') continue;
    sendMsg(peer, state);
  }
}

interface MediaSnapshot {
  kind: 'mediaSnapshot';
  videoId: string | null;
  position: number;
  paused: boolean;
  volume: number;
  ready: boolean;
}

async function fetchLeaderSnapshot(): Promise<MediaSnapshot | null> {
  try {
    const resp = await chrome.runtime.sendMessage({ kind: '_route:queryMedia' });
    if (resp && typeof resp === 'object' && (resp as { kind?: string }).kind === 'mediaSnapshot') {
      return resp as MediaSnapshot;
    }
  } catch { /* no listener */ }
  return null;
}

async function sendStateToPeer(peer: PeerCtx): Promise<void> {
  const snap = await fetchLeaderSnapshot();
  if (!snap || !snap.ready || !snap.videoId) return;
  const seq = ++session.leaderSeq;
  const scheduledWallTime = Date.now() + Math.max(80, peer.clock.rtt() / 2 || 80) + 150;
  const state: State = {
    t: 'STATE',
    videoId: snap.videoId,
    position: snap.position,
    paused: snap.paused,
    volume: snap.volume,
    scheduledWallTime,
    seq,
  };
  sendMsg(peer, state);
}

async function heartbeatBroadcast(): Promise<void> {
  if (session.role !== 'leader') return;
  // Skip if no open peers.
  let anyOpen = false;
  for (const p of session.peers.values()) {
    if (p.dc?.readyState === 'open') { anyOpen = true; break; }
  }
  if (!anyOpen) return;
  const snap = await fetchLeaderSnapshot();
  if (!snap || !snap.ready || !snap.videoId) return;
  broadcastState(snap.videoId, snap.position, snap.paused, snap.volume);
}

function ensureHeartbeat(): void {
  if (session.heartbeatTimer !== null) return;
  session.heartbeatTimer = window.setInterval(() => {
    void heartbeatBroadcast();
  }, 5000);
}

// ---------- runtime API ----------

interface PeerStatus { peerId: string; rtt: number; drift: number; state: string; role: Role }
interface StatusResponse {
  role: Role;
  selfId: string;
  room: string | null;
  wsState: string;
  wsError: string | null;
  wsUrl: string | null;
  leaderPeerId: string | null;
  peers: PeerStatus[];
  pendingHostRequestFrom: string | null;
  hostDeniedBy: string | null;
}

type OffscreenMsg =
  | { kind: 'getStatus' }
  | { kind: 'connectRoom'; url: string; room: string }
  | { kind: 'disconnect' }
  | { kind: 'requestHost' }
  | { kind: 'grantHost'; to: string }
  | { kind: 'denyHost'; to: string }
  | { kind: 'ackDenied' }
  | { kind: 'localState'; videoId: string; position: number; paused: boolean; volume: number }
  | { kind: 'driftReport'; drift: number };

function isOffscreenMsg(x: unknown): x is OffscreenMsg {
  if (typeof x !== 'object' || x === null) return false;
  if ((x as { target?: unknown }).target !== 'offscreen') return false;
  const k = (x as { kind?: unknown }).kind;
  return (
    k === 'getStatus' ||
    k === 'connectRoom' || k === 'disconnect' ||
    k === 'requestHost' || k === 'grantHost' || k === 'denyHost' || k === 'ackDenied' ||
    k === 'localState' || k === 'driftReport'
  );
}

function statusSnapshot(): StatusResponse {
  const peers: PeerStatus[] = [];
  for (const peer of session.peers.values()) {
    const rtt = peer.clock.rtt();
    const pcState = peer.pc.connectionState;
    const dcState = peer.dc?.readyState ?? 'no-dc';
    const label =
      dcState === 'open' ? 'open' :
      pcState === 'connected' ? 'connecting-dc' :
      pcState === 'new' || pcState === 'connecting' ? 'connecting' :
      pcState;
    const role: Role = peer.remoteId === session.leaderPeerId ? 'leader' : 'follower';
    peers.push({
      peerId: peer.remoteId,
      rtt: Number.isFinite(rtt) ? rtt : 0,
      drift: 0,
      state: label,
      role,
    });
  }
  return {
    role: session.role,
    selfId: session.selfId,
    room: session.room,
    wsState: session.wsState,
    wsError: session.wsError,
    wsUrl: session.wsUrl,
    leaderPeerId: session.leaderPeerId,
    peers,
    pendingHostRequestFrom: session.pendingHostRequestFrom,
    hostDeniedBy: session.hostDeniedBy,
  };
}

async function handle(msg: OffscreenMsg): Promise<unknown> {
  switch (msg.kind) {
    case 'getStatus':
      return statusSnapshot();
    case 'connectRoom':
      connectRoom(msg.url, msg.room);
      return { ok: true };
    case 'disconnect':
      disconnectWs();
      return { ok: true };
    case 'requestHost':
      wsSend({ t: 'REQUEST_HOST' });
      return { ok: true };
    case 'grantHost':
      wsSend({ t: 'GRANT_HOST', to: msg.to });
      session.pendingHostRequestFrom = null;
      return { ok: true };
    case 'denyHost':
      wsSend({ t: 'DENY_HOST', to: msg.to });
      session.pendingHostRequestFrom = null;
      return { ok: true };
    case 'ackDenied':
      session.hostDeniedBy = null;
      return { ok: true };
    case 'localState': {
      broadcastState(msg.videoId, msg.position, msg.paused, msg.volume);
      return { ok: true };
    }
    case 'driftReport': {
      console.log('[beatsync/offscreen] drift', msg.drift);
      return { ok: true };
    }
  }
}

chrome.runtime.onMessage.addListener(
  (rawMsg: unknown, _sender, sendResponse): boolean => {
    if (!isOffscreenMsg(rawMsg)) return false;
    handle(rawMsg)
      .then((result) => sendResponse(result))
      .catch((err: unknown) => {
        console.error('[beatsync/offscreen] handler error', err);
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  },
);
