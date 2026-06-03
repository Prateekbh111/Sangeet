# BeatSync

Brave/Chromium MV3 extension that syncs YouTube Music playback across devices.

One device is the **leader**, others are **followers**. Leader's play/pause/seek/track/volume mirror to followers within ~one network RTT.

## Status

v1 — manual SDP-paste pairing (no signaling server). LAN peer-to-peer over WebRTC after pairing.

## Build

```bash
npm install
npm run build      # one-shot → dist/
```

## Dev (auto-rebuild + auto-restart server)

```bash
npm run dev
```
Runs `vite build --watch` (rebuilds `dist/` on every code change) and `node --watch server/index.js` (restarts server on file save) side by side. After the extension is loaded unpacked in Brave, Brave auto-reloads it whenever `dist/` changes.

## Install in Brave

1. `brave://extensions`
2. Toggle **Developer mode** (top right).
3. **Load unpacked** → select `dist/`.
4. Pin the BeatSync icon.
5. Open `https://music.youtube.com` in a tab.

## Pair two devices (automatic via local signaling)

1. On **any one device on the LAN** (laptop, desktop, anything that can run Node):
   ```bash
   npm run server
   ```
   It prints reachable URLs, e.g. `ws://192.168.0.105:8787`.

2. On both devices, click the BeatSync icon:
   - **Role**: leader on one, follower on the other.
   - **Signaling server**: the `ws://…:8787` URL from step 1 (or `ws://localhost:8787` if the server runs on the same machine).
   - **Room code**: any short string — both devices must use the same one (e.g. `room42`).
   - Click **Connect**.

3. Status flips to `connected · room=…`. Within a second or two the peer list shows the other device with an `open` data channel and a measured RTT.

Press play on the leader. Follower follows.

## Dev

```bash
npm run dev        # vite + crxjs HMR; load dist/ as unpacked
npm test           # vitest
```

## Layout

```
extension/
  manifest.json
  src/
    bg.ts                 service worker (peers, clock, broadcast)
    content.ts            YT Music DOM hook + drift loop
    popup.{html,ts}       pairing UI
    sync/
      clock.ts            rolling RTT/offset
      scheduler.ts        drift decisions
      protocol.ts         wire types
  tests/                  vitest units
docs/superpowers/
  specs/2026-06-03-ytmusic-sync-design.md
  plans/2026-06-03-ytmusic-sync-plan.md
```

## Production setup

For real cross-device use:

### 1. Server as a launchd service (macOS)

So the signaling server runs at boot and survives restarts:

```bash
# Adjust paths inside server/com.beatsync.signaling.plist if needed,
# then install:
cp server/com.beatsync.signaling.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.beatsync.signaling.plist
# Check status:
launchctl print gui/$(id -u)/com.beatsync.signaling
```

Stdout/stderr go to `server/server.log` and `server/server.err.log`. Uninstall:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.beatsync.signaling.plist
```

### 2. Pick the host

Pick the device that will reliably stay on the LAN (your main desktop, a NAS, a Raspberry Pi). Note its local IP (`ipconfig getifaddr en0` on macOS). Use `ws://<that-ip>:8787` in every extension popup.

If the host's IP changes often, reserve a DHCP lease on your router or use `<hostname>.local` if mDNS is available (`ws://my-mac.local:8787`).

### 3. Firewall

macOS may prompt to allow incoming connections on port 8787 the first time. Allow it. Otherwise: System Settings → Network → Firewall → Options → allow `node`.

### 4. First-time playback on each follower

Brave/Chrome block autoplay until the user interacts with the page. The first time a follower needs to start playing, BeatSync shows a centered overlay: **"Start sync"**. Click once — sync runs hands-off after that for the rest of the session.

## Known limitations

- Signaling needs a process running somewhere on the LAN (the bundled `npm run server`). It only relays handshakes — actual audio sync is direct peer-to-peer.
- No persistent pairing across service-worker restarts; re-pair if Brave restarts the SW.
- No queue mirroring — only the currently-loaded track.
- Each follower needs its own YouTube Music tab open. Auth state is per-device.

See `docs/manual-test.md` for the smoke checklist.
# Sangeet
