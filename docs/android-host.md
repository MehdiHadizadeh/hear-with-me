# A phone that hosts: the Android app, designed

Status: design only. Nothing here is built yet; the tooling (Android SDK,
a signing key) was not available when this was written.

## Why an app at all

No phone browser hands a page another app's sound: Chrome, Samsung Internet
and Firefox on Android have no `getDisplayMedia`, and iOS 27's returns video
only. A phone can host a **file** from the web page today; to host **what is
playing** (Spotify, YouTube, Telegram voice messages) it needs native code.

Android 10+ allows it: `MediaProjection` plus `AudioPlaybackCapture`.

## The shortcut: the app does not need WebRTC

The screen-off path already carries a host's sound through the server as AAC
(ADTS frames, posted a quarter second at a time). Android encodes AAC in
hardware with `MediaCodec`, and ADTS is seven bytes of header per frame. So a
native host can feed the **same relay endpoint** a browser host feeds:

```
AudioPlaybackCapture ─► AudioRecord (PCM 48k stereo)
        ─► MediaCodec (AAC-LC, 128 kbps CBR) ─► + ADTS header per frame
        ─► POST /api/rooms/{code}/relay?gen=…&seq=…   (X-HWM-Client / X-HWM-Secret)
```

Every guest then listens on the screen-off path — about two seconds late,
playing on a locked phone, crossing networks without UDP. No libwebrtc, no
signaling code in Kotlin, and no change to any guest or to either server. The
direct path can come later if anyone misses the lower delay.

## Shape of the app

A **Capacitor** shell around the existing web client:

- The web UI runs unchanged in the WebView: joining, the roster, reactions,
  the link to share. `public/js/platform.js` is the seam — in the shell it
  reports `canCaptureSystemAudio = true` and routes "start sharing" to the
  native plugin instead of `getDisplayMedia`.
- One native plugin, `SystemAudio`, with `start({ roomId, clientId, secret,
  origin })`, `stop()`, and events `level` (for the meter) and `ended`.
- The page calls `/sharing` with `relayFormat: 'aac', source: 'app'` (add
  `'app'` to `SHARE_SOURCES` and the metrics allowlist), and sets the room to
  relay-only for its guests.

## What Android will insist on

| | |
|---|---|
| Consent | `createScreenCaptureIntent()` every session (Android 14+: a token is single-use). |
| Foreground service | Types `mediaProjection` **and** `microphone`, started after consent, with a persistent notification. |
| Screen lock | From Android 15 QPR1 capture stops when the screen locks: the host's screen stays on (a wake lock while sharing). |
| Silent apps | Apps can refuse capture (`allowAudioPlaybackCapture="false"`). Detect silence and say "this app does not allow its sound to be shared" rather than streaming nothing. |
| Store | Google Play asks for a demo video of the foreground-service use; an APK or Cafe Bazaar avoids that. |

## Effort

Roughly two weeks for the relay-only MVP (capture service, AAC framing,
uploader, plugin bridge), plus a week on real devices: Samsung One UI, Xiaomi
HyperOS, a Pixel. The worth-it test before starting: whether the counters
show many people pressing "create room" from a phone.

## iPhone, for when there is an Apple developer account

The same shell builds for iOS. Two things it would add: background audio for
guests on the direct path (`UIBackgroundModes: audio`), and hosting through a
ReplayKit broadcast extension encoding AAC to the same relay — knowing that
Apple Music and other DRM'd audio come out silent.
