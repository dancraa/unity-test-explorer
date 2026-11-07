# Changelog

## 0.3.1

- Tests now list while Unity is in Play Mode, so the Testing tab isn't empty after reloading VS Code mid-playtest. Listing in Play Mode skips the asset refresh, which could recompile and end the session. Runs are still refused until you exit Play Mode. Update the bridge package when prompted.
- If Unity refuses to list the tests, the reason is shown instead of an empty tab.

## 0.3.0

- Asks before running slow tests in the open Editor: any test that took 10 s or more last time (`unityTests.slowTestSeconds`), and `[Explicit]` tests until they've run once. With the worker enabled, you can send them there instead.
- Cancelling in the open Editor no longer shows the run as cancelled while Unity is still inside a test. The run stays open, says it stops once the current test finishes, and ends when Unity confirms. Update the bridge package when prompted.

## 0.2.1

- The background worker is now optional and off by default. Turn on `unityTests.enableWorker` to use it. Without it, large runs start in the Editor straight away, and the extension never creates a copy of your project.

## 0.2.0

- Keeps the Editor usable during Edit Mode runs in the open Editor, by giving it time between tests. It's jerky rather than frozen, and runs take slightly longer. Update the bridge package when prompted.
- Adds an icon.

## 0.1.0

First release.

- Lists and runs Unity Edit Mode and Play Mode tests from the VS Code Testing tab.
- Shows failure messages and stack traces, and links tests and failures to their source.
- Background worker that runs tests on a one-way copy of the project and keeps the Editor free.
- `unity-tests` command for terminals, CI scripts and coding agents.
