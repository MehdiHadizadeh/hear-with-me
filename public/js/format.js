// Turning numbers into Persian text. The page is RTL/fa, so a bare `${n}`
// renders Latin digits next to Persian words.

export const faDigits = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);

export function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return faDigits(hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`);
}

// How the host tells two nameless guests apart.
export function joinedAgo(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'همین الان اومد';
  if (minutes < 60) return `${faDigits(minutes)} دقیقه پیش اومد`;
  return `${faDigits(Math.floor(minutes / 60))} ساعت پیش اومد`;
}

export function listenerLabel(memberCount) {
  // The host is in the count but is not a listener, and "۱ نفر" while you sit
  // alone in your own room reads as though someone arrived.
  const guests = Math.max(0, memberCount - 1);
  return { guests, text: guests === 0 ? 'هنوز کسی نیومده' : `${faDigits(guests)} مهمان` };
}
