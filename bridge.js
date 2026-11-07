// File-based client for bridge-package/Editor/VsCodeTestBridge.cs.
const fs = require('fs');
const path = require('path');
const { EventTail } = require('./events');

const POLL_MS = 200;
const ALIVE_CHECK_MS = 2000;
// Long enough for the recompile and domain reload a run can trigger.
const FIRST_EVENT_TIMEOUT_MS = 180000;
const CANCEL_TIMEOUT_MS = 10000;
const TERMINAL_EVENTS = new Set(['done', 'error', 'rejected', 'list']);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class UnityBridge {
    constructor(projectRoot) {
        this.projectRoot = projectRoot;
        this.dir = path.join(projectRoot, 'Library', 'VsCodeTests');
        this.commandPath = path.join(this.dir, 'command.json');
    }

    isEditorRunning() {
        try {
            const instance = JSON.parse(fs.readFileSync(path.join(this.projectRoot, 'Library', 'EditorInstance.json'), 'utf8'));
            process.kill(instance.process_id, 0);
            return true;
        } catch {
            return false;
        }
    }

    /** Clears files left by a previous session so a stale command can't start a surprise run. */
    clearStaleFiles() {
        if (!fs.existsSync(this.dir)) return;
        for (const name of fs.readdirSync(this.dir)) {
            fs.rmSync(path.join(this.dir, name), { force: true });
        }
    }

    // Renamed into place so the Editor never reads a half-written command.
    writeCommand(command) {
        fs.mkdirSync(this.dir, { recursive: true });
        const temp = `${this.commandPath}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(command));
        fs.renameSync(temp, this.commandPath);
    }

    /**
     * Sends one command and reports its events until a terminal one arrives. Resolves with that
     * event, or with a synthetic `error` event when the Editor is closed or never answers.
     */
    async send(command, onEvent, cancellation) {
        const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const eventsPath = path.join(this.dir, `events-${id}.ndjson`);
        if (!this.isEditorRunning()) {
            return { type: 'error', message: 'Unity is not running. Open the project in Unity, then refresh the tests.' };
        }

        this.writeCommand({ id, refresh: false, ...command });

        const tail = new EventTail(eventsPath);
        const start = Date.now();
        let seenEvent = false;
        let lastAliveCheck = start;
        let cancelRequested = false;
        let cancelAcknowledgedAt = 0;
        const removeCommand = () => fs.rmSync(this.commandPath, { force: true });

        try {
            while (true) {
                await sleep(POLL_MS);
                const now = Date.now();

                for (const event of tail.poll()) {
                    seenEvent = true;
                    if (TERMINAL_EVENTS.has(event.type)) return event;
                    if (event.type === 'cancelling') {
                        // Without an acknowledgement the Editor is still inside a test, so there's no timeout yet.
                        if (event.message) onEvent({ type: 'status', message: event.message });
                        else cancelAcknowledgedAt = now;
                        continue;
                    }
                    onEvent(event);
                }

                if (cancellation && cancellation.isCancellationRequested && !cancelRequested) {
                    cancelRequested = true;
                    if (!seenEvent) {
                        removeCommand();
                        return { type: 'cancelled' };
                    }
                    this.writeCommand({ id, action: 'cancel' });
                    onEvent({ type: 'status', message: 'Unity stops the run once the current test finishes. A test can\'t be interrupted while it runs.' });
                }
                if (cancelAcknowledgedAt && now - cancelAcknowledgedAt > CANCEL_TIMEOUT_MS) {
                    return { type: 'cancelled' };
                }

                if (now - lastAliveCheck > ALIVE_CHECK_MS) {
                    lastAliveCheck = now;
                    if (!this.isEditorRunning()) {
                        return { type: 'error', message: 'Unity closed before the command finished.' };
                    }
                }
                if (!seenEvent && now - start > FIRST_EVENT_TIMEOUT_MS) {
                    removeCommand();
                    return {
                        type: 'error',
                        message: 'Unity did not respond. Switch to Unity so it can import the bridge package and finish compiling, then try again.',
                    };
                }
            }
        } finally {
            fs.rmSync(eventsPath, { force: true });
        }
    }
}

module.exports = { UnityBridge };
