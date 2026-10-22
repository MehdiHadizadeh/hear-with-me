# Keystores

`test.keystore` signs the **test builds** CI makes on every push, so one test
APK installs over the previous one. Like Android's own debug keystore, it is
public on purpose (alias `androiddebugkey`, password `android`) and must never
sign a build meant for a store.

Release builds are signed with a key that lives only in the repository's
Actions secrets — see `.github/workflows/app.yml` and the app README.
