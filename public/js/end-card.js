// The end of a listen, and the one moment a guest is free to do something
// else with this product: take it to their own computer, or post that it
// happened.
//
// Calendly's lesson: the person who received the link is the next person who
// sends one. Most guests are on a phone, where they cannot host what they hear
// — so the end card saves the intent ("send this to my computer") rather than
// asking for something they cannot do right now.

import { show } from './dom.js';
import { formatClock } from './format.js';
import { report } from './metrics.js';

const W = 1080;
const H = 1920;

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

// A 9:16 card drawn from the product's own material: the two strands, the
// time spent listening, and the signature line. No names: whoever posts it
// adds their own.
function drawStory(ms) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const c = canvas.getContext('2d');

  c.fillStyle = '#070910';
  c.fillRect(0, 0, W, H);
  const glow = (x, y, r, color) => {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(7,9,16,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
  };
  glow(W * 0.5, H * 0.34, 760, 'rgba(63,224,190,0.16)');
  glow(W * 0.5, H * 0.86, 820, 'rgba(140,124,255,0.18)');

  // The two strands, wide, running behind everything.
  const strand = (y, color, phase, alpha) => {
    c.beginPath();
    for (let x = -20; x <= W + 20; x += 6) {
      const yy = y + Math.sin(x / 150 + phase) * 70 + Math.sin(x / 61 + phase * 1.7) * 12;
      if (x === -20) c.moveTo(x, yy); else c.lineTo(x, yy);
    }
    c.strokeStyle = color;
    c.globalAlpha = alpha;
    c.lineWidth = 9;
    c.lineCap = 'round';
    c.stroke();
    c.globalAlpha = 1;
  };
  strand(H * 0.62, '#3FE0BE', 0, 0.9);
  strand(H * 0.62 + 46, '#8C7CFF', 1.1, 0.75);

  const font = (weight, size) => `${weight} ${size}px Vazirmatn, system-ui, sans-serif`;
  c.textAlign = 'center';
  c.direction = 'rtl';

  c.fillStyle = '#9BA5C0';
  c.font = font(500, 48);
  c.fillText('امشب با هم شنیدیم', W / 2, H * 0.3);

  c.direction = 'ltr';
  c.fillStyle = '#E9ECF5';
  c.font = font(900, 210);
  c.fillText(formatClock(ms), W / 2, H * 0.3 + 230);

  c.direction = 'rtl';
  c.fillStyle = '#3FE0BE';
  c.font = font(700, 56);
  c.fillText('همین صدا، همین لحظه.', W / 2, H * 0.82);

  c.direction = 'ltr';
  c.fillStyle = '#7A849E';
  c.font = font(500, 40);
  c.fillText('hearwithme.ir', W / 2, H * 0.9);
  return canvas;
}

export function createEndCard({ ui, notices }) {
  let listenedMs = 0;

  ui.sendToSelfBtn.addEventListener('click', () => {
    report('send-to-self');
    shareOrCopy({
      title: 'Hear With Me',
      text: 'روی کامپیوترت بازش کن تا هرچی گوش می‌دی رو برای یکی دیگه پخش کنی.',
      url: landingUrl(),
    }, notices);
  });

  ui.storyBtn.addEventListener('click', async () => {
    report('story-card');
    // The font has to be in before the canvas draws with it.
    try { await document.fonts.load('900 100px Vazirmatn'); } catch (e) { /* system font then */ }
    const canvas = drawStory(listenedMs);
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const file = new File([blob], 'hear-with-me.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file] }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
      }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'hear-with-me.png';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 4000);
    }, 'image/png');
  });

  return {
    // Only worth showing after a real listen: a guest who heard nothing has
    // nothing to remember.
    show(ms, hostName) {
      listenedMs = ms;
      ui.endDuration.textContent = `${formatClock(ms)} با هم شنیدید`;
      ui.endTitle.textContent = hostName
        ? `این صدا از کامپیوتر ${hostName} می‌اومد. تو هم می‌تونی.`
        : 'این صدا از کامپیوتر یه نفر می‌اومد. تو هم می‌تونی.';
      show(ui.endCard, true);
    },
    hide() { show(ui.endCard, false); },
  };
}
