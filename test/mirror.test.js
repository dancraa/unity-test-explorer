const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mirror } = require('../mirror');

function tempFolders(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { source: path.join(root, 'source'), target: path.join(root, 'target') };
}

function write(root, file, text) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
}

test('copies new files, removes extras and keeps timestamps', async t => {
    const { source, target } = tempFolders(t);
    write(source, 'a/keep.txt', 'one');
    write(target, 'extra/old.txt', 'stale');
    write(target, 'stale.txt', 'stale');

    await mirror(source, target);

    assert.strictEqual(fs.readFileSync(path.join(target, 'a/keep.txt'), 'utf8'), 'one');
    assert.strictEqual(fs.existsSync(path.join(target, 'extra')), false);
    assert.strictEqual(fs.existsSync(path.join(target, 'stale.txt')), false);
    const difference = fs.statSync(path.join(source, 'a/keep.txt')).mtimeMs - fs.statSync(path.join(target, 'a/keep.txt')).mtimeMs;
    assert.ok(Math.abs(difference) < 2000);
});

test('a second run copies nothing, and an edit in the target is overwritten', async t => {
    const { source, target } = tempFolders(t);
    write(source, 'file.txt', 'original');
    await mirror(source, target);
    assert.strictEqual((await mirror(source, target)).copied, 0);

    write(target, 'file.txt', 'changed in target');
    assert.strictEqual((await mirror(source, target)).copied, 1);
    assert.strictEqual(fs.readFileSync(path.join(target, 'file.txt'), 'utf8'), 'original');
});

test('excluded names are neither copied nor deleted', async t => {
    const { source, target } = tempFolders(t);
    write(source, 'manifest.json', 'from source');
    write(source, 'other.txt', 'copied');
    write(target, 'manifest.json', 'patched in target');

    await mirror(source, target, { excludeNames: ['manifest.json'] });

    assert.strictEqual(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'), 'patched in target');
    assert.strictEqual(fs.readFileSync(path.join(target, 'other.txt'), 'utf8'), 'copied');
});

test('never changes the source', async t => {
    const { source, target } = tempFolders(t);
    write(source, 'file.txt', 'original');
    write(target, 'only-in-target.txt', 'x');
    const before = fs.readdirSync(source);

    await mirror(source, target);

    assert.deepStrictEqual(fs.readdirSync(source), before);
    assert.strictEqual(fs.readFileSync(path.join(source, 'file.txt'), 'utf8'), 'original');
});
