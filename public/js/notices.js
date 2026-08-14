// Everything the room says to the person in front of it, in three shapes.
//
//   notice — one banner, stays until read or dismissed. For state changes and
//            failures: things that are still true a minute from now.
//   toast  — a line floating over the viewport, for events. Fixed to the
//            screen and not to the page: parked in the flow above the cards,
//            these were delivered off-screen to any host who had scrolled.
//   burst  — a cheer rising over the stage. Needs no reply, leaves no trace.

const NOTICE_INFO_LIFE_MS = 15000;
const TOAST_LIFE_MS = 3600;
const TOAST_ACTIONABLE_LIFE_MS = 9000; // something to act on earns a longer look
const TOAST_FADE_MS = 400;
const BURST_LIFE_MS = 2400;
const BURST_SPREAD_PX = 90; // so three hearts in a row don't stack into one

export function createNotices(ui) {
  let noticeTimer = null;

  function hideNotice() {
    clearTimeout(noticeTimer);
    ui.notice.classList.remove('show');
  }

  function showNotice(message, tone = 'alert') {
    clearTimeout(noticeTimer);
    ui.noticeText.textContent = message;
    ui.notice.classList.toggle('notice-alert', tone !== 'info');
    ui.notice.classList.add('show');
    // Something that merely changed clears itself once it has been read;
    // something that went wrong waits for the reader.
    if (tone === 'info') noticeTimer = setTimeout(hideNotice, NOTICE_INFO_LIFE_MS);
  }

  ui.noticeClose.addEventListener('click', hideNotice);

  function showToast(text, options = {}) {
    const el = document.createElement('div');
    el.className = `toast${options.alert ? ' toast-alert' : ''}`;

    if (options.emoji) {
      const badge = document.createElement('span');
      badge.className = 'toast-emoji';
      badge.textContent = options.emoji;
      el.appendChild(badge);
    }

    const body = document.createElement('span');
    body.className = 'toast-body';
    if (options.who) {
      const who = document.createElement('b');
      who.textContent = options.who; // a name a guest typed: never as markup
      body.append(who, document.createTextNode(' '));
    }
    body.appendChild(document.createTextNode(text));
    if (options.todo) {
      const todo = document.createElement('span');
      todo.className = 'toast-todo';
      todo.textContent = options.todo;
      body.appendChild(todo);
    }
    el.appendChild(body);

    ui.toasts.appendChild(el);
    const life = options.todo ? TOAST_ACTIONABLE_LIFE_MS : TOAST_LIFE_MS;
    setTimeout(() => el.classList.add('leaving'), life);
    setTimeout(() => el.remove(), life + TOAST_FADE_MS);
  }

  function showBurst(emoji, layer) {
    if (!layer) return;
    const el = document.createElement('span');
    el.textContent = emoji;
    el.style.setProperty('--x', `${Math.round((Math.random() - 0.5) * BURST_SPREAD_PX)}px`);
    layer.appendChild(el);
    setTimeout(() => el.remove(), BURST_LIFE_MS);
  }

  return {
    showNotice,
    hideNotice,
    showError: (message) => showNotice(message, 'alert'),
    showInfo: (message) => showNotice(message, 'info'),
    showToast,
    showBurst,
  };
}
