# Android app

The Android app is the same Vue/Ionic web app wrapped with **Capacitor 8** (`frontend/capacitor.config.ts`,
project in `frontend/android/`). It uses the same API, sign-in and permissions as the web app.

## Download a test APK

1. Open the repository on GitHub → **Actions** → **Android APK**.
2. Open the latest green run (or **Run workflow** to start one; you can enter the API address).
3. Under **Artifacts**, download `silent-handover-test-apk` and unzip it.
4. On the phone, allow installing from your browser or file manager, then open the `.apk`.

The APK is a **test build** signed with the Android debug key. Uninstall it before installing a
release build later (the signatures differ).

## Which server it uses

- The address built in: the workflow input `api_url`, else the repository variable
  **`ANDROID_API_URL`** (Settings → Secrets and variables → Actions → Variables).
- If none is built in, or the server can't be reached, the app shows **Server address**. Enter the
  API's `https://` address. Plain `http://` is refused.
- The API must allow the app's origin. Add `https://localhost` to `CORS_ORIGINS` on the API, for
  example `CORS_ORIGINS=https://silenthandover.vercel.app,https://localhost`.

## Accounts, invitations and password resets

Invitation and reset emails link to the **web** address (`APP_BASE_URL`). People choose their
password in the browser and then sign in in the app. Android App Links (opening those links
directly in the app) need a verified domain and are not set up.

## Phone behaviour

- **Back button:** closes an open dialog or menu first, then goes back a page. From a start page
  (Today, For approval, User accounts, sign-in) it leaves the app.
- Safe areas and the status bar are handled by Ionic and the StatusBar plugin.
- **Offline:** a notice appears at the bottom. Typed text stays on the page, and endorsement drafts
  are also kept on the device.
- **Sessions:** the sign-in token is stored in the app's private WebView storage, which other apps
  can't read. It expires like on the web. A Keystore-backed secure store is a later improvement.
- **Permissions:** the app asks for none at install. Taking a photo uses the system file and camera
  picker only when someone attaches a photo.

## Release builds (not set up)

A store or production APK/AAB needs:
1. A release keystore created once and kept safe; its base64 copy, password and alias go in
   GitHub **Secrets** (`ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
   `ANDROID_KEY_PASSWORD`).
2. A **protected environment** (Settings → Environments → `release`) with required reviewers, so
   only an approved run can sign.
3. A separate workflow on `v*` tags running `./gradlew bundleRelease` with those secrets.

## Versions

| Tool | Version |
|---|---|
| Capacitor (core, android, cli) | 8.6.0 |
| Node in CI | 22 (Capacitor 8 needs 22+) |
| JDK in CI | Temurin 21 |
| Android Gradle Plugin / Gradle | 8.13.0 / 8.14.3 (from the generated project) |
| compile / target SDK | 36; minimum SDK 24 |
