using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.TestTools.TestRunner.Api;
using UnityEngine;
using UnityEngine.SceneManagement;

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
        private const string DataDirectory = "Library/VsCodeTests";
        private const string CommandPath = DataDirectory + "/command.json";
        private const double PollSeconds = 0.25;
        private const int MaxCommandAgeMinutes = 10;

        // SessionState survives the domain reloads a run can cause.
        private const string ActiveRunKey = "VsCodeTests.ActiveRun";
        private const string ActiveGuidKey = "VsCodeTests.ActiveGuid";
        private const string RefreshedKey = "VsCodeTests.Refreshed";
        private const string PendingPlayKey = "VsCodeTests.PendingPlay";

        private static TestRunnerApi api;
        private static double nextPoll;

        // Set only in the headless worker, where the path comes from the command line.
        private static readonly string WorkerDirectory = ReadWorkerDirectory();

        static VsCodeTestBridge()
        {
            api = ScriptableObject.CreateInstance<TestRunnerApi>();
            api.hideFlags = HideFlags.HideAndDontSave;
            api.RegisterCallbacks(new RunCallbacks());
            if (WorkerDirectory == null) EditorApplication.update += Poll;
            else EditorApplication.update += CloseWorkerWindows;
        }

        private static string ReadWorkerDirectory()
        {
            string[] args = Environment.GetCommandLineArgs();
            int index = Array.IndexOf(args, WorkerArgument);
            return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
        }

        /// <summary>Starts the tests named in run.json, or all of them. Called through -executeMethod.</summary>
        public static void RunInWorker()
        {
            try
            {
                var run = JsonUtility.FromJson<Command>(File.ReadAllText(WorkerDirectory + "/run.json"));
                bool all = IsEmpty(run.editNames) && IsEmpty(run.playNames);
                StartModes(run.editNames, run.playNames, all || !IsEmpty(run.editNames), all || !IsEmpty(run.playNames));
            }
            catch (Exception e)
            {
                Emit(new BridgeEvent { type = "error", message = e.Message });
                EditorApplication.Exit(1);
            }
        }

        // Packages can open windows even in batch mode, and a prompt from the worker looks like
        // one from the real Editor. Unity's own windows are left alone.
        private static void CloseWorkerWindows()
        {
            if (EditorApplication.timeSinceStartup < nextPoll) return;
            nextPoll = EditorApplication.timeSinceStartup + PollSeconds;

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
        // project, so it's looked up at runtime. On those versions a run can't be stopped.
        private static void CancelRun(string guid)
        {
            typeof(TestRunnerApi).GetMethod("CancelTestRun", new[] { typeof(string) })?.Invoke(null, new object[] { guid });
        }

        private static void Execute(TestMode mode, string[] names)
        {
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
                if (guid != "") CancelRun(guid);
                return;
            }

            if (EditorApplication.isPlayingOrWillChangePlaymode)
            {
                Finish(command, "rejected", "Unity is in Play Mode. Exit it and try again.");
                return;
            }

            if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;

            if (command.refresh && SessionState.GetString(RefreshedKey, "") != command.id)
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
            var tests = new List<TestNode>();
            api.RetrieveTestList(TestMode.EditMode, editRoot =>
            {
                Flatten(editRoot, -1, "edit", tests);
                api.RetrieveTestList(TestMode.PlayMode, playRoot =>
                {
                    Flatten(playRoot, -1, "play", tests);
                    Write(command.id, new BridgeEvent { type = "list", tests = tests.ToArray() });
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
                Emit(new BridgeEvent { type = "runStarted" });
            }

            public void RunFinished(ITestResultAdaptor result)
            {
                if (!TryStartPendingPlayRun()) EndRun(new BridgeEvent { type = "done" }, 0);
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
                    message = string.IsNullOrEmpty(result.Output) ? result.Message : result.Message + "\n\n" + result.Output,
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
            public string stack;
            public double duration;
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
        }
    }
}
