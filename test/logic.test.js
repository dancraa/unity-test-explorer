const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const logic = require('../logic');
const { mapWorkerPaths, resolveUnityExecutable } = require('../worker');

const flat = [
    { name: 'Project', fullName: 'Project', parent: -1, isSuite: true, isAssembly: false, typeName: '', methodName: '' },
    { name: 'Tests.dll', fullName: 'Tests.dll', parent: 0, isSuite: true, isAssembly: true, typeName: '', methodName: '' },
    { name: 'Ns', fullName: 'Ns', parent: 1, isSuite: true, isAssembly: false, typeName: '', methodName: '' },
    { name: 'FooTests', fullName: 'Ns.FooTests', parent: 2, isSuite: true, isAssembly: false, typeName: 'Ns.FooTests', methodName: '' },
    { name: 'Adds', fullName: 'Ns.FooTests.Adds', parent: 3, isSuite: false, isAssembly: false, typeName: 'Ns.FooTests', methodName: 'Adds' },
    { name: 'Cases', fullName: 'Ns.FooTests.Cases', parent: 3, isSuite: true, isAssembly: false, typeName: 'Ns.FooTests', methodName: 'Cases' },
    { name: 'Cases(1)', fullName: 'Ns.FooTests.Cases(1)', parent: 5, isSuite: false, isAssembly: false, typeName: 'Ns.FooTests', methodName: 'Cases' },
];

function fooTests() {
    return logic.buildTree(flat)[0].children[0].children[0];
}

test('buildTree drops the project root and nests the rest', () => {
    const roots = logic.buildTree(flat);
    assert.deepStrictEqual(roots.map(r => r.name), ['Tests.dll']);
    assert.strictEqual(fooTests().children.length, 2);
});

test('leavesOf finds tests through parameterized suites', () => {
    assert.deepStrictEqual(logic.leavesOf(fooTests()).map(l => l.fullName), ['Ns.FooTests.Adds', 'Ns.FooTests.Cases(1)']);
});

test('checkRunScope asks to confirm anything above class level, even with no limit', () => {
    const roots = logic.buildTree(flat);
    assert.deepStrictEqual(logic.checkRunScope(roots, 500), { needsConfirmation: true, broad: true, count: 2 });
    assert.strictEqual(logic.checkRunScope(roots[0].children, 500).needsConfirmation, true);
    assert.strictEqual(logic.checkRunScope(roots, 0).needsConfirmation, true);
});

test('checkRunScope lets classes and tests within the limit through', () => {
    const foo = fooTests();
    assert.deepStrictEqual(logic.checkRunScope([foo], 500), { needsConfirmation: false, broad: false, count: 2 });
    assert.strictEqual(logic.checkRunScope([foo.children[0]], 1).needsConfirmation, false);
});

test('checkRunScope enforces the limit without double counting, and 0 removes it', () => {
    const foo = fooTests();
    assert.strictEqual(logic.checkRunScope([foo], 1).needsConfirmation, true);
    assert.strictEqual(logic.checkRunScope([foo, foo.children[0]], 2).count, 2);
    assert.strictEqual(logic.checkRunScope([foo], 0).needsConfirmation, false);
});

test('buildTree passes [Explicit] from a parameterized method to its cases', () => {
    const marked = flat.map((node, i) => (i === 5 ? { ...node, isExplicit: true } : node));
    const [adds, cases] = logic.buildTree(marked)[0].children[0].children[0].children;
    assert.strictEqual(adds.isExplicit, false);
    assert.strictEqual(cases.children[0].isExplicit, true);
});

test('findSlowTests flags slow recorded times, and [Explicit] tests only until they have one', () => {
    const leaves = [
        { fullName: 'A', name: 'A', isExplicit: false },
        { fullName: 'B', name: 'B', isExplicit: true },
        { fullName: 'C', name: 'C', isExplicit: true },
        { fullName: 'D', name: 'D', isExplicit: false },
    ];
    const slow = logic.findSlowTests(leaves, { A: 12, C: 0.5, D: 3 }, 10);
    assert.deepStrictEqual(slow, [
        { fullName: 'A', name: 'A', seconds: 12 },
        { fullName: 'B', name: 'B', seconds: null },
    ]);
    assert.deepStrictEqual(logic.findSlowTests(leaves, { A: 12 }, 0).map(t => t.fullName), ['B', 'C']);
});

test('describeSlowTests names a single test and totals several', () => {
    assert.match(logic.describeSlowTests([{ name: 'Deep', seconds: 443 }]).title, /^Deep held Unity for 7 min/);
    assert.match(logic.describeSlowTests([{ name: 'Deep', seconds: null }]).title, /\[Explicit\]/);
    assert.match(logic.describeSlowTests([{ name: 'A', seconds: 30 }, { name: 'B', seconds: 45 }]).title, /^2 slow tests held Unity for 75 s/);
});

