# BeatSync Manual Test Checklist

Use two Brave instances (separate profiles is easiest) on the same LAN.

## Setup

- [ ] `npm run build` succeeds
- [ ] `dist/` loaded as unpacked extension in both Brave instances
- [ ] `https://music.youtube.com` open in both, same track ready to play (any track)
- [ ] Both popups opened; one set to **leader**, one to **follower**
- [ ] Paired via Create Offer → Accept Offer → Apply Answer
- [ ] Popup shows peer with `dcOpen` status and a measured RTT < 100 ms

## Smoke

- [ ] **Play sync**: leader hits play → follower starts within ~200 ms. (Eyeball or record both tabs; waveform alignment.)
- [ ] **Pause sync**: leader pauses → follower pauses within ~200 ms.
- [ ] **Seek sync**: leader scrubs to 1:30 → follower jumps to 1:30 within 2 s.
- [ ] **Track change**: leader navigates to a new track → follower navigates and syncs within 5 s.
- [ ] **Volume sync**: leader adjusts volume slider → follower's slider mirrors within 1 s.
- [ ] **Drift recovery**: after 60 s of continuous play, drift remains < 80 ms (popup drift column).

## Edge cases

- [ ] Follower disconnects (close tab) → leader keeps playing; reconnect re-syncs.
- [ ] Follower's YT Music not logged in → still syncs (or shows a clear error in popup).
- [ ] Service worker dormancy — leave alone for 5 min, then act → may need re-pair (documented limitation).
