// Lets one worker run at a time, and tells a live run from one whose owner was killed.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SETTLE_MS = 100;
// An empty lock this fresh is still being written.
const HALF_WRITTEN_MS = 10000;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
    if (!(pid > 0)) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

// Unity starts child processes, so the whole tree has to go.
function killTree(pid) {
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        return;
    }
    for (const target of [-pid, pid]) {
        try {
            process.kill(target, 'SIGKILL');
            return;
        } catch {
            // Not a group leader, or already gone.
        }
    }
}

/** Whether a process really is this worker's Unity. Ids are reused, so a saved one is checked before it's killed. */
function isWorkerProcess(pid, workerRoot) {
    if (!isProcessAlive(pid)) return false;
    if (process.platform === 'win32') {
        // Compared inside PowerShell, because its output encoding mangles some paths. VS Code and a
        // terminal can spell the drive letter differently.
        const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p -and $p.CommandLine -and $p.CommandLine.IndexOf($env:UNITY_TESTS_WORKER, [StringComparison]::OrdinalIgnoreCase) -ge 0) { exit 0 } else { exit 1 }`;
        return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
            stdio: 'ignore',
            windowsHide: true,
            env: { ...process.env, UNITY_TESTS_WORKER: workerRoot },
        }).status === 0;
    }
    if (process.platform === 'linux') {
        const command = readOrNull(`/proc/${pid}/cmdline`);
        return command !== null && command.includes(workerRoot);
    }
    // Outside a UTF-8 locale, ps escapes other characters.
    const result = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'en_US.UTF-8' } });
    return result.status === 0 && result.stdout.includes(workerRoot);
}

function formatAge(milliseconds) {
    const minutes = Math.round(milliseconds / 60000);
    if (minutes < 1) return 'less than a minute ago';
    return minutes < 120 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

/** Says who started the run holding the lock and when. Versions before 0.4 don't record it. */
function describeHolder(state, now = Date.now()) {
    if (!state.startedAt) return 'started by an older version';
    return `started ${formatAge(now - state.startedAt)} by ${state.by}`;
}

function readOrNull(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

class WorkerLock {
    constructor(stateDir) {
        // Versions before 0.4 read only this file and expect nothing but a live process id in it.
        this.pidPath = path.join(stateDir, 'run.pid');
        this.infoPath = path.join(stateDir, 'run-info.json');
        this.stopPath = path.join(stateDir, 'stop');
        this.held = false;
    }

    readInfo(pid) {
        try {
            const info = JSON.parse(fs.readFileSync(this.infoPath, 'utf8'));
            // Left by an earlier run if it doesn't name the process holding the lock.
            return info.owner === pid || info.unity === pid ? info : null;
        } catch {
            return null;
        }
    }

    /** The current holder, or null when the lock is free or stale. `orphaned` means only its Unity is left. */
    read() {
        const text = readOrNull(this.pidPath);
        if (text === null) return null;

        const pid = Number(text);
        if (!(pid > 0)) {
            const age = Date.now() - (fs.statSync(this.pidPath, { throwIfNoEntry: false }) || { mtimeMs: 0 }).mtimeMs;
            return age < HALF_WRITTEN_MS ? { pid: 0, owner: null, unity: null, startedAt: null, by: null, orphaned: false } : null;
        }

        const info = this.readInfo(pid);
        const owner = info ? info.owner : null;
        const unity = info ? info.unity : pid;
        const ownerAlive = owner !== null && isProcessAlive(owner);
        const unityAlive = unity !== null && isProcessAlive(unity);
        if (!ownerAlive && !unityAlive) return null;
        return { pid, owner, unity, startedAt: info ? info.startedAt : null, by: info ? info.by : null, orphaned: info !== null && !ownerAlive };
    }

    /** Takes the lock if it's free. Resolves false when someone else holds it. */
    async tryAcquire(by) {
        if (this.read() !== null) return false;
        fs.rmSync(this.pidPath, { force: true });
        try {
            fs.writeFileSync(this.pidPath, String(process.pid), { flag: 'wx' });
        } catch (error) {
            if (error.code === 'EEXIST' || error.code === 'EPERM') return false;
            throw error;
        }
        // Two processes clearing the same stale lock could each have written their own.
        await sleep(SETTLE_MS);
        if (readOrNull(this.pidPath) !== String(process.pid)) return false;

        this.held = true;
        this.by = by;
        this.startedAt = Date.now();
        fs.rmSync(this.stopPath, { force: true });
        this.writeInfo(null);
        return true;
    }

    writeInfo(unity) {
        fs.writeFileSync(this.infoPath, JSON.stringify({ owner: process.pid, unity, startedAt: this.startedAt, by: this.by }));
    }

    setUnity(pid) {
        this.writeInfo(pid);
        fs.writeFileSync(this.pidPath, String(pid));
    }

    isStopRequested() {
        return fs.existsSync(this.stopPath);
    }

    requestStop() {
        fs.writeFileSync(this.stopPath, '');
    }

    clear() {
        for (const file of [this.pidPath, this.infoPath, this.stopPath]) fs.rmSync(file, { force: true });
    }

    /** Frees the lock, unless it was cleared and has since been taken by another process. */
    release() {
        if (!this.held) return;
        this.held = false;
        const info = this.readInfo(Number(readOrNull(this.pidPath)));
        if (info && info.owner !== process.pid) return;
        this.clear();
    }
}

module.exports = { WorkerLock, describeHolder, isProcessAlive, isWorkerProcess, killTree };
