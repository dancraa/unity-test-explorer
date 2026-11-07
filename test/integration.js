// End-to-end check against a real Unity install, on a new project with Edit and Play Mode tests.
//   node test/integration.js <path to Unity executable> <empty folder for the project>
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { UnityBridge } = require('../bridge');
const { installBridge } = require('../install');
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
        [Test] public void Fails() { Assert.AreEqual(1, 2, "edit failure"); }
        [Test, Ignore("edit skip")] public void Skipped() { }
        [TestCase(1)] [TestCase(2)] public void Cases(int value) { Assert.AreEqual(1, value); }
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
    return Object.fromEntries(events.filter(e => e.type === 'test').map(e => [e.fullName.replace(/^Fixture\.\w+\./, ''), e.status]));
}

const ALL_RESULTS = {
    'ActionSampleTests.MethodActionRan': 'passed',
    'ActionSampleTests.ReportsClassAction': 'passed',
    'EditSampleTests.Cases(1)': 'passed',
    'EditSampleTests.Cases(2)': 'failed',
    'EditSampleTests.Fails': 'failed',
    'EditSampleTests.Passes': 'passed',
    'EditSampleTests.Skipped': 'skipped',
    'PlaySampleTests.FailsAfterAFrame': 'failed',
    'PlaySampleTests.PassesAfterAFrame': 'passed',
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
        check('editor: test count', list.tests.filter(t => !t.isSuite).length, 9);

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
    await testEditor();
    console.log(failures === 0 ? 'ALL PASSED' : `${failures} CHECK(S) FAILED`);
    process.exitCode = failures === 0 ? 0 : 1;
})().catch(error => {
    console.error(error);
    process.exitCode = 2;
});
