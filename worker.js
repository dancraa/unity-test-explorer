// Runs tests in a headless Unity on a one-way mirror of the project, so the open Editor stays free.
// The mirror is never linked to the project: Unity writes into its project folder as it works.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventTail } = require('./events');
const { BUNDLED_PACKAGE, PACKAGE_NAME } = require('./install');
const { WorkerLock, describeHolder, isProcessAlive, isWorkerProcess, killTree } = require('./lock');
const { mirror, isSameFile, measureTolerance } = require('./mirror');

const POLL_MS = 500;
const WAIT_POLL_MS = 2000;
const MIN_FREE_MEMORY_GB = 4;
// Long enough for a first run, which compiles every assembly.
const FIRST_EVENT_TIMEOUT_MS = 15 * 60 * 1000;
const EXIT_GRACE_MS = 30000;
const KILL_TIMEOUT_MS = 10000;
// A run checks for a stop request between files and between events, so it answers quickly.
const STOP_TIMEOUT_MS = 15000;
const LOG_ERROR_LIMIT = 5;
const CONFIG_FILE = '.unity-test-worker.json';
const PROJECT_SETTINGS = 'ProjectSettings.asset';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntil(condition, timeoutMs, pollMs = 100) {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs) return false;
        await sleep(pollMs);
    }
    return true;
}

// Renamed into place so Unity never reads a half-written file.
function writeJson(file, value) {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
    fs.renameSync(`${file}.tmp`, file);
}

/** Rewrites worker paths in test output so failures point at the real project. */
function mapWorkerPaths(text, workerRoot, projectRoot, platform = process.platform) {
    if (!text) return text;
    const forward = p => p.replace(/\\/g, '/');
    // VS Code writes Windows drive letters in lower case and Unity in upper case.
    const flags = platform === 'win32' ? 'gi' : 'g';
    const replace = (from, to, input) => input.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags), () => to);
    return replace(forward(workerRoot), forward(projectRoot), replace(workerRoot, projectRoot, text));
}

/** Gives the worker its own product name, so its persistentDataPath and PlayerPrefs aren't the Editor's. */
function withProductName(settings, name) {
    // A long value continues on deeper-indented lines.
    const line = /^  productName:.*(?:\r?\n {4,}.*)*/m;
    if (!settings.startsWith('%YAML') || !line.test(settings)) {
        throw new Error('separateSaves needs text project settings. Set Asset Serialization to Force Text in Unity.');
    }
    return settings.replace(line, () => `  productName: ${JSON.stringify(name)}`);
}

/** EditorInstance.json names the app bundle on macOS, while the executable sits inside it. */
function resolveUnityExecutable(appPath, platform = process.platform) {
    return platform === 'darwin' && appPath.endsWith('.app') ? path.posix.join(appPath, 'Contents', 'MacOS', 'Unity') : appPath;
}

class TestWorker {
    constructor(projectRoot) {
        this.projectRoot = path.resolve(projectRoot);
        this.workerRoot = `${this.projectRoot}-TestWorker`;
        this.stateDir = path.join(this.workerRoot, 'WorkerState');
        this.lock = new WorkerLock(this.stateDir);
        this.unityPath = path.join(this.stateDir, 'unity.json');
        this.eventsPath = path.join(this.stateDir, 'events.ndjson');
        this.runPath = path.join(this.stateDir, 'run.json');
        this.commandPath = path.join(this.stateDir, 'command.json');
        this.lastRunPath = path.join(this.stateDir, 'last-run.json');
        this.libraryCopyPath = path.join(this.stateDir, 'library-copy-incomplete');
        this.logPath = path.join(this.stateDir, 'unity.log');

        const configFile = path.join(this.projectRoot, CONFIG_FILE);
        this.config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
    }

    /** Returns whether anything changed. */
    syncManifest() {
        const manifest = JSON.parse(fs.readFileSync(path.join(this.projectRoot, 'Packages', 'manifest.json'), 'utf8'));
        (this.config.excludePackages || []).forEach(name => delete manifest.dependencies[name]);

        const target = path.join(this.workerRoot, 'Packages', 'manifest.json');
        const text = JSON.stringify(manifest, null, 2);
        if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === text) return false;

