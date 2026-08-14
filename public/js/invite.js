// Getting the link out of this browser and into someone else's.

import * as QR from '../qr.js';

const CONFIRM_MS = 1600;

export function setupInvite({ ui, roomId, notices }) {
  // Never hand out our own ?debug=1 — that flag exposes the peer connections.
  const inviteUrl = () => {
    const url = new URL(window.location.href);
    url.search = '';
    return url.toString();
  };

  // Copy confirms on the button itself rather than in a toast: the icon turns
  // to the accent colour and the accessible name says it happened.
  function confirmCopied() {
    ui.copyLinkBtn.classList.add('done');
    ui.copyLinkBtn.setAttribute('aria-label', 'لینک کپی شد');
    setTimeout(() => {
      ui.copyLinkBtn.classList.remove('done');
      ui.copyLinkBtn.setAttribute('aria-label', 'کپی لینک دعوت');
    }, CONFIRM_MS);
  }

  const copyFailed = () => notices.showError('کپی کردن لینک ممکن نشد. آدرس رو از نوار مرورگر بردار.');

  ui.copyLinkBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(inviteUrl()).then(confirmCopied, copyFailed);
  });

  // On a phone the invite goes out through the OS share sheet — that is how a
  // link actually reaches Telegram or WhatsApp. Desktop falls back to a copy.
  ui.shareBtn.addEventListener('click', async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Hear With Me',
          text: `بیا با هم گوش کنیم — کد اتاق: ${roomId}`,
          url: inviteUrl(),
        });
      } catch (e) { /* user dismissed */ }
      return;
    }
    navigator.clipboard.writeText(inviteUrl()).then(() => {
      const original = ui.shareBtn.textContent;
      ui.shareBtn.textContent = 'لینک کپی شد ✔';
      setTimeout(() => { ui.shareBtn.textContent = original; }, CONFIRM_MS);
    }, copyFailed);
  });

  // The host is on a desktop, the guest is holding a camera. Rendered on first
  // open rather than on load, because most rooms never need it.
  ui.qrBtn.addEventListener('click', () => {
    const opening = ui.qrPanel.hidden;
    if (opening && !ui.qrCode.firstChild) {
      try {
        ui.qrCode.innerHTML = QR.svg(inviteUrl(), { label: `کد QR اتاق ${roomId}` });
      } catch (e) {
        notices.showError('ساخت کد QR ممکن نشد. لینک رو دستی بفرست.');
        return;
      }
    }
    ui.qrPanel.hidden = !opening;
    ui.qrBtn.setAttribute('aria-expanded', String(opening));
  });

  return { inviteUrl };
}
