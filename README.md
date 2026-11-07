# Test Explorer for Unity

Run Unity Edit Mode and Play Mode tests from the VS Code Testing tab, with failure messages, stack traces and links to the failing line.

Tests normally freeze the Unity Editor while they run. This extension gives the Editor time between Edit Mode tests, so it stays usable, though jerky. If you need it fully free, there's an optional [background worker](#the-background-worker).

> This is an independent project. It isn't affiliated with or endorsed by Unity Technologies.

## Getting started

1. Open your Unity project's folder in VS Code, with the project also open in Unity.
2. Open the Testing tab. When asked, choose **Install** to add the bridge package.
3. Switch to Unity so it can import the package, then press refresh in the Testing tab.

The bridge is a small Editor-only package at `Packages/com.dancra.vscode-test-bridge`. It isn't included in player builds. Commit it so that everyone on your team has it.

**Requirements:** Unity 2021.3 or later, the Unity Test Framework package, and VS Code 1.90 or later.

| Platform | Status |
| --- | --- |
| Windows | Tested |
| macOS, Linux | Experimental: written to work, but not tested yet. Bug reports are welcome. |

## Running tests

Click run on a class or test to run it in your open Editor. Each run first imports the changes you've saved, so unsaved edits in VS Code aren't included.

### How the Editor behaves during a run

Between Edit Mode tests, the Editor gets at least one frame, and up to 100 ms more after slower tests. This makes a run take slightly longer. You can click around and use the Editor, but expect it to be jerky:

- A single test can't be interrupted, so a slow test stalls the Editor until it finishes. Before running a test that took 10 s or more last time, or an `[Explicit]` test that hasn't run yet, the extension asks first.
- Cancelling takes effect once the current test finishes. Until then the run stays open and says so, rather than showing as cancelled while Unity keeps going.
- You can't compile or enter Play Mode until the run ends.
- Play Mode tests already run across frames, so they aren't changed.
- Runs started from Unity's own Test Runner window aren't changed either.

This relies on a private part of the Test Framework. If a future version changes it, tests still run normally, but the Editor freezes during them as usual.

Runs in the open Editor are refused during Play Mode, with compile errors, or with unsaved open scenes, because each of those would make the run fail or block the Editor.

Test Framework 1.1, which Unity 2021.3 and 2022.3 can come with, can't cancel a run. In the open Editor, the run keeps going until it finishes.

## The background worker

This is optional and off by default. It runs tests in a headless Unity on its own copy of your project, so you can keep working in the Editor, including compiling and entering Play Mode. The cost is a folder next to your project, roughly the same size as the project.

To use it, turn on the `unityTests.enableWorker` setting. Run All, anything above class level, or more than 500 tests then ask where to run. To use the worker for a smaller run, right-click it and choose **Execute Using Profile...**. Cancelling always works in the worker.

The worker keeps a one-way copy of your project in a folder named `<project>-TestWorker`.

- Each run copies `Assets`, `Packages` and `ProjectSettings`. Nothing is ever written back to your project.
- Anything you change in the worker folder is overwritten by the next run.
- The first run also copies `Library` and may need to compile, so it takes longer and uses about as much disk as your project.
- It needs about 4 GB of free memory, and only one worker can run at a time.

**Things to know:**

- Each run tests what's saved on disk when it starts.
- The worker shares `Application.persistentDataPath` with your Editor, because the company and product names are the same. Unity overwrites `TestResults.xml` there, and tests that write save files there will affect the Editor's copy too.
- Packages can open windows even in batch mode. The bridge closes any window that doesn't come from Unity itself and logs a warning to `WorkerState/unity.log`. A window could still flash briefly, so leave out any package that does this.

### Project settings

Add a `.unity-test-worker.json` file to your project's root if the worker needs either of these:

```json
{
  "excludePackages": ["com.example.package-with-popups"],
  "extraFiles": ["Tools/data-my-tests-read.csv"]
}
```

- **`excludePackages`**: packages to leave out of the worker's copy.
- **`extraFiles`**: files outside `Assets`, `Packages` and `ProjectSettings` that your tests read, relative to the project root.

## Command line

The worker can also run from a terminal or CI script, or by a coding agent, whatever the setting says. This creates the worker folder too:

```shell
npm install --global github:dancraa/unity-test-explorer

unity-tests                           # every test
unity-tests Game.Tests.PlayerTests    # named classes or tests
unity-tests --mode play Game.Tests.X  # look for the names in Play Mode tests only
unity-tests --project path/to/project
unity-tests --install-bridge
```

It exits with 0 if all tests passed, 1 if any failed, and 2 if the run itself failed. The first run has to happen while the project is open in Unity, which is how the worker finds your Unity install. After that it also works with Unity closed.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `unityTests.enableWorker` | `false` | Adds **Run in Worker**. It keeps a copy of your project next to it. |
| `unityTests.maxTestsPerRun` | `500` | With the worker enabled, ask where to run when a run has more tests than this. `0` removes the limit. |
| `unityTests.slowTestSeconds` | `10` | Ask before running a test in the open Editor if it took at least this long last time. `[Explicit]` tests ask until they've run once. `0` asks only for `[Explicit]` tests. |
| `unityTests.sourceGlob` | empty | Files searched to link tests to their source. Empty finds them from your test assembly definitions. |

## How it works

The bridge runs inside Unity and exchanges small files with the extension through `Library/VsCodeTests`. The extension asks it for the test list and tells it what to run, and the bridge reports each result as it finishes. Commands wait on disk, so they survive the domain reloads Unity does when compiling or entering Play Mode.

## Development

```shell
npm test                                                    # logic tests
node test/integration.js <unity executable> <empty folder>  # full test against a real Unity
npm run package                                             # build the .vsix
```

## License

[MIT](LICENSE)
