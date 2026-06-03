// BeatSync popup UI. Role assigned by server (first peer in room = leader).

interface PeerStatus {
  peerId: string;
  rtt?: number;
  drift?: number;
  state?: string;
  role?: 'leader' | 'follower';
}

interface StatusResponse {
  role?: 'leader' | 'follower';
  selfId?: string;
  room?: string | null;
  wsState?: 'idle' | 'connecting' | 'open' | 'closed' | 'error';
  wsError?: string | null;
  wsUrl?: string | null;
  leaderPeerId?: string | null;
  peers?: PeerStatus[];
  pendingHostRequestFrom?: string | null;
  hostDeniedBy?: string | null;
}

const STORE = 'beatsync:popup';
const DEFAULT_URL = 'ws://localhost:8787';
const DEFAULT_ROOM = 'room1';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error('missing #' + id);
  return el as T;
};

const serverIn = $<HTMLInputElement>('server');
const roomIn = $<HTMLInputElement>('room');
const connectBtn = $<HTMLButtonElement>('connect');
const disconnectBtn = $<HTMLButtonElement>('disconnect');
const statusDot = $<HTMLSpanElement>('statusDot');
const statusText = $<HTMLSpanElement>('statusText');
const peersEl = $<HTMLDivElement>('peers');
const roleBadge = $<HTMLSpanElement>('roleBadge');
const requestHostBtn = $<HTMLButtonElement>('requestHost');
const hostRequestPanel = $<HTMLDivElement>('hostRequestPanel');
const hostReqFromEl = $<HTMLSpanElement>('hostReqFrom');
const approveHostBtn = $<HTMLButtonElement>('approveHost');
const denyHostBtn = $<HTMLButtonElement>('denyHost');
const hostDeniedPanel = $<HTMLDivElement>('hostDeniedPanel');
const dismissDeniedBtn = $<HTMLButtonElement>('dismissDenied');

let lastStatus: StatusResponse = {};

async function send<T = unknown>(payload: unknown): Promise<T> {
  return (await chrome.runtime.sendMessage(payload)) as T;
}

function loadPrefs(): void {
  try {
    const raw = localStorage.getItem(STORE);
    const prev = raw ? JSON.parse(raw) as { url?: string; room?: string } : {};
    serverIn.value = prev.url ?? DEFAULT_URL;
    roomIn.value = prev.room ?? DEFAULT_ROOM;
  } catch {
    serverIn.value = DEFAULT_URL;
    roomIn.value = DEFAULT_ROOM;
  }
}

function savePrefs(): void {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      url: serverIn.value, room: roomIn.value,
    }));
  } catch { /* ignore */ }
}

function setStatus(state: string, text: string): void {
  statusDot.className = 'status-dot';
  statusText.className = 'status-text';
  if (state === 'open') { statusDot.classList.add('open'); statusText.classList.add('open'); }
  else if (state === 'connecting') statusDot.classList.add('connecting');
  else if (state === 'error') { statusDot.classList.add('error'); statusText.classList.add('error'); }
  statusText.textContent = text;
}

function setRoleBadge(connected: boolean, role?: 'leader' | 'follower'): void {
  roleBadge.className = 'badge dot';
  if (!connected || !role) {
    roleBadge.textContent = 'offline';
    return;
  }
  roleBadge.classList.add(role);
  roleBadge.textContent = role === 'leader' ? 'leader' : 'follower';
}

function renderPeers(peers: PeerStatus[]): void {
  peersEl.innerHTML = '';
  if (peers.length === 0) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = 'No peers';
    peersEl.appendChild(div);
    return;
  }
  for (const p of peers) {
    const row = document.createElement('div');
    row.className = 'peer';
    const rtt = p.rtt !== undefined && Number.isFinite(p.rtt) && p.rtt > 0
      ? `${Math.round(p.rtt)}ms` : '–';
    const short = p.peerId ? p.peerId.slice(0, 8) : '?';
    const role = p.role ?? 'follower';
    const state = p.state ?? '–';
    row.innerHTML = `
      <span class="role ${role}">${role}</span>
      <span class="pid">${short}</span>
      <span class="meta">${state} · ${rtt}</span>
    `;
    peersEl.appendChild(row);
  }
}

function renderHostUi(status: StatusResponse): void {
  const isLeader = status.role === 'leader';
  const isFollower = status.role === 'follower';
  const hasPeers = (status.peers ?? []).length > 0;
  const wsOpen = status.wsState === 'open';

  // Followers see "request to become host" only when actually connected to peers.
  if (isFollower && wsOpen && hasPeers && status.leaderPeerId) {
    requestHostBtn.classList.remove('hide');
  } else {
    requestHostBtn.classList.add('hide');
  }

  // Leader sees pending request panel.
  if (isLeader && status.pendingHostRequestFrom) {
    hostRequestPanel.classList.remove('hide');
    hostReqFromEl.textContent = status.pendingHostRequestFrom.slice(0, 8);
  } else {
    hostRequestPanel.classList.add('hide');
  }

  // Anyone sees "denied" panel until they dismiss.
  if (status.hostDeniedBy) {
    hostDeniedPanel.classList.remove('hide');
  } else {
    hostDeniedPanel.classList.add('hide');
  }
}

async function refreshStatus(): Promise<void> {
  try {
    const status = await send<StatusResponse>({ kind: 'getStatus' });
    lastStatus = status ?? {};
    const state = status?.wsState ?? 'idle';
    let text: string;
    switch (state) {
      case 'open':       text = `connected · room=${status?.room ?? ''}`; break;
      case 'connecting': text = 'connecting…'; break;
      case 'closed':     text = 'disconnected'; break;
      case 'error':      text = status?.wsError ?? 'error'; break;
      default:           text = 'idle';
    }
    setStatus(state, text);
    setRoleBadge(state === 'open', status?.role);
    renderPeers(status?.peers ?? []);
    renderHostUi(status ?? {});
  } catch {
    /* bg not ready yet */
  }
}

connectBtn.addEventListener('click', async () => {
  const url = serverIn.value.trim() || DEFAULT_URL;
  const room = roomIn.value.trim();
  if (!room) {
    setStatus('error', 'enter a room code');
    return;
  }
  savePrefs();
  await send({ kind: 'connectRoom', url, room });
  void refreshStatus();
});

disconnectBtn.addEventListener('click', async () => {
  await send({ kind: 'disconnect' });
  void refreshStatus();
});

requestHostBtn.addEventListener('click', async () => {
  await send({ kind: 'requestHost' });
  // Visual feedback
  requestHostBtn.textContent = 'Request sent…';
  requestHostBtn.disabled = true;
  setTimeout(() => {
    requestHostBtn.textContent = 'Request to become host';
    requestHostBtn.disabled = false;
  }, 3000);
});

approveHostBtn.addEventListener('click', async () => {
  const to = lastStatus.pendingHostRequestFrom;
  if (!to) return;
  await send({ kind: 'grantHost', to });
  void refreshStatus();
});

denyHostBtn.addEventListener('click', async () => {
  const to = lastStatus.pendingHostRequestFrom;
  if (!to) return;
  await send({ kind: 'denyHost', to });
  void refreshStatus();
});

dismissDeniedBtn.addEventListener('click', async () => {
  await send({ kind: 'ackDenied' });
  void refreshStatus();
});

loadPrefs();
void refreshStatus();
setInterval(() => { void refreshStatus(); }, 500);
