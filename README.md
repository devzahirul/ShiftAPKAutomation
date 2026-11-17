# Shift Play

Run Shift from the root of an Android Gradle project to sign in with your Google Play Console account, build a signed release, and publish it to internal testing. The menu also shows Production, which is disabled in this version.

## Set up once

1. Install Node.js 22.17 or newer. Set up the JDK and Android SDK required by your Android project.
2. In [Google Cloud Console](https://console.cloud.google.com/), enable the **Google Play Android Developer API**. Configure the OAuth consent screen and create an OAuth client of type **Desktop app**. Download the client JSON and keep it outside source control. If your OAuth consent screen is in Testing mode, add the Google accounts that will use Shift as OAuth test users.
3. In [Google Play Console](https://play.google.com/console/), set up the app, the first artifact, Play App Signing, and internal testing. The Google account you select in the browser needs permission to release that app to testing tracks. Configure tester access in Play Console.
4. Configure Gradle release signing with the app's upload key. Shift invokes your existing Gradle wrapper and signing setup.

[Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app) · [Play Developer API access](https://developers.google.com/android-publisher/getting_started) · [Android command-line builds](https://developer.android.com/build/building-cmdline)

## Release to testing

Clone the repository or extract the release source. Open a terminal in your Android project root and substitute the path to your Shift checkout:

```powershell
node "C:\path\to\ShiftAPKAutomation\shift.mjs" --oauth-client "C:\path\to\client_secret.json"
```

Choose **Testing**, enter your Play package name, and sign in through Google in your browser. Shift runs `:app:bundleRelease` and shows the app, track, output path, and artifact hash. Type `publish` to submit. The CLI reports Play's version code and the release state it can observe. Share the internal testing opt-in link from Play Console with your testers.

You can pass `--package com.example.app --target testing` to skip the first two prompts. For a custom module or variant, pass both `--task` and `--artifact`:

```powershell
node "C:\path\to\ShiftAPKAutomation\shift.mjs" --oauth-client "C:\path\to\client_secret.json" --package com.example.app --target testing --task :app:bundlePaidRelease --artifact app/build/outputs/bundle/paidRelease/app-paid-release.aab
```

For an eligible legacy app that accepts APK uploads, pass `--format apk` to build a single signed APK with `:app:assembleRelease`. New Google Play apps require AABs. For the default `:app` module, Shift expects `app-release.aab` or `app-release.apk` in the standard Gradle release output directory.

Sign-in uses a temporary loopback callback and keeps the Google access token in memory for that run. Close the terminal to end the session. If your build takes long enough for the token to be close to expiry, Shift asks you to sign in again before opening a Play edit.

Run one publisher at a time per app. Coordinate with anyone editing the app in Play Console, since an API commit can submit other pending Console changes for review. If Shift reports an unconfirmed commit, check the version in Play Console before retrying. [Play edit concurrency](https://developers.google.com/android-publisher/concurrency-considerations)

## Develop

```text
node --test
node shift.mjs --help
```
