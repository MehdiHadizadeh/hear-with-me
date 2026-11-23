// Tells the host about the room when they are not looking at it.
//
// The toasts only reach a host whose screen has this page on it. A host is
// often elsewhere — in the music app they are sharing, in another tab, with
// the phone locked — and that is exactly when someone arriving or reacting
// goes unseen. So while the page is hidden, the same news goes to the system
// instead:
//
//   app  — a native notification from the Android plugin (the WebView has no
//          Notification API of its own).
//   web  — a browser notification, through the service worker where there is
//          one, because phone browsers refuse `new Notification`.
//
// While the page is in front the toasts already say it, so nothing is doubled.

import { isNativeApp, nativeAudio } from './platform.js';

const ICON = '/icon-192.png';

export function createHostAlerts() {
  const webSupported = typeof Notification !== 'undefined';

  // Ask once, from a tap: browsers ignore a permission request that does not
  // follow a gesture, and refuse to ask again after a "no".
  function ask() {
    if (isNativeApp) {
      // Android 13+ asks for notifications when sharing starts; asking here
      // too puts the question in front of someone who only listens-in on
      // their own room from the phone.
      if (nativeAudio && nativeAudio.requestAlertPermission) nativeAudio.requestAlertPermission().catch(() => {});
      return;
    }
    if (!webSupported || Notification.permission !== 'default') return;
    try {
      const result = Notification.requestPermission();
      if (result && result.catch) result.catch(() => {});
    } catch (e) { /* an old browser's callback form, or blocked: carry on without */ }
  }

  async function showWeb(title, body, tag) {
    if (!webSupported || Notification.permission !== 'granted') return;
    const options = { body, tag, icon: ICON, badge: ICON, lang: 'fa', dir: 'rtl', renotify: true };
    try {
      const registration = 'serviceWorker' in navigator
        ? await navigator.serviceWorker.getRegistration()
        : null;
      if (registration && registration.showNotification) {
        await registration.showNotification(title, options);
        return;
      }
      new Notification(title, options); // eslint-disable-line no-new
    } catch (e) { /* the page cannot raise one here: the toast was the best we had */ }
  }

  // `tag` makes a newer notification replace an older one of the same kind
  // instead of stacking a pile for someone who is away for a while.
  function notify({ title, body = '', tag = 'room' }) {
    if (document.visibilityState === 'visible') return;
    if (isNativeApp) {
      if (nativeAudio && nativeAudio.notify) nativeAudio.notify({ title, body, tag }).catch(() => {});
      return;
    }
    showWeb(title, body, tag);
  }

  return { ask, notify };
}
