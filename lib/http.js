// The HTTP plumbing: reading bodies, writing JSON, serving files. Nothing in
// here knows what a room is.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_BODY_BYTES } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(HERE, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Markup, styles and scripts always revalidate: there is no build step putting
// hashes in filenames, so a cached app.js is how a fix looks like it didn't
// work. The font never changes and icons change rarely, so neither should cost
// a round trip on every load of a mobile page.
function cacheControl(ext) {
  if (ext === '.woff2') return 'public, max-age=31536000, immutable';
  if (['.png', '.ico', '.jpg', '.jpeg'].includes(ext)) return 'public, max-age=86400';
  return 'no-cache';
}

export function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function readJSONBody(req, res, cb) {
  let data = '';
  let size = 0;
  let aborted = false;

  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) { data += chunk; return; }

    // Answer properly instead of destroying the socket, which surfaced to the
    // client as an opaque ECONNRESET. We stop reading the rest of the body, so
    // the connection can't be reused — say so, or a keep-alive client sends
    // its next request into a socket we're about to drop.
    aborted = true;
    const body = JSON.stringify({ error: 'payload-too-large' });
    res.writeHead(413, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      Connection: 'close',
    });
    res.end(body, () => req.destroy());
  });

  req.on('end', () => {
    if (aborted) return;
    try { cb(null, data ? JSON.parse(data) : {}); } catch (e) { cb(e); }
  });
  req.on('error', () => { if (!aborted) { aborted = true; cb(new Error('request error')); } });
}

export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

// Link previews are part of this product: a room link is meant to be pasted
// into Telegram or WhatsApp. Open Graph needs absolute URLs, and we have no
// idea at build time whether we are on localhost, a tunnel or a real domain —
// so the pages carry a %ORIGIN% placeholder and we fill it from the request.
export function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

export function serveStatic(res, pathname, method = 'GET', origin = '') {
  // `pathname` comes straight from URL parsing, which always uses forward
  // slashes regardless of OS. It must be resolved as a POSIX path first: plain
  // `path.normalize`/`path.join` would switch to the platform separator
  // (backslash on Windows) and silently break both the `=== '/'` check and the
  // traversal guard, since a Windows join then walks off somewhere else.
  let reqPath = decodeURIComponent(pathname.split('?')[0]);
  reqPath = path.posix.normalize(reqPath === '/' ? '/index.html' : reqPath);
  if (reqPath.split('/').includes('..')) { res.writeHead(403); return res.end('forbidden'); }

  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }

  return fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl(ext),
    };

    // HTML is small enough to read whole, and it is the only thing carrying
    // the %ORIGIN% placeholder.
    if (ext === '.html') {
      return fs.readFile(filePath, 'utf8', (readErr, html) => {
        if (readErr) { res.writeHead(404); return res.end('not found'); }
        const body = Buffer.from(html.split('%ORIGIN%').join(origin), 'utf8');
        res.writeHead(200, { ...headers, 'Content-Length': body.length });
        res.end(method === 'HEAD' ? undefined : body);
      });
    }

    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    if (method === 'HEAD') return res.end(); // headers only, no body
    return fs.createReadStream(filePath).pipe(res);
  });
}
