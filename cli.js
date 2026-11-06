#!/usr/bin/env node
// Runs Unity tests in the headless worker without touching the open Editor.
const fs = require('fs');
const path = require('path');
const { installBridge } = require('./install');
const { TestWorker } = require('./worker');

const USAGE = `Usage: unity-tests [--project <path>] [--mode edit|play|all] [test names...]
       unity-tests [--project <path>] --install-bridge

Runs every test, or the named classes and tests, on a headless mirror of the project.
--project         Unity project folder. Defaults to the nearest one at or above the current folder.
--mode            Which test mode the names belong to. Defaults to all.
--install-bridge  Adds the Editor-only bridge package the worker needs to the project.

Exit codes: 0 all passed, 1 tests failed, 2 the run itself failed.`;

function findProject(start) {
    let dir = path.resolve(start);
    while (true) {
        if (fs.existsSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

function parseArgs(args) {
    const options = { project: null, mode: 'all', names: [], help: false };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--help' || args[i] === '-h') options.help = true;
        else if (args[i] === '--install-bridge') options.installBridge = true;
        else if (args[i] === '--project') options.project = args[++i];
        else if (args[i] === '--mode') options.mode = args[++i];
        else options.names.push(args[i]);
    }
    return options;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(USAGE);
        return 0;
    }
    if (!['edit', 'play', 'all'].includes(options.mode)) {
        console.error(USAGE);
        return 2;
    }
    const project = options.project ? path.resolve(options.project) : findProject(process.cwd());
    if (!project || !fs.existsSync(path.join(project, 'ProjectSettings', 'ProjectVersion.txt'))) {
        console.error('No Unity project found. Run this inside one or pass --project.');
        return 2;
    }

    if (options.installBridge) {
        installBridge(project);
        console.log('Test bridge installed. Open the project in Unity once so it can import the package.');
        return 0;
    }

    const counts = { passed: 0, failed: 0, skipped: 0, inconclusive: 0 };
    const failures = [];
    const start = Date.now();

    const end = await new TestWorker(project).run({
        editNames: options.mode !== 'play' ? options.names : [],
        playNames: options.mode !== 'edit' ? options.names : [],
        onStatus: text => console.log(text),
        onEvent: event => {
            if (event.type !== 'test') return;
            counts[event.status] = (counts[event.status] || 0) + 1;
            if (event.status === 'failed') failures.push(event);
        },
    });

    if (end.type !== 'done') {
        console.error(`Run failed: ${end.message || end.type}`);
        return 2;
    }

    for (const failure of failures) {
        console.log(`\nFAILED ${failure.fullName}\n${failure.message}\n${failure.stack}`);
    }
    const seconds = Math.round((Date.now() - start) / 1000);
    console.log(`\n${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.inconclusive} inconclusive (${seconds} s)`);
    return counts.failed > 0 ? 1 : 0;
}

main().then(code => { process.exitCode = code; }, error => {
    console.error(error);
    process.exitCode = 2;
});
