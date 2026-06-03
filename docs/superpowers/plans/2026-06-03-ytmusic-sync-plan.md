# BeatSync — Implementation Plan

Spec: `docs/superpowers/specs/2026-06-03-ytmusic-sync-design.md`

## Phase 1: Scaffold (sequential, foundation)

**P1.1** — `package.json`, `tsconfig.json`, `vite.config.ts`, `.gitignore`
- Deps: `vite`, `@crxjs/vite-plugin`, `typescript`, `vitest`, `@types/chrome`
- Scripts: `dev`, `build`, `test`

**P1.2** — `extension/manifest.json` (MV3)
- `manifest_version: 3`
- `host_permissions: ["*://music.youtube.com/*"]`
- `permissions: ["storage", "scripting"]`
- `background.service_worker: "src/bg.ts"`, `type: "module"`
- `content_scripts: [{matches:["*://music.youtube.com/*"], js:["src/content.ts"], run_at:"document_idle"}]`
- `action.default_popup: "src/popup.html"`
- Icons (placeholder solid color PNGs OK)

**P1.3** — `extension/src/sync/protocol.ts` — message type defs + zod-light validators (no zod dep; hand-rolled guards)

## Phase 2: Sync core (parallelizable after P1.3)

**P2.1** — `extension/src/sync/clock.ts`
- `class Clock { addSample(t1,t2,t3,t4); offset(): number; rtt(): number }`
- Rolling median window 10. Reject `rtt` > 3× median.

**P2.2** — `extension/src/sync/scheduler.ts`
- Pure functions:
  - `expectedPosition(state, nowLocal, offset): number`
  - `decideAction(drift): {kind:'seek'|'rate'|'none', value?:number}`
- Stateless; takes leader state + local clock.

**P2.3** — Unit tests `extension/tests/clock.test.ts`, `scheduler.test.ts`
- Cover offset math, outlier rejection, drift thresholds (0.08, 0.5).

## Phase 3: Extension wiring (parallelizable)

**P3.1** — `extension/src/bg.ts` (service worker)
- `PeerManager`: create/accept offer, manage `RTCPeerConnection` + `RTCDataChannel`.
- Routes `chrome.runtime` messages ↔ DataChannel.
- Holds `Clock` per peer; runs ping loop every 2 s.
- Leader: aggregates page state, builds `STATE`, broadcasts.
- Follower: receives `STATE`, forwards to content script with computed `expectedLocalStart`.

**P3.2** — `extension/src/content.ts`
- `findMedia(): HTMLMediaElement` — `document.querySelector('video')`; MutationObserver until present.
- Hooks `play`, `pause`, `seeked`, `volumechange`, `ratechange` events; throttles seek events.
- Reads `videoId` from `new URL(location.href).searchParams.get('v')`.
- Listens for commands from bg.js:
  - `apply(state, expectedLocalStart)` — pre-roll seek + schedule play.
  - `navigate(videoId)` — `location.assign('https://music.youtube.com/watch?v=' + id)`.
- Runs 1 Hz drift loop using `scheduler.decideAction`.

**P3.3** — `extension/src/popup.html` + `popup.ts`
- Role toggle.
- "Create offer" button → calls bg.js → shows SDP in textarea.
- "Paste remote SDP" textarea + "Apply" → bg.js processes.
- Peer table: peerId, RTT, drift, status (rendered from bg.js state queried every 500 ms).
- Minimal CSS, dark theme.

## Phase 4: Manual test doc

**P4.1** — `docs/manual-test.md` — checklist from spec §Testing.

**P4.2** — `README.md` — install in Brave, pair, troubleshoot.

## Parallelization Map

```
P1.1 → P1.2 → P1.3 ──┬─→ P2.1 ─┐
                     ├─→ P2.2 ─┤
                     └─→ P2.3 ─┴─→ P3.1 ─┐
                                  P3.2 ──┤── P4
                                  P3.3 ──┘
```

Phase 2 tasks run in parallel after P1.3. Phase 3 tasks run in parallel after Phase 2.

## Subagent Dispatch (for fast track)

- **Agent A**: P1.1–P1.3 (scaffold). Blocking.
- **Agent B**: P2.1 + tests.
- **Agent C**: P2.2 + tests.
- **Agent D**: P3.1 (bg.ts) — after Phase 2.
- **Agent E**: P3.2 (content.ts) — after Phase 2.
- **Agent F**: P3.3 (popup) — after Phase 2.
- **Agent G**: P4 docs.

A, then B+C parallel, then D+E+F parallel, then G.

## Acceptance

- `npm install && npm run build` succeeds.
- `npm test` green.
- `dist/` loads into Brave at `brave://extensions` (developer mode).
- Two Brave instances on same LAN pair via copy/paste SDP, achieve sync per spec success criteria.
