using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using UnityEditor;
using UnityEditor.TestTools.TestRunner.Api;
using UnityEngine;
using UnityEngine.SceneManagement;
using Debug = UnityEngine.Debug;

namespace VsCodeTests
{
    /// <summary>
    /// Serves the Test Explorer for Unity VS Code extension through files in Library/VsCodeTests.
    /// A pending command stays on disk until handled, so it survives a domain reload.
    /// </summary>
    [InitializeOnLoad]
    public static class VsCodeTestBridge
    {
        private const string WorkerArgument = "-vsCodeTestsWorker";
        private const string OwnerArgument = "-vsCodeTestsOwner";
        private const int OwnerCheckMilliseconds = 1000;
        private const string DataDirectory = "Library/VsCodeTests";
        private const string CommandPath = DataDirectory + "/command.json";
        private const double PollSeconds = 0.25;
        private const int MaxCommandAgeMinutes = 10;

        // SessionState survives the domain reloads a run can cause.
        private const string ActiveRunKey = "VsCodeTests.ActiveRun";
        private const string ActiveGuidKey = "VsCodeTests.ActiveGuid";
        private const string RefreshedKey = "VsCodeTests.Refreshed";
        private const string PendingPlayKey = "VsCodeTests.PendingPlay";
        private const string YieldFramesKey = "VsCodeTests.YieldFrames";
        private const string AwaitingSelectionKey = "VsCodeTests.AwaitingSelection";

        private static TestRunnerApi api;
        private static double nextPoll;
        private static int framesInRun;
        private static bool listedSinceReload;

        // Set only in the headless worker, where the path comes from the command line.
        private static readonly string WorkerDirectory = ReadArgument(WorkerArgument);

        static VsCodeTestBridge()
        {
            api = ScriptableObject.CreateInstance<TestRunnerApi>();
            api.hideFlags = HideFlags.HideAndDontSave;
            api.RegisterCallbacks(new RunCallbacks());
            if (WorkerDirectory == null)
            {
                EditorApplication.update += Poll;
                EditorApplication.update += CountFrame;
                // A reload clears the Test Framework's cache, including during a run.
                if (SessionState.GetBool(YieldFramesKey, false)) EditorFrameYielder.Install();
            }
            else
            {
                EditorApplication.update += UpdateWorker;
                if (int.TryParse(ReadArgument(OwnerArgument), out int ownerId)) ExitWithOwner(ownerId);
            }
        }

        private static string ReadArgument(string name)
        {
            string[] args = Environment.GetCommandLineArgs();
            int index = Array.IndexOf(args, name);
            return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
        }

        // A killed unity-tests or VS Code can't stop the worker itself, so the worker watches for that.
        // It uses its own thread because a test can hold the main one.
        private static void ExitWithOwner(int ownerId)
        {
            var thread = new Thread(() =>
            {
                if (WaitForExit(ownerId)) Process.GetCurrentProcess().Kill();
            });
            thread.IsBackground = true;
            thread.Start();
        }

        /// <summary>Returns false when the process can't be watched.</summary>
        private static bool WaitForExit(int processId)
        {
            try
            {
                using (Process process = Process.GetProcessById(processId))
                {
                    // Polled, because a thread blocked in a native wait can hold up a domain reload.
                    while (!process.HasExited) Thread.Sleep(OwnerCheckMilliseconds);
                }
                return true;
            }
            catch (ArgumentException)
            {
                return true;
            }
            catch (Exception e) when (e is Win32Exception || e is InvalidOperationException || e is NotSupportedException)
            {
                return false;
            }
        }

        /// <summary>
        /// Does what run.json asks: "check" ends at once, since getting here means everything compiled;
        /// "list" reports the tests and waits for a selection; otherwise starts the named tests, or all
        /// of them. Called through -executeMethod.
        /// </summary>
        public static void RunInWorker()
        {
            try
            {
                var run = JsonUtility.FromJson<Command>(File.ReadAllText(WorkerDirectory + "/run.json"));
                if (run.action == "check") EndRun(new BridgeEvent { type = "done" }, 0);
                else if (run.action == "list") SessionState.SetBool(AwaitingSelectionKey, true);
                else StartInWorker(run);
            }
            catch (Exception e)
            {
                EndRun(new BridgeEvent { type = "error", message = e.Message }, 1);
            }
        }

