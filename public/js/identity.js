// Who we are inside one room.
//
// A public id plus a secret that proves POSTs are really ours — the id alone
// travels in signaling messages, so it proves nothing. Kept in sessionStorage
// (per tab, cleared when the tab closes) so reloading resumes the same
// membership instead of abandoning it, which for a host means not losing the
// room to a guest.

const randomId = () => (crypto.randomUUID
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random()}-${Math.random()}`);

export function loadIdentity(roomId) {
  const key = `hwm-identity:${roomId}`;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (saved && saved.clientId && saved.secret) return saved;
  } catch (e) { /* unusable storage; fall through to a fresh identity */ }

  const fresh = { clientId: randomId(), secret: randomId() };
  try { sessionStorage.setItem(key, JSON.stringify(fresh)); } catch (e) { /* private mode */ }
  return fresh;
}
