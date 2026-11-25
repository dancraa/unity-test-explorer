const test = require('node:test');
const assert = require('node:assert');
const { parseArgs, versionWarning, describeRun } = require('../cli');
const { bundledVersion } = require('../install');
const { capText, formatFailure, formatSync, formatUnresolved, toJUnit, resultOf, countResults } = require('../report');

const FAILURE = { fullName: 'Game.PlayerTests.Jumps', status: 'failed', duration: 0.25, message: 'Expected: 1', stack: 'at X', output: 'line\n'.repeat(100) };

test('reads names, flags and values', () => {
    const options = parseArgs(['--mode', 'edit', 'PlayerTests', '--timeout=90', '--wait', '--junit', 'out.xml']);
    assert.deepStrictEqual(options.names, ['PlayerTests']);
    assert.strictEqual(options.mode, 'edit');
    assert.strictEqual(options.timeout, 90);
    assert.strictEqual(options.wait, true);
    assert.strictEqual(options.junit, 'out.xml');
});

test('rejects unknown options and suggests the closest', () => {
    assert.throws(() => parseArgs(['--lsit']), /Unknown option --lsit\. Did you mean --list\?/);
    assert.throws(() => parseArgs(['-x']), /Unknown option -x/);
    assert.throws(() => parseArgs(['--list=Player']), /Unknown option/);
});

test('rejects missing values and combinations that make no sense', () => {
    assert.throws(() => parseArgs(['--project']), /--project needs a value/);
    assert.throws(() => parseArgs(['--mode', '--wait']), /--mode needs a value/);
    assert.throws(() => parseArgs(['--mode', 'both']), /--mode must be/);
    assert.throws(() => parseArgs(['--timeout', 'soon']), /--timeout must be/);
    assert.throws(() => parseArgs(['--check', '--list']), /can't be combined/);
    assert.throws(() => parseArgs(['--check', 'PlayerTests']), /doesn't take test names/);
    assert.throws(() => parseArgs(['--failed', 'PlayerTests']), /can't be combined/);
    assert.throws(() => parseArgs(['--failed', '--check']), /can't be combined/);
    assert.deepStrictEqual(parseArgs(['--list', 'Player']).names, ['Player']);
});

test('the command and bridge are released together', () => {
    assert.strictEqual(require('../package.json').version, bundledVersion());
});

test('warns only when the versions are known to differ', () => {
    assert.match(versionWarning('0.3.1', '0.4.0'), /0\.3\.1.*0\.4\.0/);
    for (const same of ['0.4.0', 'managed', null]) assert.strictEqual(versionWarning(same, '0.4.0'), null);
});

test('caps long text from either end', () => {
    assert.strictEqual(capText('a\nb\nc', 2), 'a\nb\n... 1 more line (--verbose shows all)');
    assert.strictEqual(capText('a\nb\nc', 1, { keepEnd: true }), '... 2 more lines (--verbose shows all)\nc');
    assert.strictEqual(capText('a\nb\n', 2), 'a\nb');
    assert.ok(capText('x'.repeat(5000), 2).length < 600);
});

test('a failure shows its log only in part, unless verbose', () => {
    assert.ok(formatFailure(FAILURE, false).split('\n').length < 25);
    assert.ok(formatFailure(FAILURE, true).split('\n').length > 100);
    assert.match(formatFailure(FAILURE, false), /^FAILED Game\.PlayerTests\.Jumps \(0\.25 s\)\nExpected: 1\nat X\nOutput:\n/);
});

test('says what was synced', () => {
    assert.strictEqual(formatSync({ changed: 8, restored: 0 }), 'Synced 8 changed files');
    assert.strictEqual(formatSync({ changed: 1, restored: 3 }), 'Synced 1 changed file (and restored 3 the worker had changed)');
    assert.strictEqual(formatSync({ changed: 0, restored: 0 }), 'No files changed since the last sync');
    assert.strictEqual(formatSync({ changed: 0, restored: 0, isFirstRun: true }), 'Created the worker copy');
});

test('explains each name that can\'t run', () => {
    const text = formatUnresolved({
        unmatched: [{ name: 'PlayerTest', suggestions: ['Game.PlayerTests'], otherMode: null }, { name: 'SceneTests', suggestions: [], otherMode: 'play' }],
        ambiguous: [{ name: 'SharedTests', candidates: ['A.SharedTests', 'B.SharedTests'] }],
    });
    for (const expected of ['"PlayerTest"', 'Game.PlayerTests', 'Play Mode test', 'A.SharedTests', 'B.SharedTests']) assert.ok(text.includes(expected), expected);
});

test('JUnit escapes text, and reports names that matched nothing as errors', () => {
    const events = [
        { ...FAILURE, message: 'a < b & "c"\u0000', output: 'log' },
        { fullName: 'Game.PlayerTests.Runs', status: 'passed', duration: 1 },
        { fullName: 'Game.PlayerTests.Waits', status: 'skipped', duration: 0, message: 'later' },
    ];
    const node = fullName => ({ fullName, name: fullName.split('.').pop(), typeName: 'Game.PlayerTests' });
    const xml = toJUnit({
        action: 'run', error: null, seconds: 2, counts: countResults(events), matched: [{ name: 'PlayerTests' }],
        unmatched: [{ name: 'Nope', suggestions: [] }], ambiguous: [], tests: events.map(event => resultOf(event, node(event.fullName))),
    });
    assert.match(xml, /<testsuites tests="4" failures="1" errors="1" skipped="1"/);
    assert.match(xml, /<property name="matched" value="PlayerTests"\/>/);
    assert.match(xml, /<testcase classname="unity-tests" name="Nope"><error/);
    assert.match(xml, /<testcase classname="Game\.PlayerTests" name="Jumps" time="0\.25">/);
    assert.match(xml, /message="a &lt; b &amp; &quot;c&quot;"/);
    assert.ok(!xml.includes('\u0000'));
});

test('names a run to others by what it runs, not by its options', () => {
    assert.strictEqual(describeRun(parseArgs(['--project', '/a/long/path', '--wait', 'PlayerTests'])), 'unity-tests PlayerTests');
    assert.strictEqual(describeRun(parseArgs(['--check'])), 'unity-tests --check');
});
