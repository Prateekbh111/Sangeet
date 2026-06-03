# BeatSync — YouTube Music Multi-Device Sync (v1 Design)

**Date:** 2026-06-03
**Status:** Approved
**Author:** prateek + Claude

## Goal

Brave browser extension (MV3) that synchronizes YouTube Music playback across multiple devices with minimal audible drift (<80 ms steady-state). One device acts as leader; others follow. Followers may request actions; leader decides.

## Non-Goals (v1)

- Automatic peer discovery (manual SDP paste in v1; helper app comes in v2).
- Queue/playlist mirroring beyond per-track sync.
- Multi-leader or live leader handoff.
- Mobile clients.
- Hosted signaling server.

## Success Criteria

- Two Brave instances on the same LAN, manually paired via copied SDP, play the same YouTube Music track within ±80 ms of each other.
- Play, pause, seek, track-change, and volume changes on the leader propagate within one RTT + 200 ms scheduling buffer.
- Followers visibly recover (drift < 80 ms) within 2 seconds after any audible divergence.

## Architecture

```
+--------------------- Brave (Leader) ---------------------+        +--------------------- Brave (Follower) -----------------+
| popup.html/js  ──┐                                       |        |  popup.html/js                                         |
|                  ▼                                       |        |        ▲                                               |
| service worker (bg.js) ── RTCPeerConnection ── DataChan ─┼────────┼─ DataChan ── RTCPeerConnection ── service worker (bg.js)|
|        ▲                                                 |        |                                                 ▲       |
|        │ chrome.runtime msgs                             |        |                              chrome.runtime msgs│       |
|        ▼                                                 |        |                                                 ▼       |
| content.js  on  music.youtube.com  ⇄  page <video>       |        |  content.js  on  music.youtube.com  ⇄  page <video>    |
+----------------------------------------------------------+        +--------------------------------------------------------+
```

### Components

1. **`content.js`** (injected into `music.youtube.com`)
   - Finds the page's HTMLMediaElement (the `<video>` YT Music uses for audio).
   - Reads: `currentTime`, `paused`, `volume`, `playbackRate`, current `videoId` (from URL `?v=`).
   - Writes: `play()`, `pause()`, `currentTime`, `volume`, `playbackRate`.
   - Navigates to a new `videoId` by dispatching a click on YT Music's internal navigation hooks; fallback: `location.assign('https://music.youtube.com/watch?v=' + id)`.
   - Sends events to `bg.js` via `chrome.runtime.sendMessage`; receives commands via `chrome.runtime.onMessage`.

2. **`bg.js`** (MV3 service worker)
   - Owns the `RTCPeerConnection` map and `RTCDataChannel` map keyed by peerId.
   - Maintains per-peer clock offset and RTT (rolling median of last 10 samples).
   - Routes state between content script and peers.
   - Single in-memory `Session` object: `{ role: 'leader'|'follower', peers: Map, leaderState: State }`.

3. **`popup.html/js`**
   - Toggle role (leader/follower).
   - "Create offer" → shows SDP blob to copy.
   - "Accept offer" → paste leader's SDP → returns answer SDP to copy back.
   - Peer list with RTT, drift, connection status.

4. **`sync.js`** (shared ES module)
   - `clock.ts`: ping/pong sample collection, offset+rtt computation.
   - `scheduler.ts`: turns `STATE` messages into local actions, computes drift, applies micro-seek or playbackRate nudge.
   - `protocol.ts`: TypeScript types and JSON encode/decode for messages.

## Sync Protocol

All messages JSON over `RTCDataChannel` (ordered, reliable).

```ts
type Msg =
  | { t: 'PING';  id: string; t1: number }                                // sender wall time
  | { t: 'PONG';  id: string; t1: number; t2: number; t3: number }        // t2,t3 = recv,send on responder
  | { t: 'STATE'; videoId: string; position: number; paused: boolean;
                  volume: number; scheduledWallTime: number; seq: number }
  | { t: 'REQUEST'; action: 'play'|'pause'|'next'|'prev'|'seek'|'volume';
                    payload?: any; from: string }
  | { t: 'HELLO'; peerId: string; role: 'leader'|'follower'; name?: string }
```

### Clock sync

- Every 2 s, each side sends `PING`. Responder replies `PONG` with `t2` (recv) and `t3` (send).
- Sender on receipt records `t4 = now`. Then:
  - `rtt = (t4 - t1) - (t3 - t2)`
  - `offset = ((t2 - t1) + (t3 - t4)) / 2`   (peerClock − localClock)
- Keep rolling **median** of last 10 samples for both. Discard `rtt` outliers > 3× median before computing median offset.

