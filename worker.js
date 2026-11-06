// Runs tests in a headless Unity on a one-way mirror of the project, so the open Editor stays free.
// The mirror is never linked to the project: Unity writes into its project folder as it works.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventTail } = require('./events');
const { installedVersion } = require('./install');
const { mirror } = require('./mirror');

const POLL_MS = 500;
const MIN_FREE_MEMORY_GB = 4;
// Long enough for a first run, which compiles every assembly.
const FIRST_EVENT_TIMEOUT_MS = 15 * 60 * 1000;
const EXIT_GRACE_MS = 30000;
const LOG_ERROR_LIMIT = 5;
const CONFIG_FILE = '.unity-test-worker.json';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** Rewrites worker paths in test output so failures point at the real project. */
function mapWorkerPaths(text, workerRoot, projectRoot) {
    if (!text) return text;
    const forward = p => p.replace(/\\/g, '/');
    return text.split(workerRoot).join(projectRoot).split(forward(workerRoot)).join(forward(projectRoot));
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
        this.pidPath = path.join(this.stateDir, 'run.pid');
        this.unityPath = path.join(this.stateDir, 'unity.json');
        this.eventsPath = path.join(this.stateDir, 'events.ndjson');
        this.runPath = path.join(this.stateDir, 'run.json');
        this.logPath = path.join(this.stateDir, 'unity.log');

        const configFile = path.join(this.projectRoot, CONFIG_FILE);
        this.config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
    }

    syncManifest() {
        const manifest = JSON.parse(fs.readFileSync(path.join(this.projectRoot, 'Packages', 'manifest.json'), 'utf8'));
        (this.config.excludePackages || []).forEach(name => delete manifest.dependencies[name]);

        const target = path.join(this.workerRoot, 'Packages', 'manifest.json');
        const text = JSON.stringify(manifest, null, 2);
        if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === text) return;

        // Rewritten only on a real change, because a new timestamp makes Unity resolve packages again.
        fs.writeFileSync(target, text);
        fs.rmSync(path.join(this.workerRoot, 'Packages', 'packages-lock.json'), { force: true });
    }

    async sync() {
        const isFirstRun = !fs.existsSync(path.join(this.workerRoot, 'Library'));
        fs.mkdirSync(this.stateDir, { recursive: true });
        const copy = (folder, options) => mirror(path.join(this.projectRoot, folder), path.join(this.workerRoot, folder), options);

        if (isFirstRun) {
            // The open Editor holds some of these files. Unity rebuilds whatever is skipped.
            await copy('Library', {
                excludeNames: ['EditorInstance.json', 'VsCodeTests', 'UnityLockfile', 'ArtifactDB-lock', 'SourceAssetDB-lock'],
                tolerateLockedFiles: true,
            });
        }
        await copy('Assets');
        await copy('ProjectSettings');
        await copy('Packages', { excludeNames: ['manifest.json', 'packages-lock.json'] });
        this.syncManifest();

        for (const file of this.config.extraFiles || []) {
            const target = path.join(this.workerRoot, file);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(path.join(this.projectRoot, file), target);
        }
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

    readLogErrors() {
        if (!fs.existsSync(this.logPath)) return [];
        const errors = fs.readFileSync(this.logPath, 'utf8').split(/\r?\n/).filter(line => /error CS\d+|Aborting batchmode/.test(line));
        return [...new Set(errors)].slice(0, LOG_ERROR_LIMIT).map(line => mapWorkerPaths(line, this.workerRoot, this.projectRoot));
    }

    // Unity starts child processes, so the whole tree has to go.
    kill(unity) {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/PID', String(unity.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
            return;
        }
        try {
            process.kill(-unity.pid, 'SIGKILL');
        } catch {
            unity.kill('SIGKILL');
        }
    }

    /**
     * Syncs and runs the named tests, or every test when both lists are empty. Resolves with the
     * final event: `done`, `error` or `cancelled`. `onStatus` receives progress text.
     */
    async run({ editNames = [], playNames = [], onEvent, onStatus = () => {}, cancellation }) {
        const fail = message => ({ type: 'error', message });

        if (installedVersion(this.projectRoot) === null) {
            return fail('The test bridge package is not installed in this project.');
        }
        if (fs.existsSync(this.pidPath) && isProcessAlive(Number(fs.readFileSync(this.pidPath, 'utf8')))) {
            return fail('The test worker is already running. Wait for it to finish or cancel it.');
        }
        const freeGb = os.freemem() / 1024 ** 3;
        if (freeGb < MIN_FREE_MEMORY_GB) {
            return fail(`Only ${freeGb.toFixed(1)} GB of memory is free and the worker needs about ${MIN_FREE_MEMORY_GB} GB.`);
        }

        let unityExe;
        try {
            unityExe = this.findUnity();
            onStatus('Syncing the worker copy...');
            await this.sync();
        } catch (error) {
            return fail(error.message);
        }
        if (cancellation && cancellation.isCancellationRequested) return { type: 'cancelled' };

        fs.rmSync(this.eventsPath, { force: true });
        fs.writeFileSync(this.runPath, JSON.stringify({ editNames, playNames }));

        onStatus('Starting headless Unity...');
        const start = Date.now();
        const unity = spawn(unityExe, [
            '-batchmode',
            '-projectPath', this.workerRoot,
            '-executeMethod', 'VsCodeTests.VsCodeTestBridge.RunInWorker',
            '-vsCodeTestsWorker', this.stateDir,
            '-logFile', this.logPath,
        ], { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });

        let exitCode = null;
        let spawnError = null;
        unity.on('exit', code => { exitCode = code === null ? -1 : code; });
        unity.on('error', error => { spawnError = error; exitCode = -1; });
        if (unity.pid) fs.writeFileSync(this.pidPath, String(unity.pid));

        const tail = new EventTail(this.eventsPath);
        let seenEvent = false;
        let end = null;
        let endedAt = 0;

        try {
            while (true) {
                await sleep(POLL_MS);

                for (const event of tail.poll()) {
                    seenEvent = true;
                    event.message = mapWorkerPaths(event.message, this.workerRoot, this.projectRoot);
                    event.stack = mapWorkerPaths(event.stack, this.workerRoot, this.projectRoot);
                    if (event.type === 'done' || event.type === 'error') {
                        end = event;
                        endedAt = Date.now();
                    } else {
                        onEvent(event);
                    }
                }

                if (exitCode !== null) break;

                if (end && Date.now() - endedAt > EXIT_GRACE_MS) {
                    this.kill(unity);
                    break;
                }
                if (cancellation && cancellation.isCancellationRequested && !end) {
                    this.kill(unity);
                    return { type: 'cancelled' };
                }
                if (!seenEvent && Date.now() - start > FIRST_EVENT_TIMEOUT_MS) {
                    this.kill(unity);
                    return fail(`The worker did not start any tests. See ${this.logPath}`);
                }
            }
        } finally {
            fs.rmSync(this.pidPath, { force: true });
        }

        if (end) return end;
        if (spawnError) return fail(`Could not start Unity: ${spawnError.message}`);

        const errors = this.readLogErrors();
        const detail = errors.length > 0 ? errors.join('\n') : `See ${this.logPath}`;
        return fail(`The worker exited with code ${exitCode} before the tests finished.\n${detail}`);
    }
}

module.exports = { TestWorker, mapWorkerPaths, resolveUnityExecutable };
