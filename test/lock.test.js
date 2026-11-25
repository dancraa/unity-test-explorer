const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkerLock, describeHolder, isProcessAlive, isWorkerProcess, killTree } = require('../lock');

const DEAD_PID = spawnSync(process.execPath, ['-e', '']).pid;

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function idleProcess(t, ...args) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ...args], { stdio: 'ignore' });
    t.after(() => child.kill());
    return child;
}

test('only one holder at a time, and it can be taken again once released', async t => {
    const dir = tempDir(t);
    const first = new WorkerLock(dir);
    const second = new WorkerLock(dir);
    assert.strictEqual(await first.tryAcquire(), true);
    assert.strictEqual(await second.tryAcquire(), false);
    second.release();
    assert.notStrictEqual(first.read(), null, 'releasing a lock never held leaves it alone');
    first.release();
    assert.strictEqual(await second.tryAcquire(), true);
    second.release();
});

test('a lock left by dead processes is free', async t => {
    const dir = tempDir(t);
    fs.writeFileSync(path.join(dir, 'run.pid'), String(DEAD_PID));
    assert.strictEqual(await new WorkerLock(dir).tryAcquire(), true);
});

test('a lock being written is not free', async t => {
    const dir = tempDir(t);
    fs.writeFileSync(path.join(dir, 'run.pid'), '');
    assert.strictEqual(await new WorkerLock(dir).tryAcquire(), false);
});

test('still held after Unity exits, until the owner has read its results', async t => {
    const dir = tempDir(t);
    const lock = new WorkerLock(dir);
    await lock.tryAcquire();
    lock.setUnity(DEAD_PID);
    assert.strictEqual(await new WorkerLock(dir).tryAcquire(), false);
    lock.release();
});

test('tells a Unity whose owner was killed from one started by an older version', t => {
    const dir = tempDir(t);
    const unity = idleProcess(t);
    fs.writeFileSync(path.join(dir, 'run.pid'), String(unity.pid));
    assert.strictEqual(new WorkerLock(dir).read().orphaned, false);

    fs.writeFileSync(path.join(dir, 'run-info.json'), JSON.stringify({ owner: DEAD_PID, unity: unity.pid, startedAt: 1 }));
    assert.strictEqual(new WorkerLock(dir).read().orphaned, true);

    fs.writeFileSync(path.join(dir, 'run-info.json'), JSON.stringify({ owner: DEAD_PID, unity: DEAD_PID, startedAt: 1 }));
    assert.strictEqual(new WorkerLock(dir).read().orphaned, false, 'details of an earlier run are ignored');
});

test('a stop request from before the run is cleared', async t => {
    const dir = tempDir(t);
    const lock = new WorkerLock(dir);
    lock.requestStop();
    await lock.tryAcquire();
    assert.strictEqual(lock.isStopRequested(), false);
    lock.release();
});

test('only kills a process that belongs to the worker', async t => {
    const root = path.join(tempDir(t), 'Juego Din00e1mico-TestWorker');
    const worker = idleProcess(t, '-projectPath', root);
    const other = idleProcess(t);
    assert.strictEqual(isWorkerProcess(worker.pid, root), true);
    if (process.platform === 'win32') assert.strictEqual(isWorkerProcess(worker.pid, root.replace(/^./, c => c.toLowerCase())), true);
    assert.strictEqual(isWorkerProcess(other.pid, root), false);
    assert.strictEqual(isWorkerProcess(DEAD_PID, root), false);
    assert.strictEqual(isWorkerProcess(null, root), false);

    const exited = new Promise(resolve => worker.on('exit', resolve));
    killTree(worker.pid);
    await exited;
    assert.strictEqual(isProcessAlive(worker.pid), false);
});

test('says who holds the lock and for how long', async t => {
    const dir = tempDir(t);
    const lock = new WorkerLock(dir);
    await lock.tryAcquire('VS Code');
    const state = new WorkerLock(dir).read();
    assert.strictEqual(describeHolder(state, state.startedAt + 1000), 'started less than a minute ago by VS Code');
    assert.strictEqual(describeHolder(state, state.startedAt + 180000), 'started 3 min ago by VS Code');
    lock.release();

    fs.writeFileSync(path.join(dir, 'run.pid'), String(process.pid));
    assert.strictEqual(describeHolder(lock.read()), 'started by an older version');
});