### State broadcast (leader → followers)

Leader emits a `STATE` message on any of: play, pause, seek > 250 ms, volume change, videoId change. Also a heartbeat every 5 s.

`scheduledWallTime = leaderNow + max(peerRTT/2 across followers) + 150 ms`

### Follower behavior on `STATE`

```
if videoId != current:
    navigate(videoId)
    await loadedmetadata
expectedLocalStart = scheduledWallTime - clockOffset   // convert leader wall → local wall
if paused:
    media.pause()
    media.currentTime = position
else:
    media.currentTime = position + max(0, (expectedLocalStart - localNow)/1000)  // pre-roll seek
    media.pause()                                       // hold until scheduled time
    setTimeout(() => media.play(), expectedLocalStart - localNow)
volume = STATE.volume
```

### Drift correction (follower, while playing)

Every 1 s:

```
expectedPosition = leaderState.position + (localNow - leaderStateLocalReceivedAt)/1000 + clockOffsetAdjustment
drift = media.currentTime - expectedPosition
if |drift| > 0.5 s:
    media.currentTime = expectedPosition          // hard seek
elif |drift| > 0.08 s:
    media.playbackRate = drift > 0 ? 0.98 : 1.02  // glide back
else:
    media.playbackRate = 1.0
```

### Follower requests

Follower may send `REQUEST`. Leader policy v1: honor any request from any paired peer (lenient). Leader echoes resulting `STATE` to all.

## Data Flow Example: leader hits pause

1. User clicks pause in YT Music tab on leader device.
2. Page fires `pause` event on `<video>`.
3. `content.js` reads new state, sends `{type:'localState', ...}` to `bg.js`.
4. `bg.js` builds `STATE` message with `paused:true`, `scheduledWallTime = now + 150 ms`.
5. Broadcasts to all DataChannels.
6. Each follower's `bg.js` forwards `STATE` to its `content.js`.
7. Follower `content.js` schedules `media.pause()` at `expectedLocalStart`.

## Error Handling

| Condition | Behavior |
|---|---|
| Peer DataChannel closes | Mark peer stale; popup shows red. No auto-reconnect (manual re-pair). |
| YT Music tab not open on follower | Popup shows "Open YT Music"; queue last `STATE` and apply on tab ready. |
| `videoId` not playable on follower (region/auth) | Content script reports `unavailable`; bg.js sends `REQUEST {action:'next'}` to leader after 3 s. |
| User logged out of YT Music | Show notice in popup. Sync still attempted; will likely 403. |
| Service worker restarted by Chrome | Re-init from `chrome.storage.session`; peer connections lost → user re-pairs. (Accept this limitation in v1.) |
| Clock offset jumps > 200 ms | Reset rolling median; pause drift correction for 2 s. |

## Testing

### Unit (vitest)
- `clock.ts`: offset+rtt math against synthetic samples; outlier rejection.
- `scheduler.ts`: drift correction state machine — feed positions, assert seek vs playbackRate decisions.
- `protocol.ts`: round-trip encode/decode.

### Manual smoke (checklist in `docs/manual-test.md`)
1. Two Brave windows on one machine → same track, paused start → leader plays → verify both start within 200 ms (record both `<video>` tabs, eyeball waveform).
2. Leader seeks mid-track → follower catches up < 2 s.
3. Leader changes track → follower navigates and catches up.
4. Volume slider parity.
5. Disconnect follower mid-play → leader continues; reconnect → re-sync.

## Repo Layout

```
beatsync/
├── docs/superpowers/{specs,plans}/...
├── extension/
│   ├── manifest.json
│   ├── src/
│   │   ├── bg.ts
│   │   ├── content.ts
│   │   ├── popup.html
│   │   ├── popup.ts
│   │   └── sync/
│   │       ├── clock.ts
│   │       ├── scheduler.ts
│   │       └── protocol.ts
│   ├── public/icons/{16,48,128}.png
│   └── tests/*.test.ts
├── vite.config.ts        # vite + @crxjs/vite-plugin for MV3 build
├── package.json
├── tsconfig.json
└── README.md
```

## Build/Tooling

- **Vite + `@crxjs/vite-plugin`** for MV3 HMR builds.
- **TypeScript** strict.
- **Vitest** for units.
- `npm run dev` → `dist/` (load unpacked into Brave). `npm run build` → production zip.

## Open Items (deferred to v2)

- Auto-discovery (mDNS-like via small companion app or QR-code SDP exchange).
- Encrypted DataChannel signaling.
- Persistent peer pairing across SW restarts.
- Premium queue/playlist sync.
