// Car mode: what a phone on a dashboard can safely show. One name, one state
// in words and colour, and one button big enough to hit without looking.
// Everything else is the lock screen's job — the screen-off path gives the
// OS a real media notification to put there.

export function createCarMode({ ui, guest }) {
  let open = false;

  function render(state) {
    ui.carState.textContent = state.text;
    ui.carState.dataset.tone = state.tone;
  }

  function enter() {
    open = true;
    ui.carMode.hidden = false;
    ui.carPlayBtn.focus();
    // Fullscreen where allowed: nothing else on the page matters here.
    if (ui.carMode.requestFullscreen) ui.carMode.requestFullscreen().catch(() => {});
  }

  function exit() {
    open = false;
    ui.carMode.hidden = true;
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    ui.carModeBtn.focus();
  }

  ui.carModeBtn.addEventListener('click', enter);
  ui.carExitBtn.addEventListener('click', exit);
  ui.carPlayBtn.addEventListener('click', () => guest.setMuted(!guest.muted));
  document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') exit(); });

  return {
    setTitle(text) { ui.carTitle.textContent = text; },
    // Mirrors the stage: "live", "connecting", "stopped"...
    setState(stageState) {
      const states = {
        live: { text: 'زنده', tone: 'live' },
        connecting: { text: 'در حال وصل شدن', tone: 'connect' },
        waiting: { text: 'در انتظار میزبان', tone: 'wait' },
        dropped: { text: 'قطع شد، دوباره وصل می‌شه', tone: 'alert' },
        stopped: { text: 'پخش تموم شد', tone: 'idle' },
      };
      render(states[stageState] || states.waiting);
    },
  };
}
