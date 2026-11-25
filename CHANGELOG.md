# Changelog

## 0.4.0

Most of this is for the `unity-tests` command. Update the bridge package when prompted.

Fixed:

- A name that matches no test is now an error (exit code 3) instead of a successful run of zero tests. Each name is checked, so a valid one can't hide a misspelled one.
- Class names and `Class.Method` work without the namespace. A name that matches several things lists them, and one that matches nothing suggests the closest.
- `--mode edit` or `--mode play` without names runs only that mode.
- Unknown options are rejected instead of being treated as test names.
- Inconclusive tests exit with 1, and a test that should have run but reported nothing exits with 2.
- An edit of the same size, saved within 2 seconds of the version last synced, is no longer missed by the worker.
- On Windows, failures from **Run in Worker** link to their source.
- Killing `unity-tests` or VS Code no longer leaves the worker's Unity running and blocking the next run.

Added:

- `--check` syncs and compiles only, `--list` finds tests, `--failed` reruns the last run's failures, `--wait` queues behind a running worker or for memory, `--stop` ends one, `--timeout` limits a run, and `--version` prints the version.
- `--json` and `--junit <file>`.
- `separateSaves` in `.unity-test-worker.json` keeps the worker's saves and `PlayerPrefs` apart from the Editor's.
- A run that's stopped or times out names the test it was in, and a busy worker says who started the run and when.
- Each run says how many files it synced and how many tests matched. Failures print as they happen, progress shows during the run, and the slowest tests are listed at the end.
- Long failure messages and logs are shortened unless you pass `--verbose`.
- A warning when the project's bridge and `unity-tests` are different versions. The worker now always uses the bridge that came with the command or extension that started it.

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