        private static void StartInWorker(Command run)
        {
            bool all = IsEmpty(run.editNames) && IsEmpty(run.playNames);
            bool runEdit = run.mode != "play" && (all || !IsEmpty(run.editNames));
            bool runPlay = run.mode != "edit" && (all || !IsEmpty(run.playNames));
            if (!runEdit && !runPlay) throw new ArgumentException("No tests were named for this mode.");
            StartModes(run.editNames, run.playNames, runEdit, runPlay);
        }

        private static void UpdateWorker()
        {
            if (EditorApplication.timeSinceStartup < nextPoll) return;
            nextPoll = EditorApplication.timeSinceStartup + PollSeconds;

            CloseWorkerWindows();
            if (SessionState.GetBool(AwaitingSelectionKey, false)) PollSelection();
        }

        // Kept in SessionState and listed again after a reload, which would lose a list in progress.
        private static void PollSelection()
        {
            if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;

            string path = WorkerDirectory + "/command.json";
            try
            {
                if (!listedSinceReload)
                {
                    listedSinceReload = true;
                    RetrieveTests(tests => Emit(new BridgeEvent { type = "list", tests = tests }));
                    return;
                }
                if (!File.Exists(path)) return;

                var command = JsonUtility.FromJson<Command>(File.ReadAllText(path));
                File.Delete(path);
                SessionState.EraseBool(AwaitingSelectionKey);
                if (command.action == "run") StartInWorker(command);
                else EndRun(new BridgeEvent { type = "done" }, 0);
            }
            catch (Exception e)
            {
                SessionState.EraseBool(AwaitingSelectionKey);
                EndRun(new BridgeEvent { type = "error", message = e.Message }, 1);
            }
        }

        // Packages can open windows even in batch mode, and a prompt from the worker looks like
        // one from the real Editor. Unity's own windows are left alone.
        private static void CloseWorkerWindows()
        {
            foreach (EditorWindow window in Resources.FindObjectsOfTypeAll<EditorWindow>())
            {
                if (window.GetType().Assembly.GetName().Name.StartsWith("UnityEditor")) continue;
                Debug.LogWarning($"[VsCodeTests] Closed window in the worker: {window.GetType().FullName}");
                window.Close();
            }
        }

        private static bool IsEmpty(string[] names)
        {
            return names == null || names.Length == 0;
        }

        // Test Framework 1.1 has no CancelTestRun, and a compile error here would block the whole
        // project, so it's looked up at runtime. Returns false on those versions, where a run can't be stopped.
        private static bool CancelRun(string guid)
        {
            MethodInfo cancel = typeof(TestRunnerApi).GetMethod("CancelTestRun", new[] { typeof(string) });
            cancel?.Invoke(null, new object[] { guid });
            return cancel != null;
        }

        private static void Execute(TestMode mode, string[] names)
        {
            // The worker has no UI to keep responsive, and Play Mode tests already run across frames.
            bool yieldFrames = WorkerDirectory == null && mode == TestMode.EditMode;
            SessionState.SetBool(YieldFramesKey, yieldFrames);
            if (yieldFrames) EditorFrameYielder.Install();
            else EditorFrameYielder.Remove();

            var filter = new Filter { testMode = mode, testNames = IsEmpty(names) ? null : names };
            SessionState.SetString(ActiveGuidKey, api.Execute(new ExecutionSettings(filter)));
        }

        // The Test Framework ignores later filters whose mode differs from the first, so each mode
        // gets its own run. The queued one is kept in SessionState to outlast the domain reload.
        private static void StartModes(string[] editNames, string[] playNames, bool runEdit, bool runPlay)
        {
            if (runEdit && runPlay)
            {
                SessionState.SetString(PendingPlayKey, JsonUtility.ToJson(new Command { playNames = playNames }));
            }
            if (runEdit) Execute(TestMode.EditMode, editNames);
            else Execute(TestMode.PlayMode, playNames);
        }

