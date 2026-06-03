// BeatSync YT Music content script. Runs on music.youtube.com pages.
// Bridges DOM media element <-> background service worker.

import type { RuntimeMsg, State } from './sync/protocol';
import { expectedPosition, decideAction } from './sync/scheduler';

// Re-injection guard (chrome.scripting.executeScript on extension reload).
declare global {
  interface Window { __beatsyncLoaded?: boolean }
}
const alreadyLoaded = window.__beatsyncLoaded === true;
window.__beatsyncLoaded = true;
console.log('[BeatSync] content script load, alreadyLoaded=', alreadyLoaded);

let mediaEl: HTMLMediaElement | null = null;
let lastApplied: {
  state: State;
  receivedLocal: number;
  clockOffset: number;
} | null = null;
let driftLoopStarted = false;
let localStateTimer: number | null = null;
let pendingPlay = false;
let gestureListenerAttached = false;
let suppressBeforeUnload = false;
let lastSeekAt = 0;
const SEEK_THROTTLE_MS = 2500;

// Suppress YT Music's "Leave site? Changes may not be saved." dialog when we
// navigate the tab to a new track. Registered with capture:true so we run
// before YT Music's bubble-phase listener; stopImmediatePropagation prevents
// theirs from firing.
if (!alreadyLoaded) {
  window.addEventListener('beforeunload', (e) => {
    if (!suppressBeforeUnload) return;
    e.stopImmediatePropagation();
    // Some browsers also check returnValue / preventDefault — clear them.
    (e as BeforeUnloadEvent).returnValue = '';
  }, { capture: true });
}

function navigateToVideo(videoId: string): void {
  suppressBeforeUnload = true;
  // Belt + suspenders: clear any onbeforeunload assignment YT Music made.
  try { window.onbeforeunload = null; } catch { /* ignore */ }
  location.assign('https://music.youtube.com/watch?v=' + encodeURIComponent(videoId));
}

function currentVideoId(): string | null {
  // Primary: URL ?v= param (works on /watch routes).
  try {
    const fromUrl = new URL(location.href).searchParams.get('v');
    if (fromUrl) return fromUrl;
  } catch { /* fall through */ }
  // Fallback: YT Music keeps the active song's link in the player bar / mini-player.
  // Works on home, explore, library, etc. while a track is playing.
  const selectors = [
    'ytmusic-player-bar a[href*="watch?v="]',
    'ytmusic-player-bar a.yt-simple-endpoint[href*="watch?v="]',
    'a.ytp-title-link[href*="watch?v="]',
    'a[href*="watch?v="]',
  ];
  for (const sel of selectors) {
    const a = document.querySelector<HTMLAnchorElement>(sel);
    if (!a) continue;
    try {
      const u = new URL(a.href, location.origin);
      const v = u.searchParams.get('v');
      if (v) return v;
    } catch { /* try next */ }
  }
  return null;
}

function findMedia(): Promise<HTMLMediaElement> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('video');
    if (existing) {
      resolve(existing);
      return;
    }
    let resolved = false;
    const observer = new MutationObserver(() => {
      const found = document.querySelector('video');
      if (found && !resolved) {
        resolved = true;
        observer.disconnect();
        resolve(found);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      if (!resolved) {
        observer.disconnect();
        reject(new Error('[BeatSync] media element not found within 30s'));
      }
    }, 30_000);
  });
}

function sendToBg(msg: RuntimeMsg): void {
  try {
    chrome.runtime.sendMessage(msg).catch(() => { /* ignore */ });
  } catch {
    // ignore - bg may not be available
  }
}

function attachMediaListeners(media: HTMLMediaElement): void {
  const fire = () => {
    if (localStateTimer !== null) clearTimeout(localStateTimer);
    localStateTimer = window.setTimeout(() => {
      const vid = currentVideoId();
      if (!vid) { console.log('[BeatSync] localState skipped: no videoId'); return; }
      console.log(`[BeatSync] sending localState videoId=${vid} paused=${media.paused} pos=${media.currentTime.toFixed(2)}`);
      sendToBg({
        kind: 'localState',
        videoId: vid,
        position: media.currentTime,
        paused: media.paused,
        volume: media.volume,
      });
    }, 300);
  };
  (['play', 'pause', 'seeked', 'volumechange', 'ratechange', 'loadstart', 'durationchange', 'ended'] as const).forEach((ev) => {
    media.addEventListener(ev, fire);
  });

  // Also detect SPA URL/videoId changes — YT Music does pushState when changing
  // tracks without always firing media events.
  let lastVid = currentVideoId();
  const checkVid = () => {
    const v = currentVideoId();
    if (v !== lastVid) {
      console.log(`[BeatSync] videoId changed ${lastVid} → ${v}`);
      lastVid = v;
      fire();
    }
  };
  setInterval(checkVid, 250);
  window.addEventListener('popstate', checkVid);
}

