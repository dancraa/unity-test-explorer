const test = require('node:test');
const assert = require('node:assert');
const { resolveNames, resolveFailed, listTests, classOf } = require('../select');

// Builds a list like the bridge's: parents before children, indexed by position.
function list(...roots) {
    const flat = [];
    const add = (node, parent) => {
        const index = flat.length;
        const { children = [], ...rest } = node;
        flat.push({ isAssembly: false, isSuite: children.length > 0, typeName: '', methodName: '', isExplicit: false, ...rest, parent });
        children.forEach(child => add({ mode: node.mode, ...child }, index));
    };
    roots.forEach(root => add(root, -1));
    return flat;
}

function method(type, name) {
    return { name, fullName: `${type}.${name}`, typeName: type, methodName: name };
}

function fixture(type, ...methods) {
    return { name: type.split('.').pop(), fullName: type, typeName: type, isSuite: true, children: methods.map(name => method(type, name)) };
}

function cases(type, name, ...args) {
    return { ...method(type, name), isSuite: true, children: args.map(arg => ({ ...method(type, name), name: `${name}(${arg})`, fullName: `${type}.${name}(${arg})` })) };
}

const TESTS = list(
    {
        name: 'Project', fullName: 'Project', mode: 'edit', children: [{
            name: 'Edit.dll', fullName: 'C:/Edit.dll', isAssembly: true, children: [{
                name: 'Game', fullName: 'Game', children: [
                    fixture('Game.PlayerTests', 'Jumps', 'Runs'),
                    { ...fixture('Game.ParseTests'), children: [cases('Game.ParseTests', 'Parses', '1', '"a.b"')] },
                    {
                        name: 'A', fullName: 'Game.A', children: [fixture('Game.A.SharedTests', 'Works')],
                    },
                    {
                        // A [SetUpFixture] names its suite after the namespace it covers.
                        name: 'B', fullName: 'Game.B', typeName: 'Game.B.Setup', isSuite: true, children: [fixture('Game.B.SharedTests', 'Works')],
                    },
                    {
                        // A class with several [TestFixture]s.
                        name: 'ManyTests', fullName: 'Game.ManyTests', children: [
                            { ...fixture('Game.ManyTests', 'Works'), name: 'ManyTests(1)', fullName: 'Game.ManyTests(1)' },
                        ],
                    },
                ],
            }],
        }],
    },
    {
        name: 'Project', fullName: 'Project', mode: 'play', children: [{
            name: 'Play.dll', fullName: 'C:/Play.dll', isAssembly: true, children: [fixture('Game.SceneTests', 'Loads')],
        }],
    },
);

function matchedName(name, mode = 'all') {
    const { matched } = resolveNames(TESTS, [name], mode);
    return matched.length === 1 ? matched[0].fullName : null;
}

test('finds a full name, a class and Class.Method', () => {
    assert.strictEqual(matchedName('Game.PlayerTests'), 'Game.PlayerTests');
    assert.strictEqual(matchedName('PlayerTests'), 'Game.PlayerTests');
    assert.strictEqual(matchedName('PlayerTests.Jumps'), 'Game.PlayerTests.Jumps');
    assert.strictEqual(matchedName('A.SharedTests'), 'Game.A.SharedTests');
    assert.strictEqual(matchedName('ParseTests.Parses'), 'Game.ParseTests.Parses');
    assert.strictEqual(matchedName('ParseTests.Parses("a.b")'), 'Game.ParseTests.Parses("a.b")');
    assert.strictEqual(matchedName('ManyTests'), 'Game.ManyTests');
});

test('a class or method is sent by name, and a namespace as its tests', () => {
    assert.deepStrictEqual(resolveNames(TESTS, ['PlayerTests', 'SceneTests.Loads'], 'all').selection, {
        mode: 'all', editNames: ['Game.PlayerTests'], playNames: ['Game.SceneTests.Loads'],
    });
    assert.deepStrictEqual(resolveNames(TESTS, ['Game.A'], 'all').selection, {
        mode: 'edit', editNames: ['Game.A.SharedTests.Works'], playNames: [],
    });
});

