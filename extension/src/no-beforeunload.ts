// Runs in YT Music's MAIN world at document_start. Patches
// EventTarget.prototype.addEventListener so any later beforeunload
// registration by YT Music is silently dropped. Without this, navigating
// the tab to a new track (when leader changes song) triggers the browser's
// "Leave app?" dialog because YT Music's PWA hooks beforeunload.

(() => {
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

  // Also defang the legacy onbeforeunload property setter.
  try {
    Object.defineProperty(window, 'onbeforeunload', {
      configurable: true,
      get: () => null,
      set: () => { /* noop */ },
    });
  } catch { /* ignore */ }

  console.log('[BeatSync] beforeunload registration blocked');
})();
