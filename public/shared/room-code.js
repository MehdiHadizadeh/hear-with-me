// What a room code is, defined once for both sides.
//
// The server generates them and the landing page validates them; when the
// alphabet lived in two files, the page could refuse a code the server had
// just handed out.

// No characters that get misread out loud or misheard over a phone: no O/0,
// no I/1, no S/5.
export const ALPHABET = '346789ABCDEFGHJKLMNPQRTUVWXYZ';
export const LENGTH = 6;

// People paste the whole invite link at least as often as they type the code,
// and a stray space used to become a room code that could not exist.
export function normalizeCode(raw) {
  const text = String(raw == null ? '' : raw).trim();
  const fromLink = text.match(/\/r\/([^/?#\s]+)/i);
  return (fromLink ? fromLink[1] : text).toUpperCase().replace(/[\s\-_.]/g, '');
}

export function isValidCode(code) {
  return typeof code === 'string'
    && code.length === LENGTH
    && [...code].every((c) => ALPHABET.includes(c));
}
