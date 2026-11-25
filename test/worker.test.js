const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TestWorker, withProductName } = require('../worker');

const SETTINGS = '%YAML 1.1\nPlayerSettings:\n  companyName: Me\n  productName: My Game\n  defaultCursor: {fileID: 0}\n';

function tempWorker(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const worker = new TestWorker(path.join(root, 'Game'));
    fs.mkdirSync(worker.stateDir, { recursive: true });
    return worker;
}

test('renames only the product, whatever its name looks like', () => {
    assert.strictEqual(withProductName(SETTINGS, 'Game-TestWorker'), SETTINGS.replace('My Game', '"Game-TestWorker"'));
    const wrapped = SETTINGS.replace('My Game', '"A very long name\n    that continues"');
    assert.strictEqual(withProductName(wrapped, 'X'), SETTINGS.replace('My Game', '"X"'));
    assert.strictEqual(withProductName(SETTINGS, '$& "quoted"').includes('productName: "$& \\"quoted\\""'), true);
});

test('refuses to separate saves with binary settings', () => {
    assert.throws(() => withProductName('\u0000binary', 'X'), /Force Text/);
});

test('refuses to start without memory, or waits for it', async t => {
    const worker = tempWorker(t);
    worker.freeMemoryGb = () => 1;
    const refused = await worker.run({ onEvent: () => {} });
    assert.match(refused.message, /1\.0 GB/);

    const cancellation = { isCancellationRequested: false };
    const waiting = await worker.run({
        wait: true,
        cancellation,
        onEvent: () => {},
        onStatus: text => {
            assert.match(text, /Waiting for more/);
            cancellation.isCancellationRequested = true;
        },
    });
    assert.strictEqual(waiting.type, 'cancelled');
    assert.strictEqual(worker.lock.read(), null);
});

test('remembers the last failures, and the ones an interrupted run did not reach', t => {
    const worker = tempWorker(t);
    assert.strictEqual(worker.readLastFailed(), null);

    worker.recordRun(new Map([['A', 'failed'], ['B', 'passed'], ['C', 'inconclusive'], ['D', 'skipped']]), true);
    assert.deepStrictEqual(worker.readLastFailed(), ['A', 'C']);

    worker.recordRun(new Map([['A', 'passed'], ['E', 'started']]), false);
    assert.deepStrictEqual(worker.readLastFailed(), ['E', 'C']);

    worker.recordRun(new Map([['E', 'passed']]), true);
    assert.deepStrictEqual(worker.readLastFailed(), []);
});
