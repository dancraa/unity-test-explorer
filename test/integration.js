// End-to-end check against a real Unity install, on a new project with Edit and Play Mode tests.
//   node test/integration.js <path to Unity executable> <empty folder for the project>
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { UnityBridge } = require('../bridge');
const { installBridge } = require('../install');
const { isProcessAlive } = require('../lock');
const { TestWorker } = require('../worker');

const [unityExe, projectRootArg] = process.argv.slice(2);
if (!unityExe || !projectRootArg) {
    console.error('Usage: node test/integration.js <unity executable> <empty project folder>');
    process.exit(2);
}
const projectRoot = path.resolve(projectRootArg);

const EDIT_TESTS = `using System;
using System.Collections;
using NUnit.Framework;
using NUnit.Framework.Interfaces;
using UnityEngine.TestTools;
namespace Fixture.Edit
{
    // Prove that the bridge leaves a project's own actions exactly as the Test Framework would run them.
    public class MethodAction : Attribute, IOuterUnityTestAction
    {
        public static int Calls;
        public IEnumerator BeforeTest(ITest test) { Calls++; yield return null; }
        public IEnumerator AfterTest(ITest test) { yield return null; }
    }

    public class ClassAction : Attribute, IOuterUnityTestAction
    {
        public static int Calls;
        public IEnumerator BeforeTest(ITest test) { Calls++; yield return null; }
        public IEnumerator AfterTest(ITest test) { yield return null; }
    }

    [ClassAction]
    public class ActionSampleTests
    {
        [Test, MethodAction] public void MethodActionRan() { Assert.Greater(MethodAction.Calls, 0); }

        // Whether class actions run depends on the Test Framework version, so this only reports it.
        [Test] public void ReportsClassAction() { Assert.Pass(ClassAction.Calls > 0 ? "class action ran" : "class action did not run"); }
    }

    public class EditSampleTests
    {
        [Test] public void Passes() { Assert.Pass(); }
        [Test] public void Fails() { UnityEngine.Debug.Log("edit log"); Assert.AreEqual(1, 2, "edit failure"); }
        [Test, Ignore("edit skip")] public void Skipped() { }
        [TestCase(1)] [TestCase(2)] public void Cases(int value) { Assert.AreEqual(1, value); }
    }

    public class OutcomeSampleTests
    {
        [Test] public void Inconclusive() { Assert.Inconclusive("not sure"); }
    }

    [Explicit]
    public class SlowSampleTests
    {
        [Test] public void HoldsTheMainThread() { System.Threading.Thread.Sleep(300000); }
    }

    [TestFixture(1)]
    [TestFixture(2)]
    public class FixtureSampleTests
    {
        private readonly int value;
        public FixtureSampleTests(int value) { this.value = value; }
        [Test] public void IsPositive() { Assert.Greater(value, 0); }
    }
}

namespace Fixture.Edit.Twin
{
    public class OutcomeSampleTests
    {
        [Test] public void Passes() { }
    }
}
`;
const PLAY_TESTS = `using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
namespace Fixture.Play
{
    public class PlaySampleTests
    {
        [UnityTest] public IEnumerator PassesAfterAFrame() { yield return null; Assert.IsTrue(Application.isPlaying); }
        [UnityTest] public IEnumerator FailsAfterAFrame() { yield return null; Assert.Fail("play failure"); }
    }
}
`;

function asmdef(name, includeEditor) {
    return JSON.stringify({
        name,
        references: ['UnityEngine.TestRunner', 'UnityEditor.TestRunner'],
        includePlatforms: includeEditor ? ['Editor'] : [],
        overrideReferences: true,
        precompiledReferences: ['nunit.framework.dll'],
        autoReferenced: false,
        defineConstraints: ['UNITY_INCLUDE_TESTS'],
    }, null, 2);
}

