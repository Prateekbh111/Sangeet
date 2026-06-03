// BeatSync MV3 service worker.
// MV3 SWs can't use RTCPeerConnection — WebRTC lives in extension/src/offscreen.ts.
// This file is a router:
//   popup / content  → bg → offscreen   (bg ensures offscreen is ready first)
//   offscreen        → bg → YT Music tab(s)

import type { RuntimeMsg } from './sync/protocol';

const OFFSCREEN_PATH = 'src/offscreen.html';

let offscreenReady: Promise<void> | null = null;

function ensureOffscreen(): Promise<void> {
  if (offscreenReady !== null) return offscreenReady;
  offscreenReady = (async () => {
    const offscreen = (chrome as unknown as {
      offscreen?: typeof chrome.offscreen;
    }).offscreen;
    if (!offscreen) {
      console.warn('[beatsync/bg] chrome.offscreen API not available');
      return;
    }
    const has = await offscreen.hasDocument().catch(() => false);
    if (has) return;
    try {
      await offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['WEB_RTC' as chrome.offscreen.Reason],
        justification:
          'Run WebRTC peer connections for cross-device playback sync.',
      });
      console.log('[beatsync/bg] offscreen document created');
    } catch (e) {
      console.log('[beatsync/bg] createDocument error', e);
    }
  })();
  return offscreenReady;
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[beatsync/bg] installed');
  void ensureOffscreen();
  void reinjectIntoOpenTabs();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[beatsync/bg] startup');
  void ensureOffscreen();
  void reinjectIntoOpenTabs();
});

void ensureOffscreen();
void reinjectIntoOpenTabs();

// Inject content script into already-open YT Music tabs.
// MV3 doesn't auto-inject into existing tabs when the extension reloads —
// without this, stale code keeps running until the user refreshes manually.
async function reinjectIntoOpenTabs(): Promise<void> {
  try {
    const manifest = chrome.runtime.getManifest();
    const scripts = manifest.content_scripts ?? [];
    if (scripts.length === 0) return;
    const tabs = await chrome.tabs.query({ url: '*://music.youtube.com/*' });
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue;
      for (const cs of scripts) {
        const files = cs.js;
        if (!files || files.length === 0) continue;
        const world = (cs as { world?: 'ISOLATED' | 'MAIN' }).world;
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files,
            world: world === 'MAIN' ? 'MAIN' : 'ISOLATED',
          });
          console.log(`[beatsync/bg] reinjected ${files.join(',')} (world=${world ?? 'ISOLATED'}) into tab ${tab.id}`);
        } catch (e) {
          console.log('[beatsync/bg] reinject failed tab=', tab.id, files, e);
        }
      }
    }
  } catch (e) {
    console.log('[beatsync/bg] reinject error', e);
  }
}

// ---------- kinds that get routed to the offscreen doc ----------

const OFFSCREEN_KINDS: ReadonlySet<string> = new Set([
  'getStatus',
  'connectRoom',
  'disconnect',
  'requestHost',
  'grantHost',
  'denyHost',
  'ackDenied',
  'localState',
  'driftReport',
]);

function kindOf(x: unknown): string | null {
  if (typeof x !== 'object' || x === null) return null;
  const k = (x as { kind?: unknown }).kind;
  return typeof k === 'string' ? k : null;
}

chrome.runtime.onMessage.addListener(
  (rawMsg: unknown, sender, sendResponse): boolean => {
    const kind = kindOf(rawMsg);
    if (kind === null) return false;

    // Don't intercept messages that the offscreen doc itself sent (target marks them).
    if ((rawMsg as { target?: string }).target === 'offscreen') return false;

    // Routes from offscreen → bg → content tab.
    if (kind === '_route:applyState') {
      void forwardApplyState(rawMsg as RouteApplyState).then(() =>
        sendResponse({ ok: true }),
      );
      return true;
    }
    if (kind === '_route:queryMedia') {
      void queryLeaderTab()
        .then((snap) => sendResponse(snap))
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    if (kind === '_route:doAction') {
      void forwardDoAction(rawMsg as RouteDoAction)
        .then(() => sendResponse({ ok: true }))
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    // Anything from popup/content for the offscreen doc.
    if (OFFSCREEN_KINDS.has(kind)) {
      void routeToOffscreen(rawMsg)
        .then((result) => sendResponse(result))
        .catch((err: unknown) =>
          sendResponse({ ok: false, error: String(err) }),
        );
      return true;
    }

    // Ignore — could be another listener's message.
    void sender;
    return false;
  },
);

interface RouteDoAction {
  kind: '_route:doAction';
  action: 'play' | 'pause' | 'seek' | 'volume' | 'next' | 'prev';
  payload?: unknown;
}

async function queryLeaderTab(): Promise<unknown> {
  const all = await chrome.tabs.query({});
  const tabs = all.filter((t) => typeof t.url === 'string' && /:\/\/music\.youtube\.com\//.test(t.url));
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    try {
      const snap = await chrome.tabs.sendMessage(tab.id, { kind: 'queryMedia' });
      if (snap) return snap;
    } catch { /* try next tab */ }
  }
  return { kind: 'mediaSnapshot', videoId: null, position: 0, paused: true, volume: 1, ready: false };
}

async function forwardDoAction(req: RouteDoAction): Promise<void> {
  const all = await chrome.tabs.query({});
  const tabs = all.filter((t) => typeof t.url === 'string' && /:\/\/music\.youtube\.com\//.test(t.url));
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        kind: 'doAction', action: req.action, payload: req.payload,
      });
    } catch (e) {
      console.warn('[beatsync/bg] doAction send failed', e);
    }
  }
}

async function routeToOffscreen(msg: unknown): Promise<unknown> {
  await ensureOffscreen();
  // Tag so the offscreen listener can disambiguate, then send.
  const tagged = { ...(msg as object), target: 'offscreen' };
  return await chrome.runtime.sendMessage(tagged);
}

interface RouteApplyState {
  kind: '_route:applyState';
  state: unknown;
  expectedLocalStart: number;
  clockOffset: number;
}

async function forwardApplyState(req: RouteApplyState): Promise<void> {
  // Query all tabs and filter manually — chrome.tabs.query with a URL filter
  // can miss PWA standalone windows on some Chromium builds.
  const all = await chrome.tabs.query({});
  const tabs = all.filter((t) => typeof t.url === 'string' && /:\/\/music\.youtube\.com\//.test(t.url));
  const stateObj = req.state as Extract<RuntimeMsg, { kind: 'applyState' }>['state'];
  if (tabs.length === 0) {
    console.log('[beatsync/bg] no YT Music tab found; dropping applyState videoId=', stateObj.videoId);
    return;
  }
  const msg: RuntimeMsg = {
    kind: 'applyState',
    state: stateObj,
    expectedLocalStart: req.expectedLocalStart,
    clockOffset: req.clockOffset,
  };
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    try {
      await chrome.tabs.sendMessage(tab.id, msg);
    } catch (e) {
      console.warn('[beatsync/bg] tabs.sendMessage failed tab=', tab.id, e);
    }
  }
}
