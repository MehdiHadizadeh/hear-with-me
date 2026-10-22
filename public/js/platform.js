// What this device can do, decided once and in one place.
//
// Everything platform-shaped in the app asks here instead of sniffing on its
// own. That is also the seam an app shell (Capacitor, for Android and later
// iPhone) would replace: a native host can capture what a browser cannot, and
// it says so by answering these questions differently.

const ua = navigator.userAgent || '';

// Inside the Android or iPhone app (Capacitor), the page runs in a WebView
// with a native bridge beside it. `SystemAudio` is the app's own plugin
// (app/android/.../SystemAudioPlugin.java).
const capacitor = window.Capacitor;
export const isNativeApp = !!(capacitor && capacitor.isNativePlatform && capacitor.isNativePlatform());
export const nativePlatform = isNativeApp ? capacitor.getPlatform() : null;
export const nativeAudio = isNativeApp
  ? (capacitor.registerPlugin ? capacitor.registerPlugin('SystemAudio') : (capacitor.Plugins || {}).SystemAudio) || null
  : null;

// iPadOS reports itself as a Mac; touch points give it away.
export const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/.test(ua);

// Guests are overwhelmingly on a phone, and a few choices only earn their
// space there.
export const isTouchDevice = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

export const platformName = isIOS ? 'ios' : isAndroid ? 'android' : isTouchDevice ? 'other' : 'desktop';

// Capturing another tab's or app's sound: desktop Chrome and Edge, or the
// Android app (Android 10+, checked when the host asks). Phone browsers either
// lack getDisplayMedia or return no audio track from it (iOS 27 shows the
// picker and hands back video alone), so a phone browser is never offered
// something that will fail after a permission prompt.
export const canCaptureNativeAudio = nativePlatform === 'android' && !!nativeAudio;
export const canCaptureSystemAudio = canCaptureNativeAudio || (!!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)
  && !isIOS && !isAndroid && !isTouchDevice);

// Playing a file from this device into the room works anywhere Web Audio can
// turn an <audio> element into a stream.
export const canShareFile = !!(window.AudioContext || window.webkitAudioContext)
  && typeof (window.AudioContext || window.webkitAudioContext).prototype.createMediaStreamDestination === 'function';

// Whether this browser can play the screen-off stream in a plain <audio>.
export function canPlayRelay(format) {
  if (!format) return false;
  const probe = document.createElement('audio');
  if (format === 'aac') return probe.canPlayType('audio/aac') !== '' || probe.canPlayType('audio/mp4; codecs="mp4a.40.2"') !== '';
  if (format === 'webm') return probe.canPlayType('audio/webm; codecs="opus"') !== '';
  return false;
}

// Where the screen-off path should be the default: anything that a pocket or
// a lock screen will suspend.
export const prefersScreenOff = isTouchDevice || isIOS || isAndroid;
