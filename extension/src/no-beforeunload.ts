// Runs in YT Music's MAIN world at document_start.
// 1. Patches EventTarget.prototype.addEventListener to drop beforeunload
//    registrations, preventing YT Music's PWA "Leave app?" dialog when we
//    navigate the tab to a new track.
// 2. Polls the embedded YouTube player's JS API to expose the current video ID
//    via document.documentElement.dataset.beatsyncVid. The isolated content
//    script reads this attribute, making video ID detection reliable even when
//    the page URL has no ?v= (e.g. home/library/playlist pages).

(() => {
  // ---- beforeunload suppression ----
  const origAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    opts?: boolean | AddEventListenerOptions,
  ): void {
    if (type === 'beforeunload') return; // drop all registrations
    return origAdd.call(this, type, listener as EventListenerOrEventListenerObject, opts);
  } as typeof EventTarget.prototype.addEventListener;

  try {
    Object.defineProperty(window, 'onbeforeunload', {
      configurable: true,
      get: () => null,
      set: () => { /* noop */ },
    });
  } catch { /* ignore */ }

  console.log('[BeatSync] beforeunload registration blocked');

  // ---- video ID exposure ----
  function pollVideoId(): void {
    try {
      // YT Music embeds the standard YouTube player with id="movie_player".
      const player = document.getElementById('movie_player') as (Element & {
        getVideoData?: () => { video_id?: string };
      }) | null;
      const vid = player?.getVideoData?.()?.video_id;
      if (vid) {
        document.documentElement.dataset.beatsyncVid = vid;
        return;
      }
    } catch { /* ignore */ }
    // Clear stale value if player not available.
    delete document.documentElement.dataset.beatsyncVid;
  }

  // Start polling once DOM is interactive.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setInterval(pollVideoId, 500));
  } else {
    setInterval(pollVideoId, 500);
  }
})();
