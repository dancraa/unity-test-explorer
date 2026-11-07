# Changelog

## 0.2.0

- Keeps the Editor usable during Edit Mode runs in the open Editor, by giving it time between tests. It's jerky rather than frozen, and runs take slightly longer. Update the bridge package when prompted.
- Adds an icon.

## 0.1.0

First release.

- Lists and runs Unity Edit Mode and Play Mode tests from the VS Code Testing tab.
- Shows failure messages and stack traces, and links tests and failures to their source.
- Background worker that runs tests on a one-way copy of the project and keeps the Editor free.
- `unity-tests` command for terminals, CI scripts and coding agents.
