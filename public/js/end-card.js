// The end of a listen. The person who received the link is the next person
// who sends one, but most guests are on a phone, where they cannot host what
// they hear. So the card saves the intent ("send this to my computer")
// instead of asking for something they cannot do right now.

import { show } from './dom.js';
import { canCaptureSystemAudio } from './platform.js';
import { formatClock } from './format.js';
import { report } from './metrics.js';

function landingUrl() {
  const url = new URL('/', window.location.origin);
  url.searchParams.set('ref', 'guest');
  return url.toString();
}

async function shareOrCopy({ title, text, url }, notices) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    notices.showInfo('لینک کپی شد. تو پیام‌رسانت برای خودت بفرستش (مثلاً Saved Messages) و روی کامپیوتر بازش کن.');
  } catch (e) {
    notices.showInfo(`این لینک رو روی کامپیوترت باز کن: ${url}`);
  }
}

export function createEndCard({ ui, notices }) {
  ui.sendToSelfBtn.addEventListener('click', () => {
    report('send-to-self');
    shareOrCopy({
      title: 'Hear With Me',
      text: 'روی کامپیوترت بازش کن تا هرچی گوش می‌دی رو برای یکی دیگه پخش کنی.',
      url: landingUrl(),
    }, notices);
  });

  return {
    // Only worth showing after a real listen: a guest who heard nothing has
    // nothing to remember.
    show(ms, hostName) {
      ui.endDuration.textContent = `${formatClock(ms)} با هم شنیدید`;
      // Says what this person can do next from where they are sitting, not
      // where the host was, which the page never really knows.
      ui.endTitle.textContent = hostName
        ? `این رو ${hostName} برات پخش می‌کرد. تو هم می‌تونی برای یکی پخش کنی.`
        : 'تو هم می‌تونی برای یکی پخش کنی.';
      if (canCaptureSystemAudio) {
        ui.endSub.textContent = 'هرچی روی همین کامپیوتر گوش می‌دی رو با یه لینک برای هرکی خواستی پخش کن.';
        show(ui.sendToSelfBtn, false);
        ui.hostFromPhoneLink.className = 'btn btn-primary btn-link';
        ui.hostFromPhoneLink.textContent = 'ساخت اتاق خودم';
      } else {
        ui.endSub.textContent = 'روی کامپیوترت هرچی گوش می‌دی رو پخش کن، یا همین الان یه فایل از گوشیت.';
        show(ui.sendToSelfBtn, true, 'flex');
        ui.hostFromPhoneLink.className = 'btn btn-secondary btn-link';
        ui.hostFromPhoneLink.textContent = 'پخش یه فایل از گوشیم';
      }
      show(ui.endCard, true);
    },
    hide() { show(ui.endCard, false); },
  };
}
