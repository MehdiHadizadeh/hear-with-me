# Hear With Me: the Android app

The site's own client in a native shell (Capacitor 8), plus the one thing only
an app can do on a phone: **host what other apps play** (Telegram, YouTube,
podcasts and so on). Android 10 or newer. Apps that refuse capture, Spotify and
SoundCloud among them, stay silent.

There is no iPhone app. iPhones use the website: listening works in the
browser, and hosting from an iPhone is limited to a file on the phone.

| | Android app | Phone browser |
|---|---|---|
| Listen with the screen locked | yes (a media notification keeps it alive) | yes, on the screen-off path |
| Host from a file on the phone | yes | yes |
| Host what other apps play | **yes** | no |

Hosting works like a desktop host on the screen-off path: the app captures
playback (`MediaProjection` + `AudioPlaybackCapture`), encodes AAC with
`MediaCodec` and posts it to the room's relay. Guests hear it a couple of
seconds late, on any phone, with the screen off. When an app refuses capture,
the host page says the share is silent.

## Getting it

Every push builds the APK in GitHub Actions (`.github/workflows/app.yml`):
the `android-apk` artifact, or the APK attached to a release. Install it
directly (allow "install unknown apps" for your browser or file manager).
Builds from `main` and version tags open hearwithme.ir; builds from other
branches open the staging deployment.

Files are named after the version: `HearWithMe-0.6.2.apk` from a release tag,
`HearWithMe-0.6.2-dev21.apk` from any other build.

Tag a version to publish a release with the APK attached:

```bash
git tag v0.6.2 && git push origin v0.6.2
```

## Signing for real

CI signs with the public test key in `android/keystores/` unless the
repository has these Actions secrets, in which case it signs with them:

| Secret | |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the release keystore, base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | its passwords and alias |

Make the keystore once and keep it safe. Every update must be signed with it:

```bash
keytool -genkeypair -v -keystore release.keystore -alias hearwithme -keyalg RSA -keysize 2048 -validity 10000
```

## Working on it

```bash
cd app
npm install
npx cap sync android    # after changing capacitor.config.json or www/
npx cap open android    # Android Studio
node tools/make-icons.mjs   # icons and splash, from the site's mark
```

The app loads the live site (`server.url`), so web changes reach it without a
new build. A new build is only needed for native changes.