function write(file, text) {
    const full = path.join(projectRoot, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
}

function createProject() {
    const result = spawnSync(unityExe, ['-batchmode', '-quit', '-createProject', projectRoot, '-logFile', `${projectRoot}-create.log`], { stdio: 'ignore' });
    if (result.status !== 0) throw new Error(`Creating the project failed. See ${projectRoot}-create.log`);
    installBridge(projectRoot);
    write('Assets/Tests/Edit/Fixture.Edit.asmdef', asmdef('Fixture.Edit', true));
    write('Assets/Tests/Edit/EditSampleTests.cs', EDIT_TESTS);
    write('Assets/Tests/Play/Fixture.Play.asmdef', asmdef('Fixture.Play', false));
    write('Assets/Tests/Play/PlaySampleTests.cs', PLAY_TESTS);
}

let failures = 0;
const workerEvents = [];
function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

function results(events) {
    // Whether a full run reports [Explicit] tests as skipped or not at all depends on the Test Framework version.
    return Object.fromEntries(events.filter(e => e.type === 'test' && !e.fullName.includes('SlowSampleTests')).map(e => [e.fullName.replace(/^Fixture\.\w+\./, ''), e.status]));
}

const ALL_RESULTS = {
    'ActionSampleTests.MethodActionRan': 'passed',
    'ActionSampleTests.ReportsClassAction': 'passed',
    'EditSampleTests.Cases(1)': 'passed',
    'EditSampleTests.Cases(2)': 'failed',
    'EditSampleTests.Fails': 'failed',
    'EditSampleTests.Passes': 'passed',
    'EditSampleTests.Skipped': 'skipped',
    'FixtureSampleTests(1).IsPositive': 'passed',
    'FixtureSampleTests(2).IsPositive': 'passed',
    'OutcomeSampleTests.Inconclusive': 'inconclusive',
    'PlaySampleTests.FailsAfterAFrame': 'failed',
    'PlaySampleTests.PassesAfterAFrame': 'passed',
    'Twin.OutcomeSampleTests.Passes': 'passed',
};

function sorted(object) {
    return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

async function testWorker() {
    const worker = new TestWorker(projectRoot);
    const version = /m_EditorVersion:\s*(\S+)/.exec(fs.readFileSync(path.join(projectRoot, 'ProjectSettings/ProjectVersion.txt'), 'utf8'))[1];
    fs.mkdirSync(worker.stateDir, { recursive: true });
    fs.writeFileSync(worker.unityPath, JSON.stringify({ path: unityExe, version }));

    const all = workerEvents;
    let start = Date.now();
    let end = await worker.run({ onEvent: e => all.push(e) });
    console.log(`     worker, first full run: ${Math.round((Date.now() - start) / 1000)} s`);
    check('worker: every test in both modes finishes', end.type, 'done');
    if (end.type !== 'done') console.log(end.message);
    check('worker: results', sorted(results(all)), ALL_RESULTS);
    const editFailure = all.find(e => e.type === 'test' && e.fullName.endsWith('EditSampleTests.Fails'));
    check('worker: Edit Mode failure text', !!editFailure && editFailure.message.includes('edit failure'), true);
    const playFailure = all.find(e => e.type === 'test' && e.fullName.endsWith('FailsAfterAFrame'));
    check('worker: Play Mode failure text', !!playFailure && playFailure.message.includes('play failure'), true);
    check('worker: stack points at the project', !!editFailure && !editFailure.stack.includes('-TestWorker'), true);

    const named = [];
    start = Date.now();
    end = await worker.run({ playNames: ['Fixture.Play.PlaySampleTests.PassesAfterAFrame'], onEvent: e => named.push(e) });
    console.log(`     worker, repeat named run: ${Math.round((Date.now() - start) / 1000)} s`);
    check('worker: a named Play Mode test runs alone', results(named), { 'PlaySampleTests.PassesAfterAFrame': 'passed' });

    // How the command line sends names, since it can't know which mode they belong to.
    const name = 'Fixture.Edit.EditSampleTests.Passes';
    const unmatched = [];
    end = await worker.run({ editNames: [name], playNames: [name], onEvent: e => unmatched.push(e) });
    check('worker: a mode matching nothing still finishes', end.type, 'done');
    check('worker: only the named test runs', results(unmatched), { 'EditSampleTests.Passes': 'passed' });
}

const CLI = path.join(__dirname, '..', 'cli.js');

function startCli(...args) {
    const child = spawn(process.execPath, [CLI, '--project', projectRoot, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const done = new Promise(resolve => child.on('close', code => resolve({ code, stdout, stderr })));
    return { child, done };
}

async function cli(...args) {
    const start = Date.now();
    const result = await startCli(...args).done;
    console.log(`     unity-tests ${args.join(' ')}: ${Math.round((Date.now() - start) / 1000)} s`);
    if (result.code === 2) console.log(`     exit 2: ${result.stderr.trim()}`);
    return args.includes('--json') ? { ...result, json: JSON.parse(result.stdout) } : result;
}

async function waitFor(condition, seconds) {
    for (let waited = 0; waited < seconds * 5; waited++) {
        if (condition()) return true;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    return false;
}

async function testCli() {
    const worker = new TestWorker(projectRoot);
    const isRunningSlowTest = () => fs.existsSync(worker.eventsPath) && /"started".*HoldsTheMainThread/.test(fs.readFileSync(worker.eventsPath, 'utf8'));
    const unityPid = () => fs.existsSync(worker.lock.pidPath) ? Number(fs.readFileSync(worker.lock.pidPath, 'utf8')) : 0;
    const names = run => run.json.tests.map(result => result.fullName.replace(/^Fixture\.\w+\./, '')).sort();

    let run = await cli('EditSampleTests.Passes', 'PlaySampleTests', '--json');
    check('cli: short names run the right tests', names(run), ['EditSampleTests.Passes', 'PlaySampleTests.FailsAfterAFrame', 'PlaySampleTests.PassesAfterAFrame']);
    check('cli: a failure exits 1', run.code, 1);
    check('cli: matched names are reported', run.json.matched.map(m => [m.fullName, m.tests]), [['Fixture.Edit.EditSampleTests.Passes', 1], ['Fixture.Play.PlaySampleTests', 2]]);

    run = await cli('FixtureSampleTests');
    check('cli: a class with several fixtures runs them all', [run.code, /2 tests matched/.test(run.stdout), /2 passed/.test(run.stdout)], [0, true, true]);

    run = await cli('EditSampleTests', 'EditSampelTests', '--json');
    check('cli: a misspelled name exits 3 and runs nothing', [run.code, run.json.tests.length], [3, 0]);
    check('cli: the closest name is suggested', run.json.unmatched.map(u => u.suggestions[0]), ['Fixture.Edit.EditSampleTests']);

    run = await cli('OutcomeSampleTests');
    check('cli: an ambiguous name lists its candidates', [run.code, run.stdout.includes('Fixture.Edit.Twin.OutcomeSampleTests')], [3, true]);

    run = await cli('Fixture.Edit.OutcomeSampleTests.Inconclusive');
    check('cli: inconclusive exits 1', [run.code, run.stdout.includes('INCONCLUSIVE')], [1, true]);

    run = await cli('--mode', 'play', 'EditSampleTests');
    check('cli: says which mode a name is in', [run.code, run.stdout.includes('Edit Mode test')], [3, true]);

    const junit = path.join(projectRoot, 'junit.xml');
    run = await cli('--mode', 'edit', '--json', '--junit', junit);
    const expected = Object.keys(ALL_RESULTS).filter(name => !name.startsWith('PlaySample'));
    check('cli: --mode edit without names runs only Edit Mode tests', names(run).filter(name => !name.includes('SlowSample')), expected.sort());
    check('cli: every expected test reported', [run.code, run.json.missing], [1, []]);
    check("cli: a failure's log is separate", run.json.tests.filter(result => /edit log/.test(result.output)).map(result => /edit log/.test(result.message)), [false]);
    check('cli: JUnit is written', /<testcase classname="Fixture.Edit.EditSampleTests" name="Cases\(2\)"/.test(fs.readFileSync(junit, 'utf8')), true);

    run = await cli('--failed', '--mode', 'edit', '--json');
    check('cli: --failed reruns only the failures', [run.code, ...names(run)], [1, 'EditSampleTests.Cases(2)', 'EditSampleTests.Fails', 'OutcomeSampleTests.Inconclusive']);

    run = await cli('--list');
    check('cli: --list counts classes', [run.code, run.stdout.includes('Fixture.Edit.EditSampleTests (5)'), run.stdout.includes('Fixture.Play.PlaySampleTests  [Play Mode] (2)')], [0, true, true]);
    run = await cli('--list', 'cases');
    check('cli: --list with a pattern', [run.code, run.stdout.includes('EditSampleTests.Cases(1)'), /2 tests$/m.test(run.stdout)], [0, true, true]);

    run = await cli('--check');
    check('cli: --check on code that compiles', [run.code, /Compiled OK/.test(run.stdout)], [0, true]);
    write('Assets/Tests/Edit/Broken.cs', 'class Broken { int x = "text"; }');
    for (const attempt of ['with new errors', 'with the same errors']) {
        run = await cli('--check');
        check(`cli: --check ${attempt}`, [run.code, /Broken\.cs.*error CS0029/.test(run.stdout)], [1, true]);
    }
    run = await cli('EditSampleTests.Passes');
    check('cli: a run with compile errors exits 2', [run.code, /error CS0029/.test(run.stderr)], [2, true]);
    fs.rmSync(path.join(projectRoot, 'Assets/Tests/Edit/Broken.cs'));
    run = await cli('--check');
    check('cli: --check after the fix', [run.code, /Synced 1 changed file/.test(run.stdout)], [0, true]);

    const savesTest = 'Assets/Tests/Edit/SavesSampleTests.cs';
    write(savesTest, 'namespace Fixture.Edit { public class SavesSampleTests { [NUnit.Framework.Test] public void Path() { NUnit.Framework.Assert.Inconclusive(UnityEngine.Application.persistentDataPath); } } }');
    const savesPath = async () => (await cli('SavesSampleTests', '--json')).json.tests[0].message.trim();
    const shared = await savesPath();
    write('.unity-test-worker.json', '{"separateSaves": true}');
    const separate = await savesPath();
    check('cli: separateSaves gives the worker its own folder', [/-TestWorker$/.test(shared), /-TestWorker$/.test(separate)], [false, true]);
    run = await cli('SavesSampleTests', '--json');
    check('cli: separateSaves is not a change on every run', run.json.sync.changed, 0);
    fs.rmSync(path.join(projectRoot, '.unity-test-worker.json'));
    check('cli: turning separateSaves off undoes it', await savesPath(), shared);
    fs.rmSync(path.join(projectRoot, savesTest));

    let slow = startCli('SlowSampleTests');
    check('cli: an [Explicit] test runs when named', await waitFor(isRunningSlowTest, 120), true);
    let pid = unityPid();
    run = await cli('EditSampleTests.Passes');
    check('cli: a busy worker is refused', [run.code, /already running/.test(run.stderr)], [2, true]);
    slow.child.kill('SIGKILL');
    check('cli: Unity stops when its owner is killed', await waitFor(() => !isProcessAlive(pid), 20), true);
    run = await cli('EditSampleTests.Passes');
    check('cli: the next run works', run.code, 0);

    slow = startCli('SlowSampleTests', '--json');
    await waitFor(isRunningSlowTest, 120);
    pid = unityPid();
    const queued = startCli('EditSampleTests.Passes', '--wait');
    run = await cli('--stop');
    check('cli: --stop', [run.code, /Stopped the run started .* by unity-tests .*SlowSampleTests/.test(run.stdout), isProcessAlive(pid)], [0, true, false]);
    const stopped = await slow.done;
    check('cli: the stopped run says so', [stopped.code, JSON.parse(stopped.stdout).error], [2, 'Stopped by unity-tests --stop.\nIt was running Fixture.Edit.SlowSampleTests.HoldsTheMainThread.']);
    const waited = await queued.done;
    check('cli: --wait runs once the worker is free', [waited.code, /Waiting for another run/.test(waited.stdout)], [0, true]);

    run = await cli('--timeout', '5', 'SlowSampleTests');
    check('cli: --timeout', [run.code, /Timed out after 5 s/.test(run.stderr)], [2, true]);
    run = await cli('--stop');
    check('cli: nothing left to stop', /No worker is running/.test(run.stdout), true);
}

// A batch Unity without -quit stands in for an open Editor: it stays up and polls for commands.
async function testEditor() {
    const editor = spawn(unityExe, ['-batchmode', '-projectPath', projectRoot, '-logFile', `${projectRoot}-editor.log`], { stdio: 'ignore' });
    const bridge = new UnityBridge(projectRoot);
    let exited = false;
    editor.on('exit', () => { exited = true; });
    try {
        for (let waited = 0; !exited && !bridge.isEditorRunning() && waited < 300; waited++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        check('editor: reports itself as running', bridge.isEditorRunning(), true);

        const list = await bridge.send({ action: 'list' }, () => {});
        check('editor: list answers', list.type, 'list');
        if (list.type !== 'list') {
            console.log(list.message);
            return;
        }
        const modes = [...new Set(list.tests.filter(t => !t.isSuite).map(t => t.mode))].sort();
        check('editor: list covers both modes', modes, ['edit', 'play']);
        check('editor: test count', list.tests.filter(t => !t.isSuite).length, 14);

        const action = [];
        await bridge.send({ action: 'run', editNames: ['Fixture.Edit.ActionSampleTests'] }, e => action.push(e));
        check("editor: a project's method actions still run", results(action), {
            'ActionSampleTests.MethodActionRan': 'passed',
            'ActionSampleTests.ReportsClassAction': 'passed',
        });
        const report = events => (events.find(e => e.type === 'test' && e.fullName.endsWith('ReportsClassAction')) || {}).message;
        console.log(`     class actions: ${report(workerEvents)}`);
        check('editor: class actions match a run without the bridge frames', report(action), report(workerEvents));

        const edit = [];
        await bridge.send({ action: 'run', refresh: true, editNames: ['Fixture.Edit.EditSampleTests.Passes'] }, e => edit.push(e));
        check('editor: Edit Mode run', results(edit), { 'EditSampleTests.Passes': 'passed' });

        const editClass = [];
        const classEnd = await bridge.send({ action: 'run', editNames: ['Fixture.Edit.EditSampleTests'] }, e => editClass.push(e));
        console.log(`     editor frames during a ${Object.keys(results(editClass)).length}-test class: ${classEnd.frames}`);
        check('editor: a whole class gets the same results with frames', sorted(results(editClass)), {
            'EditSampleTests.Cases(1)': 'passed',
            'EditSampleTests.Cases(2)': 'failed',
            'EditSampleTests.Fails': 'failed',
            'EditSampleTests.Passes': 'passed',
            'EditSampleTests.Skipped': 'skipped',
        });
        const editFailure = editClass.find(e => e.type === 'test' && e.fullName.endsWith('.Fails'));
        check('editor: failure text survives', !!editFailure && editFailure.message.includes('edit failure'), true);

        const play = [];
        const end = await bridge.send({ action: 'run', playNames: ['Fixture.Play.PlaySampleTests'] }, e => play.push(e));
        check('editor: Play Mode run finishes', end.type, 'done');
        check('editor: Play Mode results', sorted(results(play)), {
            'PlaySampleTests.FailsAfterAFrame': 'failed',
            'PlaySampleTests.PassesAfterAFrame': 'passed',
        });

        const mixed = [];
        const mixedEnd = await bridge.send({
            action: 'run',
            editNames: ['Fixture.Edit.EditSampleTests.Passes'],
            playNames: ['Fixture.Play.PlaySampleTests.PassesAfterAFrame'],
        }, e => mixed.push(e));
        check('editor: a run across both modes finishes', mixedEnd.type, 'done');
        check('editor: both modes report', sorted(results(mixed)), {
            'EditSampleTests.Passes': 'passed',
            'PlaySampleTests.PassesAfterAFrame': 'passed',
        });

        const empty = await bridge.send({ action: 'run' }, () => {});
        check('editor: a run naming nothing is refused', empty.type, 'rejected');
    } finally {
        spawnSync('taskkill', ['/PID', String(editor.pid), '/T', '/F'], { stdio: 'ignore' });
        if (process.platform !== 'win32') editor.kill('SIGKILL');
    }
}

(async () => {
    createProject();
    await testWorker();
    await testCli();
    await testEditor();
    console.log(failures === 0 ? 'ALL PASSED' : `${failures} CHECK(S) FAILED`);
    process.exitCode = failures === 0 ? 0 : 1;
})().catch(error => {
    console.error(error);
    process.exitCode = 2;
});