test('LineBuffer holds partial lines and multi-byte characters until complete', () => {
    const buffer = new logic.LineBuffer();
    const bytes = Buffer.from('{"a":"ñ"}\n{"b":1}\n');
    assert.deepStrictEqual(buffer.push(bytes.subarray(0, 7)), []);
    assert.deepStrictEqual(buffer.push(bytes.subarray(7, 12)), ['{"a":"ñ"}']);
    assert.deepStrictEqual(buffer.push(bytes.subarray(12)), ['{"b":1}']);
});

test('locate finds the declaration, not an earlier call', () => {
    const text = [
        'public class FooTests',
        '{',
        '    void Helper() { Adds(); }',
        '    return Adds();',
        '    [Test] public void Adds() { }',
        '}',
    ].join('\n');
    const classes = logic.indexSources([{ path: 'Foo.cs', text }]);
    assert.deepStrictEqual(logic.locate({ typeName: 'Ns.FooTests', methodName: 'Adds' }, classes), { path: 'Foo.cs', line: 4 });
    assert.deepStrictEqual(logic.locate({ typeName: 'Ns.FooTests', methodName: '' }, classes), { path: 'Foo.cs', line: 0 });
    assert.strictEqual(logic.locate({ typeName: '', methodName: '' }, classes), null);
});

test('namesByMode splits names by test mode without repeats', () => {
    const nodes = [
        { fullName: 'A', mode: 'edit' },
        { fullName: 'A', mode: 'edit' },
        { fullName: 'B', mode: 'play' },
    ];
    assert.deepStrictEqual(logic.namesByMode(nodes), { editNames: ['A'], playNames: ['B'] });
});

test('labelOf marks Play Mode assemblies only', () => {
    assert.strictEqual(logic.labelOf({ name: 'Tests.dll', isAssembly: true, mode: 'edit' }), 'Tests');
    assert.strictEqual(logic.labelOf({ name: 'Tests.dll', isAssembly: true, mode: 'play' }), 'Tests (Play Mode)');
    assert.strictEqual(logic.labelOf({ name: 'Tests.dll', isAssembly: false, mode: 'play' }), 'Tests.dll');
});

test('isTestAssemblyDefinition recognises new and old style test assemblies', () => {
    assert.strictEqual(logic.isTestAssemblyDefinition('{"references":["UnityEngine.TestRunner"]}'), true);
    assert.strictEqual(logic.isTestAssemblyDefinition('{"optionalUnityReferences":["TestAssemblies"]}'), true);
    assert.strictEqual(logic.isTestAssemblyDefinition('{"references":["Game.Runtime"]}'), false);
});

test('resolveUnityExecutable finds the binary inside a macOS app bundle', () => {
    assert.strictEqual(resolveUnityExecutable('/Hub/Unity.app', 'darwin'), '/Hub/Unity.app/Contents/MacOS/Unity');
    assert.strictEqual(resolveUnityExecutable('C:/Unity/Unity.exe', 'win32'), 'C:/Unity/Unity.exe');
    assert.strictEqual(resolveUnityExecutable('/opt/Unity/Editor/Unity', 'linux'), '/opt/Unity/Editor/Unity');
});

test('mapWorkerPaths points failures at the real project in both slash styles', () => {
    const worker = 'C:\\Game-TestWorker';
    const project = 'C:\\Game';
    assert.strictEqual(mapWorkerPaths('in C:\\Game-TestWorker\\Assets\\A.cs:1', worker, project), 'in C:\\Game\\Assets\\A.cs:1');
    assert.strictEqual(mapWorkerPaths('(at C:/Game-TestWorker/Assets/A.cs:1)', worker, project), '(at C:/Game/Assets/A.cs:1)');
    assert.strictEqual(mapWorkerPaths('', worker, project), '');
    assert.strictEqual(mapWorkerPaths(undefined, worker, project), undefined);
});

test('parseFailureLocation reads both stack formats and skips frames outside the project', () => {
    const root = path.resolve('project');
    const inside = path.join(root, 'Assets', 'Foo.cs');
    assert.deepStrictEqual(logic.parseFailureLocation(`at Foo () [0x00000] in ${inside}:12`, root), { path: inside, line: 11 });
    assert.deepStrictEqual(logic.parseFailureLocation(`at Foo () in ${inside}:line 12`, root), { path: inside, line: 11 });
    assert.deepStrictEqual(logic.parseFailureLocation('at Foo () (at Assets/Foo.cs:12)', root), { path: inside, line: 11 });
    assert.strictEqual(logic.parseFailureLocation(`at Bar () in ${path.resolve('elsewhere', 'Bar.cs')}:line 3`, root), null);
    assert.strictEqual(logic.parseFailureLocation(undefined, root), null);
});
