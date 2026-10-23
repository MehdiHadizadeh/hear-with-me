# Hear With Me — the app

The site's own client, in a native shell (Capacitor 8), plus the two things
only an app can do:

| | Android | iPhone |
|---|---|---|
| Listen with the screen locked | yes (a media notification keeps it alive) | yes (background audio mode) |
| Host from a file on the phone | yes | yes |
| **Host what other apps play** (Telegram, YouTube, podcasts…) | **yes**, Android 10+ — except apps that refuse capture, Spotify and SoundCloud among them | no — needs a ReplayKit extension and a paid Apple developer account |

Hosting on Android works like a desktop host on the screen-off path: the app
captures playback (`MediaProjection` + `AudioPlaybackCapture`), encodes AAC
with `MediaCodec` and posts it to the room's relay. Guests hear it a couple of
seconds late, on any phone, with the screen off. Some apps refuse capture
(often video and DRM'd music); the host page then says the share is silent.

## Getting it

Every push builds both in GitHub Actions (`.github/workflows/app.yml`):

- **Android:** the `android-apk` artifact, or the APK attached to a release.
  Install it directly (allow "install unknown apps" for your browser or file
  manager). Builds from `main` and version tags open hearwithme.ir; builds
  from other branches open the staging deployment.
- **iPhone:** `…-unsigned.ipa` in the `ios-builds` artifact. Without an Apple
  developer account it cannot be signed in CI. With a Mac, build and install
  it from Xcode instead — step by step in [docs/iphone-on-mac.md](../docs/iphone-on-mac.md).
  `…-simulator.zip` runs in the iOS Simulator on a Mac (same guide).

Files are named after the version: `HearWithMe-0.6.1.apk` from a release tag,
`HearWithMe-0.6.1-dev21.apk` from any other build.

Tag a version to publish a release with both attached:

```bash
git tag v0.6.1 && git push origin v0.6.1
```

## Signing for real

CI signs with the public test key in `android/keystores/` unless the
repository has these Actions secrets, in which case it signs with them:

| Secret | |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the release keystore, base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` · `ANDROID_KEY_ALIAS` · `ANDROID_KEY_PASSWORD` | its passwords and alias |

Make the keystore once and keep it safe — every update must be signed with it:

```bash
keytool -genkeypair -v -keystore release.keystore -alias hearwithme -keyalg RSA -keysize 2048 -validity 10000
```

For the App Store or TestFlight: an Apple developer account, then signing in
the `ios` job.

## Working on it

```bash
cd app
npm install
npx cap sync            # after changing capacitor.config.json or www/
npx cap open android    # Android Studio
npx cap open ios        # Xcode (macOS)
node tools/make-icons.mjs   # icons and splash, from the site's mark
```

The app loads the live site (`server.url`), so web changes reach it without a
new build; a new build is only needed for native changes.