async function ensureMedia(): Promise<HTMLMediaElement> {
  if (mediaEl && document.contains(mediaEl)) return mediaEl;
  const m = await findMedia();
  mediaEl = m;
  attachMediaListeners(m);
  startDriftLoop();
  return m;
}

function scheduleAt(targetMs: number, fn: () => void): void {
  const delay = Math.max(0, targetMs - Date.now());
  setTimeout(fn, delay);
}

function showAutoplayOverlay(): void {
  if (document.getElementById('beatsync-overlay')) return;
  const wrap = document.createElement('div');
  wrap.id = 'beatsync-overlay';
  wrap.setAttribute('role', 'dialog');
  wrap.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483647;
    background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
    font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  `;
  const card = document.createElement('div');
  card.style.cssText = `
    background: #111; color: #eee; border: 1px solid #2a2a2a; border-radius: 10px;
    padding: 20px 24px; max-width: 360px; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,.5);
  `;
  card.innerHTML = `
    <div style="font-size:15px;font-weight:600;margin-bottom:6px;">BeatSync ready</div>
    <div style="font-size:13px;color:#aaa;margin-bottom:14px;">
      Click below to start synced playback. Brave blocks autoplay until you interact with the tab.
    </div>
  `;
  const btn = document.createElement('button');
  btn.textContent = 'Start sync';
  btn.style.cssText = `
    background:#4a9eff; color:#001; border:none; border-radius:6px;
    padding:8px 18px; font:inherit; font-weight:600; cursor:pointer;
  `;
  btn.addEventListener('click', () => {
    if (mediaEl) {
      void mediaEl.play()
        .then(() => { pendingPlay = false; hideAutoplayOverlay(); })
        .catch(() => { /* leave overlay */ });
    } else {
      hideAutoplayOverlay();
    }
  });
  card.appendChild(btn);
  wrap.appendChild(card);
  document.documentElement.appendChild(wrap);
}

function hideAutoplayOverlay(): void {
  document.getElementById('beatsync-overlay')?.remove();
}

function armGestureRetry(): void {
  showAutoplayOverlay();
  if (gestureListenerAttached) return;
  gestureListenerAttached = true;
  // Any user gesture on the page also unblocks — overlay is the obvious target,
  // but allow keypress / click anywhere to recover too.
  const tryPlay = () => {
    if (!pendingPlay || !mediaEl) return;
    void mediaEl.play()
      .then(() => { pendingPlay = false; hideAutoplayOverlay(); })
      .catch(() => { /* still blocked */ });
  };
  const events: (keyof DocumentEventMap)[] = ['click', 'keydown', 'pointerdown', 'touchstart'];
  for (const ev of events) {
    document.addEventListener(ev, tryPlay, { capture: true });
  }
  console.warn('[BeatSync] autoplay blocked — click overlay to start sync.');
}

function attemptPlay(media: HTMLMediaElement): void {
  pendingPlay = true;
  void media.play()
    .then(() => { pendingPlay = false; })
    .catch((err) => {
      if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
        armGestureRetry();
      }
    });
}

async function applyState(
  state: State,
  expectedLocalStart: number,
  clockOffset: number,
): Promise<void> {
  const media = await ensureMedia();
  const curVid = currentVideoId();
  console.log(`[BeatSync] applyState videoId=${state.videoId} cur=${curVid} paused=${state.paused} pos=${state.position.toFixed(2)}`);
  if (state.videoId && state.videoId !== curVid) {
    console.log(`[BeatSync] videoId mismatch → navigating to ${state.videoId}`);
    navigateToVideo(state.videoId);
    return;
  }

  if (Math.abs(media.volume - state.volume) > 0.01) media.volume = state.volume;
  const nowLocal = Date.now();
  const leadMs = Math.max(0, expectedLocalStart - nowLocal);

  if (state.paused) {
    if (!media.paused) { try { media.pause(); } catch { /* ignore */ } }
    if (Math.abs(media.currentTime - state.position) > 0.08) {
      media.currentTime = state.position;
      lastSeekAt = Date.now();
    }
  } else {
    // Leader is playing. Compute where they are RIGHT NOW in our local clock.
    const senderLocalTime = expectedLocalStart - leadMs;
    const elapsedSec = Math.max(0, nowLocal - senderLocalTime) / 1000;
    const liveExpected = state.position + elapsedSec;
    const preRollSec = leadMs / 1000;

    if (media.paused) {
      // We're paused but leader is playing — full pre-roll + scheduled play.
      media.currentTime = state.position + preRollSec;
      lastSeekAt = Date.now();
      scheduleAt(expectedLocalStart, () => attemptPlay(media));
    } else {
      const drift = media.currentTime - liveExpected;
      // Only hard-resync (pause+seek+replay) for big drift. For small drift
      // we let the drift loop glide via playbackRate — interrupting playback
      // on every STATE arrival causes "stuck syncing" loops.
      if (Math.abs(drift) > 0.4) {
        try { media.pause(); } catch { /* ignore */ }
        media.currentTime = state.position + preRollSec;
        lastSeekAt = Date.now();
        scheduleAt(expectedLocalStart, () => attemptPlay(media));
      }
      // else: drift loop handles via playbackRate; lastApplied refresh below
      // gives it a fresh reference.
    }
  }

  lastApplied = { state, receivedLocal: nowLocal, clockOffset };
}

function startDriftLoop(): void {
  if (driftLoopStarted) return;
  driftLoopStarted = true;
  setInterval(() => {
    if (!mediaEl || !lastApplied) return;
    // Leader says play but we're paused — autoplay was blocked. Keep trying.
    if (mediaEl.paused && !lastApplied.state.paused) {
      attemptPlay(mediaEl);
      return;
    }
    if (mediaEl.paused) return;
    // Don't compute drift while a seek or buffering is in progress —
    // currentTime is frozen during these, drift would look enormous and we'd
    // re-seek in a loop ("stuck syncing").
    if (mediaEl.seeking) return;
    if (mediaEl.readyState < 3 /* HAVE_FUTURE_DATA */) return;
    const expected = expectedPosition(
      lastApplied.state,
      lastApplied.receivedLocal,
      Date.now(),
      lastApplied.clockOffset,
    );
    const drift = mediaEl.currentTime - expected;
    const action = decideAction(drift);
    if (action.kind === 'seek') {
      // Throttle hard seeks: YT Music's buffer takes ~300–800ms per seek.
      // Without this we'd seek every drift-loop tick before playback resumes.
      if (Date.now() - lastSeekAt < SEEK_THROTTLE_MS) return;
      mediaEl.currentTime = expected;
      lastSeekAt = Date.now();
      if (mediaEl.playbackRate !== 1) mediaEl.playbackRate = 1;
    } else if (action.kind === 'rate') {
      mediaEl.playbackRate = action.value ?? 1;
    } else {
      if (mediaEl.playbackRate !== 1) mediaEl.playbackRate = 1;
    }
    sendToBg({ kind: 'driftReport', drift });
  }, 1000);
}

if (!alreadyLoaded) chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const msg = message as RuntimeMsg;
  if (!msg || typeof msg !== 'object' || !('kind' in msg)) return false;

  switch (msg.kind) {
    case 'queryMedia': {
      const vid = currentVideoId();
      if (mediaEl) {
        const snap: RuntimeMsg = {
          kind: 'mediaSnapshot',
          videoId: vid,
          position: mediaEl.currentTime,
          paused: mediaEl.paused,
          volume: mediaEl.volume,
          ready: true,
        };
        sendResponse(snap);
      } else {
        const snap: RuntimeMsg = {
          kind: 'mediaSnapshot',
          videoId: vid,
          position: 0,
          paused: true,
          volume: 1,
          ready: false,
        };
        sendResponse(snap);
      }
      return false;
    }
    case 'navigate': {
      if (currentVideoId() !== msg.videoId) {
        navigateToVideo(msg.videoId);
      }
      return false;
    }
    case 'applyState': {
      void applyState(msg.state, msg.expectedLocalStart, msg.clockOffset);
      return false;
    }
    case 'doAction': {
      void handleDoAction(msg.action, msg.payload);
      sendResponse({ ok: true });
      return false;
    }
    default:
      return false;
  }
});

async function handleDoAction(
  action: 'play' | 'pause' | 'seek' | 'volume' | 'next' | 'prev',
  payload: unknown,
): Promise<void> {
  const media = await ensureMedia();
  switch (action) {
    case 'play':   await media.play().catch(() => { /* gesture */ }); return;
    case 'pause':  media.pause(); return;
    case 'seek': {
      const p = typeof payload === 'number' ? payload
        : (payload as { position?: number })?.position;
      if (typeof p === 'number') media.currentTime = p;
      return;
    }
    case 'volume': {
      const v = typeof payload === 'number' ? payload
        : (payload as { volume?: number })?.volume;
      if (typeof v === 'number') media.volume = Math.max(0, Math.min(1, v));
      return;
    }
    case 'next':
    case 'prev': {
      const sel = action === 'next' ? '.next-button' : '.previous-button';
      const btn = document.querySelector<HTMLElement>(sel);
      if (btn) btn.click();
      return;
    }
  }
}

// Kick off media discovery in the background (once per page).
if (!alreadyLoaded) {
  void ensureMedia().catch((err) => {
    console.warn('[BeatSync]', err);
  });
}