test('a bare namespace or method is not a match', () => {
    for (const name of ['A', 'B', 'Jumps', 'Tests']) assert.strictEqual(matchedName(name), null, name);
});

test('one valid name does not hide a misspelled one', () => {
    const result = resolveNames(TESTS, ['PlayerTests', 'PlayerTest'], 'all');
    assert.strictEqual(result.selection, null);
    assert.deepStrictEqual(result.matched.map(m => m.name), ['PlayerTests']);
    assert.deepStrictEqual(result.unmatched, [{ name: 'PlayerTest', suggestions: ['Game.PlayerTests'], otherMode: null }]);
});

test('suggests a method, or a full name with the wrong namespace or case', () => {
    const suggestions = name => resolveNames(TESTS, [name], 'all').unmatched[0].suggestions;
    assert.strictEqual(suggestions('Jumps')[0], 'Game.PlayerTests.Jumps');
    assert.strictEqual(suggestions('playertests')[0], 'Game.PlayerTests');
    assert.strictEqual(suggestions('Gane.PlayerTests')[0], 'Game.PlayerTests');
    assert.deepStrictEqual(suggestions('Zzzzzzzz'), []);
});

test('lists the candidates when several classes share a name', () => {
    const result = resolveNames(TESTS, ['SharedTests'], 'all');
    assert.strictEqual(result.selection, null);
    assert.deepStrictEqual(result.ambiguous, [{ name: 'SharedTests', candidates: ['Game.A.SharedTests', 'Game.B.SharedTests'] }]);
});

test('--mode limits what runs, with and without names', () => {
    assert.deepStrictEqual(resolveNames(TESTS, [], 'edit').selection, { mode: 'edit', editNames: [], playNames: [] });
    assert.deepStrictEqual(resolveNames(TESTS, [], 'all').selection, { mode: 'all', editNames: [], playNames: [] });
    assert.strictEqual(resolveNames(TESTS, [], 'play').leaves.length, 1);
    assert.deepStrictEqual(resolveNames(TESTS, ['SceneTests'], 'edit').unmatched, [{ name: 'SceneTests', suggestions: [], otherMode: 'play' }]);
});

test('an empty project has nothing to select', () => {
    const empty = list({ name: 'Project', fullName: 'Project', mode: 'edit', isSuite: true });
    assert.strictEqual(resolveNames(empty, [], 'all').selection, null);
});

test('a test named twice counts once', () => {
    assert.strictEqual(resolveNames(TESTS, ['PlayerTests', 'PlayerTests.Jumps'], 'all').leaves.length, 2);
});

test('lists by fragment or wildcard', () => {
    const names = (patterns, mode = 'all') => listTests(TESTS, patterns, mode).map(node => node.fullName);
    assert.deepStrictEqual(names(['playertests']), ['Game.PlayerTests.Jumps', 'Game.PlayerTests.Runs']);
    assert.deepStrictEqual(names(['*.Works']).length, 3);
    assert.deepStrictEqual(names(['PlayerTests*']), []);
    assert.deepStrictEqual(names(['Game'], 'play'), ['Game.SceneTests.Loads']);
    assert.strictEqual(names([]).length, 8);
});

test('finds the class of a test whose arguments contain dots', () => {
    assert.strictEqual(classOf({ name: 'Parses("a.b")', fullName: 'Game.ParseTests.Parses("a.b")' }), 'Game.ParseTests');
});

test('rerunning failures skips the ones that are gone, and never runs everything', () => {
    const result = resolveFailed(TESTS, ['Game.PlayerTests.Jumps', 'Game.PlayerTests.Removed', 'Game.SceneTests.Loads'], 'edit');
    assert.deepStrictEqual(result.skipped, ['Game.PlayerTests.Removed', 'Game.SceneTests.Loads']);
    assert.deepStrictEqual(result.selection, { mode: 'edit', editNames: ['Game.PlayerTests.Jumps'], playNames: [] });
    assert.strictEqual(resolveFailed(TESTS, ['Game.PlayerTests.Removed'], 'all').selection, null);
});