        /// <summary>Starts the queued Play Mode run, if any. Returns false when nothing was queued.</summary>
        private static bool TryStartPendingPlayRun()
        {
            string pending = SessionState.GetString(PendingPlayKey, "");
            if (pending == "") return false;

            SessionState.EraseString(PendingPlayKey);
            string[] names = JsonUtility.FromJson<Command>(pending).playNames;
            EditorApplication.delayCall += () =>
            {
                try
                {
                    Execute(TestMode.PlayMode, names);
                }
                catch (Exception e)
                {
                    EndRun(new BridgeEvent { type = "error", message = e.Message }, 1);
                }
            };
            return true;
        }

        private static void EndRun(BridgeEvent lastEvent, int workerExitCode)
        {
            Emit(lastEvent);
            ClearActiveRun();
            if (WorkerDirectory != null) EditorApplication.delayCall += () => EditorApplication.Exit(workerExitCode);
        }

        private static void Poll()
        {
            if (EditorApplication.timeSinceStartup < nextPoll) return;
            nextPoll = EditorApplication.timeSinceStartup + PollSeconds;

            if (!File.Exists(CommandPath)) return;

            // A command from a closed VS Code must not start a run when the Editor next opens.
            if (DateTime.UtcNow - File.GetLastWriteTimeUtc(CommandPath) > TimeSpan.FromMinutes(MaxCommandAgeMinutes))
            {
                File.Delete(CommandPath);
                return;
            }

            Command command;
            try
            {
                command = JsonUtility.FromJson<Command>(File.ReadAllText(CommandPath));
            }
            catch (Exception e) when (e is IOException || e is ArgumentException)
            {
                return;
            }

            if (command == null || string.IsNullOrEmpty(command.id))
            {
                File.Delete(CommandPath);
                return;
            }

            if (command.action == "cancel")
            {
                File.Delete(CommandPath);
                SessionState.EraseString(PendingPlayKey);
                string guid = SessionState.GetString(ActiveGuidKey, "");
                // Only read once the current test returns, so this also tells the extension it has.
                bool cancelled = guid == "" || CancelRun(guid);
                Emit(new BridgeEvent
                {
                    type = "cancelling",
                    message = cancelled ? "" : "This version of the Test Framework can't stop a run, so it continues to the end.",
                });
                return;
            }

            bool playing = EditorApplication.isPlayingOrWillChangePlaymode;
            if (playing && command.action != "list")
            {
                Finish(command, "rejected", "Unity is in Play Mode. Exit it and try again.");
                return;
            }

            if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;

            // A refresh in Play Mode can recompile and end the session, so listing there skips it.
            if (command.refresh && !playing && SessionState.GetString(RefreshedKey, "") != command.id)
            {
                SessionState.SetString(RefreshedKey, command.id);
                AssetDatabase.Refresh();
                return;
            }

            if (EditorUtility.scriptCompilationFailed)
            {
                Finish(command, "rejected", "The project has compile errors. Fix them and try again.");
                return;
            }

            if (command.action == "list") List(command);
            else if (command.action == "run") Run(command);
            else File.Delete(CommandPath);
        }

        private static void List(Command command)
        {
            File.Delete(CommandPath);
            RetrieveTests(tests => Write(command.id, new BridgeEvent { type = "list", tests = tests }));
        }

        private static void RetrieveTests(Action<TestNode[]> onRetrieved)
        {
            var tests = new List<TestNode>();
            api.RetrieveTestList(TestMode.EditMode, editRoot =>
            {
                Flatten(editRoot, -1, "edit", tests);
                api.RetrieveTestList(TestMode.PlayMode, playRoot =>
                {
                    Flatten(playRoot, -1, "play", tests);
                    onRetrieved(tests.ToArray());
                });
            });
        }

        private static void Flatten(ITestAdaptor test, int parent, string mode, List<TestNode> tests)
        {
            int index = tests.Count;
            tests.Add(new TestNode
            {
                name = test.Name,
                fullName = test.FullName,
                parent = parent,
                mode = mode,
                isSuite = test.IsSuite,
                isAssembly = test.IsTestAssembly,
                typeName = test.TypeInfo?.FullName ?? "",
                methodName = test.Method?.Name ?? "",
                isExplicit = test.RunState == RunState.Explicit,
            });
            foreach (ITestAdaptor child in test.Children) Flatten(child, index, mode, tests);
        }