        // Rewritten only on a real change, because a new timestamp makes Unity resolve packages again.
        fs.writeFileSync(target, text);
        fs.rmSync(path.join(this.workerRoot, 'Packages', 'packages-lock.json'), { force: true });
        return true;
    }

    syncProjectSettings(stats) {
        const source = path.join(this.projectRoot, 'ProjectSettings', PROJECT_SETTINGS);
        const target = path.join(this.workerRoot, 'ProjectSettings', PROJECT_SETTINGS);
        const text = withProductName(fs.readFileSync(source, 'utf8'), path.basename(this.workerRoot));
        const targetStat = fs.statSync(target, { throwIfNoEntry: false });
        if (targetStat && fs.readFileSync(target, 'utf8') === text) return;

        fs.writeFileSync(target, text);
        if (targetStat && targetStat.mtimeMs > fs.statSync(source).mtimeMs) stats.restored++;
        else stats.changed++;
    }

    /** Returns how many files changed, and how many the worker had changed itself. Null if cancelled partway. */
    async sync(isCancelled) {
        const isFirstRun = !fs.existsSync(path.join(this.workerRoot, 'Library')) || fs.existsSync(this.libraryCopyPath);
        const stats = { isFirstRun, changed: 0, restored: 0 };
        const toleranceMs = await measureTolerance(this.stateDir);
        const copy = async (folder, options) => {
            const result = await mirror(path.join(this.projectRoot, folder), path.join(this.workerRoot, folder), { isCancelled, toleranceMs, ...options });
            stats.changed += result.copied + result.deleted - result.restored;
            stats.restored += result.restored;
        };

        if (isFirstRun) {
            // Marks an interrupted copy, so the next run finishes it.
            fs.writeFileSync(this.libraryCopyPath, '');
            // The open Editor holds some of these files. Unity rebuilds whatever is skipped.
            await copy('Library', {
                excludeNames: ['EditorInstance.json', 'VsCodeTests', 'UnityLockfile', 'ArtifactDB-lock', 'SourceAssetDB-lock'],
                tolerateLockedFiles: true,
            });
            if (isCancelled()) return null;
            fs.rmSync(this.libraryCopyPath);
        }
        await copy('Assets');
        await copy('ProjectSettings', { excludeNames: this.config.separateSaves ? [PROJECT_SETTINGS] : [] });
        if (this.config.separateSaves) this.syncProjectSettings(stats);
        await copy('Packages', { excludeNames: ['manifest.json', 'packages-lock.json', PACKAGE_NAME] });
        // The worker gets the bridge that came with this code, so the two can't disagree.
        await mirror(BUNDLED_PACKAGE, path.join(this.workerRoot, 'Packages', PACKAGE_NAME), { isCancelled, toleranceMs });
        if (isCancelled()) return null;
        if (this.syncManifest()) stats.changed++;

        for (const file of this.config.extraFiles || []) {
            const source = path.join(this.projectRoot, file);
            const target = path.join(this.workerRoot, file);
            const sourceStat = fs.statSync(source);
            if (isSameFile(sourceStat, fs.statSync(target, { throwIfNoEntry: false }) || null, toleranceMs)) continue;
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(source, target);
            fs.utimesSync(target, sourceStat.atime, sourceStat.mtime);
            stats.changed++;
        }
        return stats;
    }

    /** Uses the open Editor's install, or the last one seen so runs also work with Unity closed. */
    findUnity() {
        const version = /m_EditorVersion:\s*(\S+)/.exec(
            fs.readFileSync(path.join(this.projectRoot, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8'))[1];
        const instance = path.join(this.projectRoot, 'Library', 'EditorInstance.json');

        let unity = null;
        if (fs.existsSync(instance)) {
            const { app_path: appPath, version: appVersion } = JSON.parse(fs.readFileSync(instance, 'utf8'));
            unity = { path: resolveUnityExecutable(appPath), version: appVersion };
            fs.mkdirSync(this.stateDir, { recursive: true });
            fs.writeFileSync(this.unityPath, JSON.stringify(unity));
        } else if (fs.existsSync(this.unityPath)) {
            unity = JSON.parse(fs.readFileSync(this.unityPath, 'utf8'));
        }

        if (!unity || !fs.existsSync(unity.path)) {
            throw new Error('Unity install not found. Open the project in Unity once, then try again.');
        }
        if (unity.version !== version) {
            throw new Error(`The project uses Unity ${version} but the last install seen is ${unity.version}. Open the project in Unity once, then try again.`);
        }
        return unity.path;
    }

    /**
     * Compile errors, and other lines saying why Unity gave up. A log not written since `start` is
     * from an earlier run. It can't be deleted up front, because Unity's children can outlive it and hold it open.
     */
    readLogErrors(start) {
        const stat = fs.statSync(this.logPath, { throwIfNoEntry: false });
        if (!stat || stat.mtimeMs < start) return { compile: [], other: [] };
        const lines = fs.readFileSync(this.logPath, 'utf8').split(/\r?\n/);
        const matching = pattern => [...new Set(lines.filter(line => pattern.test(line)))]
            .map(line => mapWorkerPaths(line.trim(), this.workerRoot, this.projectRoot));
        return { compile: matching(/\berror [A-Z]+\d+\s*:/), other: matching(/Aborting batchmode/) };
    }

    async killUnity(pid) {
        killTree(pid);
        // Unity's own project lock would fail a run started before it's really gone.
        await waitUntil(() => !isProcessAlive(pid), KILL_TIMEOUT_MS);
    }

    freeMemoryGb() {
        return os.freemem() / 1024 ** 3;
    }

    /** Resolves null once there's enough memory, or the event to end the run with. */
    async checkMemory({ wait, isCancelled, onStatus }) {
        let announced = false;
        while (this.freeMemoryGb() < MIN_FREE_MEMORY_GB) {
            const shortage = `Only ${this.freeMemoryGb().toFixed(1)} GB of memory is free and the worker needs about ${MIN_FREE_MEMORY_GB} GB.`;
            if (!wait) return { type: 'error', message: shortage };
            if (!announced) onStatus(`${shortage} Waiting for more...`);
            announced = true;
            await sleep(WAIT_POLL_MS);
            if (isCancelled()) return { type: 'cancelled' };
        }
        return null;
    }

    /** The full names of the tests that failed in the last run, or null if none is recorded. */
    readLastFailed() {
        try {
            return JSON.parse(fs.readFileSync(this.lastRunPath, 'utf8')).failed;
        } catch {
            return null;
        }
    }

    /** A run cut short keeps the earlier failures it didn't get to, and counts the test it stopped in. */
    recordRun(statuses, completed) {
        const failed = [...statuses].filter(([, status]) => status !== 'passed' && status !== 'skipped').map(([name]) => name);
        const unreached = completed ? [] : (this.readLastFailed() || []).filter(name => !statuses.has(name));
        writeJson(this.lastRunPath, { failed: [...failed, ...unreached] });
    }

    /** Stops whatever run is using the worker, from any process. Resolves what it stopped, or null if there was none. */
    async stop() {
        const state = this.lock.read();
        if (state === null) return null;

        if (state.owner !== null && !state.orphaned) {
            this.lock.requestStop();
            const released = () => {
                const current = this.lock.read();
                return current === null || current.startedAt !== state.startedAt;
            };
            if (await waitUntil(released, STOP_TIMEOUT_MS)) return state;
        }
        if (isWorkerProcess(state.unity, this.workerRoot)) await this.killUnity(state.unity);
        this.lock.clear();
        return state;
    }

    /** Resolves null once the lock is taken, or the event to end the run with. */
    async acquireLock({ startedBy, wait, isCancelled, onStatus }) {
        let announced = false;
        while (!await this.lock.tryAcquire(startedBy)) {
            const state = this.lock.read();
            if (state === null) continue;
            if (state.orphaned) {
                // Its results have nowhere to go. A process that only reused the id is left alone.
                if (isWorkerProcess(state.unity, this.workerRoot)) {
                    onStatus('Stopping a worker left behind by an interrupted run...');
                    await this.killUnity(state.unity);
                }
                this.lock.clear();
                continue;
            }
            if (!wait) {
                return { type: 'error', message: `The test worker is already running (${describeHolder(state)}). Wait for it to finish or cancel it. On the command line, --wait queues behind it and --stop ends it.` };
            }
            if (!announced) onStatus(`Waiting for another run to finish (${describeHolder(state)})...`);
            announced = true;
            await sleep(WAIT_POLL_MS);
            if (isCancelled()) return { type: 'cancelled' };
        }
        return null;
    }

    /**
     * Syncs and runs the named tests, or every test of the mode when both lists are empty. With
     * `select`, Unity lists its tests first; `select` gets them and returns the names to run, or
     * null to run none. With `check`, it only compiles. Resolves with the final event: `done`,
     * `error` or `cancelled`. `onStatus` receives progress text. `wait` queues behind another run,
     * and for memory. `startedBy` is what others are told holds the worker.
     */
    async run({ editNames = [], playNames = [], mode = 'all', check = false, select = null, wait = false, startedBy = 'another program', onEvent, onStatus = () => {}, cancellation }) {
        const isCancelled = () => Boolean(cancellation && cancellation.isCancellationRequested);
        fs.mkdirSync(this.stateDir, { recursive: true });

        const busy = await this.acquireLock({ startedBy, wait, isCancelled, onStatus });
        if (busy) return busy;
        try {
            return await this.runLocked({
                request: check ? { action: 'check' } : select ? { action: 'list' } : { action: 'run', mode, editNames, playNames },
                select,
                wait,
                onEvent,
                onStatus,
                isCancelled: () => isCancelled() || this.lock.isStopRequested(),
            });
        } finally {
            this.lock.release();
        }
    }

    async runLocked({ request, select, wait, onEvent, onStatus, isCancelled }) {
        const fail = message => ({ type: 'error', message });
        const cancelled = () => ({ type: 'cancelled', message: this.lock.isStopRequested() ? 'Stopped by unity-tests --stop.' : '' });

        const short = await this.checkMemory({ wait, isCancelled, onStatus });
        if (short) return short.type === 'cancelled' ? cancelled() : short;

        let unityExe;
        try {
            unityExe = this.findUnity();
            onStatus('Syncing the worker copy...');
            const stats = await this.sync(isCancelled);
            if (stats) onEvent({ type: 'synced', ...stats });
        } catch (error) {
            return fail(error.message);
        }
        if (isCancelled()) return cancelled();

        for (const file of [this.eventsPath, this.commandPath]) fs.rmSync(file, { force: true });
        writeJson(this.runPath, request);

        onStatus('Starting headless Unity...');
        const start = Date.now();
        const unity = spawn(unityExe, [
            '-batchmode',
            '-projectPath', this.workerRoot,
            '-executeMethod', 'VsCodeTests.VsCodeTestBridge.RunInWorker',
            '-vsCodeTestsWorker', this.stateDir,
            '-vsCodeTestsOwner', String(process.pid),
            '-logFile', this.logPath,
        ], { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });

        let exitCode = null;
        let spawnError = null;
        unity.on('exit', code => { exitCode = code === null ? -1 : code; });
        unity.on('error', error => { spawnError = error; exitCode = -1; });
        if (unity.pid) this.lock.setUnity(unity.pid);
        this.unityPid = unity.pid;

        const tail = new EventTail(this.eventsPath);
        let seenEvent = false;
        let selected = false;
        let ran = request.action === 'run';
        const statuses = new Map();
        let end = null;
        let endedAt = 0;

        const handle = event => {
            seenEvent = true;
            for (const field of ['message', 'output', 'stack']) {
                event[field] = mapWorkerPaths(event[field], this.workerRoot, this.projectRoot);
            }
            if (event.type === 'done' || event.type === 'error') {
                end = event;
                endedAt = Date.now();
            } else if (event.type !== 'list') {
                if (event.type === 'started') statuses.set(event.fullName, 'started');
                if (event.type === 'test') statuses.set(event.fullName, event.status);
                onEvent(event);
            } else if (!selected) {
                // A reload while Unity waits makes it list again.
                selected = true;
                const choice = select(event.tests);
                ran = choice !== null;
                writeJson(this.commandPath, choice ? { action: 'run', ...choice } : { action: 'exit' });
            }
        };

        try {
            while (true) {
                await sleep(POLL_MS);

                const exited = exitCode !== null;
                tail.poll().forEach(handle);
                if (exited) break;

                if (end && Date.now() - endedAt > EXIT_GRACE_MS) break;
                if (!end && isCancelled()) return cancelled();
                if (!seenEvent && Date.now() - start > FIRST_EVENT_TIMEOUT_MS) {
                    return fail(`The worker did not start any tests. See ${this.logPath}`);
                }
            }
        } finally {
            if (exitCode === null) await this.killUnity(unity.pid);
            if (ran && seenEvent) this.recordRun(statuses, end !== null && end.type === 'done');
            this.unityPid = null;
        }

        if (end) return end;
        if (spawnError) return fail(`Could not start Unity: ${spawnError.message}`);

        const { compile, other } = this.readLogErrors(start);
        if (compile.length > 0) {
            const hidden = compile.length - LOG_ERROR_LIMIT;
            const shown = compile.slice(0, LOG_ERROR_LIMIT).join('\n') + (hidden > 0 ? `\n... and ${hidden} more` : '');
            return { ...fail(`The project has compile errors.\n${shown}`), compileErrors: compile };
        }
        const detail = other.length > 0 ? other.slice(0, LOG_ERROR_LIMIT).join('\n') : `See ${this.logPath}`;
        return fail(`The worker exited with code ${exitCode} before the tests finished.\n${detail}`);
    }

    /** Ends this process's run at once, for when there's no time to wait for `run` to return. */
    abort() {
        if (this.unityPid) killTree(this.unityPid);
        this.lock.release();
    }
}

module.exports = { TestWorker, withProductName, mapWorkerPaths, resolveUnityExecutable };
