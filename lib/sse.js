// Server-Sent Events, reduced to the one interface the Room needs:
// `{ send(event, data), end() }`.

import { SSE_KEEPALIVE_MS } from './config.js';

// Proxies between us and the browser hold a streamed response until enough
// bytes have accumulated. For SSE that means the client sees *nothing* — not
// an error, just a connection that never delivers — which is exactly how this
// failed through a Cloudflare tunnel while working on localhost. A comment
// line larger than a typical proxy buffer forces the first flush; clients
// ignore lines starting with ':'.
const FLUSH_PADDING = `:${' '.repeat(4096)}\n\n`;

export function openSseStream(req, res, { onClose }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // `no-transform` above is the standards-blessed "don't compress or rewrite
    // this"; X-Accel-Buffering is nginx's own opt-out. Neither is honoured by
    // every proxy, hence the padding.
    'X-Accel-Buffering': 'no',
  });
  res.write(FLUSH_PADDING);

  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) { /* client gone */ }
  }, SSE_KEEPALIVE_MS);
  if (keepAlive.unref) keepAlive.unref();

  const connection = {
    send(event, data) {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) { /* client gone */ }
    },
    end() {
      clearInterval(keepAlive);
      try { res.end(); } catch (e) { /* already gone */ }
    },
  };

  req.on('close', () => {
    clearInterval(keepAlive);
    onClose(connection);
  });

  return connection;
}