        private static void Run(Command command)
        {
            // An empty filter would run every test in the project.
            if (IsEmpty(command.editNames) && IsEmpty(command.playNames))
            {
                Finish(command, "rejected", "No tests were named.");
                return;
            }

            // The Test Framework would otherwise open a modal save prompt and block the Editor.
            string[] dirty = Enumerable.Range(0, SceneManager.sceneCount)
                .Select(SceneManager.GetSceneAt)
                .Where(scene => scene.isDirty)
                .Select(scene => scene.name)
                .ToArray();
            if (dirty.Length > 0)
            {
                Finish(command, "rejected", "Save these scenes in Unity first: " + string.Join(", ", dirty));
                return;
            }

            // Deleted before starting so a crash mid-run can't restart it on the next launch.
            File.Delete(CommandPath);
            SessionState.SetString(ActiveRunKey, command.id);
            try
            {
                StartModes(command.editNames, command.playNames, !IsEmpty(command.editNames), !IsEmpty(command.playNames));
            }
            catch (Exception e)
            {
                ClearActiveRun();
                Write(command.id, new BridgeEvent { type = "error", message = e.Message });
            }
        }

        private static void Finish(Command command, string type, string message)
        {
            File.Delete(CommandPath);
            Write(command.id, new BridgeEvent { type = type, message = message });
        }

        private static void ClearActiveRun()
        {
            SessionState.EraseString(ActiveRunKey);
            SessionState.EraseString(ActiveGuidKey);
            SessionState.EraseString(PendingPlayKey);
            SessionState.EraseBool(YieldFramesKey);
            EditorFrameYielder.Remove();
        }

        private static void CountFrame()
        {
            if (SessionState.GetString(ActiveRunKey, "") != "") framesInRun++;
        }

        private static void Write(string id, BridgeEvent bridgeEvent)
        {
            Directory.CreateDirectory(DataDirectory);
            File.AppendAllText($"{DataDirectory}/events-{id}.ndjson", JsonUtility.ToJson(bridgeEvent) + "\n");
        }

        // Runs from the Test Runner window or elsewhere have no active run and are ignored.
        private static void Emit(BridgeEvent bridgeEvent)
        {
            if (WorkerDirectory != null)
            {
                File.AppendAllText(WorkerDirectory + "/events.ndjson", JsonUtility.ToJson(bridgeEvent) + "\n");
                return;
            }

            string activeRun = SessionState.GetString(ActiveRunKey, "");
            if (activeRun != "") Write(activeRun, bridgeEvent);
        }

        private sealed class RunCallbacks : IErrorCallbacks
        {
            public void RunStarted(ITestAdaptor testsToRun)
            {
                framesInRun = 0;
                Emit(new BridgeEvent { type = "runStarted" });
            }

            public void RunFinished(ITestResultAdaptor result)
            {
                if (!TryStartPendingPlayRun()) EndRun(new BridgeEvent { type = "done", frames = framesInRun }, 0);
            }

            public void TestStarted(ITestAdaptor test)
            {
                if (!test.IsSuite) Emit(new BridgeEvent { type = "started", fullName = test.FullName });
            }

            public void TestFinished(ITestResultAdaptor result)
            {
                if (result.Test.IsSuite) return;
                Emit(new BridgeEvent
                {
                    type = "test",
                    fullName = result.FullName,
                    status = result.TestStatus.ToString().ToLowerInvariant(),
                    message = result.Message,
                    output = result.Output,
                    stack = result.StackTrace,
                    duration = result.Duration,
                });
            }

            public void OnError(string message)
            {
                EndRun(new BridgeEvent { type = "error", message = message }, 1);
            }
        }

        [Serializable]
        private sealed class Command
        {
            public string id;
            public string action;
            public bool refresh;
            public string mode;
            public string[] editNames;
            public string[] playNames;
        }

        [Serializable]
        private sealed class BridgeEvent
        {
            public string type;
            public string fullName;
            public string status;
            public string message;
            public string output;
            public string stack;
            public double duration;
            public int frames;
            public TestNode[] tests;
        }

        [Serializable]
        private sealed class TestNode
        {
            public string name;
            public string fullName;
            public int parent;
            public string mode;
            public bool isSuite;
            public bool isAssembly;
            public string typeName;
            public string methodName;
            public bool isExplicit;
        }
    }
}
