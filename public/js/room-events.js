// The event stream. Opening it *is* how this client joins the room, and it
// carries every room message plus all WebRTC signaling.
//
// Two transports, because the two servers this client can be served by differ
// in what they are able to hold open:
//
//   sse — a streaming HTTP response. What a long-lived process does best.
//   ws  — a WebSocket. What an edge runtime can keep across evictions.
//
// The page says which, in a meta tag the server fills in; the client never
// guesses. Nothing is ever sent upstream on either — actions are POSTs — so
// the rest of the app cannot tell them apart.

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;

export function transportName() {
  const meta = document.querySelector('meta[name="transport"]');
  const value = meta && meta.content;
  return value === 'ws' ? 'ws' : 'sse'; // an unfilled placeholder means SSE
}

// -- Server-Sent Events -------------------------------------------------------

function sseEvents(url) {
  const source = new EventSource(url);
  let closedByUs = false;

  return {
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
    // returns. The difference decides what the page may promise.
    get gaveUp() { return source.readyState === EventSource.CLOSED; },
    get closedByUs() { return closedByUs; },

    close() {
      closedByUs = true;
      try { source.close(); } catch (e) { /* already gone */ }
    },
  };
}

// -- WebSocket ----------------------------------------------------------------

function socketEvents(url) {
  const handlers = new Map();
  let socket = null;
  let errorHandler = () => {};
  let closedByUs = false;
  let everOpened = false;
  let attempts = 0;
  let retryTimer = null;

  function open() {
    socket = new WebSocket(url);

    socket.addEventListener('open', () => { attempts = 0; everOpened = true; });

    socket.addEventListener('message', (e) => {
      let frame = null;
      try { frame = JSON.parse(e.data); } catch (err) { return; }
      const handler = handlers.get(frame.event);
      if (handler) handler(frame.data || {});
    });

    socket.addEventListener('close', () => {
      if (closedByUs) return;
      errorHandler();
      // Always keep trying. A room that refuses us — locked, or we were
      // removed — is dealt with by the page: its error handler asks the
      // server what happened and closes this for good if the answer is final.
      clearTimeout(retryTimer);
      attempts++;
      retryTimer = setTimeout(open, Math.min(RETRY_MIN_MS * 2 ** (attempts - 1), RETRY_MAX_MS));
    });

    // An error is always followed by a close, which is where the retry lives.
    socket.addEventListener('error', () => {});
  }

  open();

  return {
    on(event, handler) { handlers.set(event, handler); },
    onError(handler) { errorHandler = handler; },

    get isOpen() { return !!socket && socket.readyState === WebSocket.OPEN; },
    // "Ask the server what happened." A rejected WebSocket handshake looks
    // exactly like an unreachable one from the browser — both arrive as close
    // code 1006 — so the useful distinction is not the code but whether this
    // socket ever opened at all.
    get gaveUp() { return !everOpened; },
    get closedByUs() { return closedByUs; },

    close() {
      closedByUs = true;
      clearTimeout(retryTimer);
      try { socket.close(); } catch (e) { /* already gone */ }
    },
  };
}

export function createRoomEvents(api) {
  return transportName() === 'ws' ? socketEvents(api.socketUrl()) : sseEvents(api.eventStreamUrl());
}
