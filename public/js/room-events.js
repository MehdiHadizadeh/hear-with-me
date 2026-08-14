// The event stream. Opening it *is* how this client joins the room, and it
// carries every room message plus all WebRTC signaling.

export function createRoomEvents(url) {
  const source = new EventSource(url);
  let closed = false;

  return {
    // Handlers get the parsed payload; a malformed frame is dropped rather
    // than thrown, because one bad frame must not kill the stream.
    on(event, handler) {
      source.addEventListener(event, (e) => {
        let data = null;
        try { data = e.data ? JSON.parse(e.data) : null; } catch (err) { return; }
        handler(data || {});
      });
    },

    onError(handler) { source.onerror = handler; },

    get isOpen() { return source.readyState === EventSource.OPEN; },
    // EventSource retries by itself after a network drop, but gives up for
    // good on a non-2xx status — which is what a missing or locked room
    // returns. The difference decides what the page is allowed to promise.
    get gaveUp() { return source.readyState === EventSource.CLOSED; },
    get closedByUs() { return closed; },

    close() {
      closed = true;
      try { source.close(); } catch (e) { /* already gone */ }
    },
  };
}
