#!/usr/bin/env node
// Runs Unity tests in the headless worker without touching the open Editor.
const fs = require('fs');
const path = require('path');
const { bundledVersion, installBridge, installedVersion } = require('./install');
const report = require('./report');
const { resolveNames, resolveFailed, listTests, classOf, closest } = require('./select');
const { describeHolder } = require('./lock');
const { TestWorker } = require('./worker');
const { version: VERSION } = require('./package.json');

const OK = 0;
const TESTS_FAILED = 1;
const RUN_FAILED = 2;
const NO_MATCH = 3;
const MODES = ['edit', 'play', 'all'];
const MAX_STARTED_BY_LENGTH = 80;

const USAGE = `Usage: unity-tests [options] [test names...]
       unity-tests --check | --list [patterns...] | --stop | --install-bridge

Runs every test, or the named ones, on a headless mirror of the project.
A name can be a full name (Game.Tests.PlayerTests.Jumps), a class (PlayerTests), or Class.Method
(PlayerTests.Jumps). If any name matches nothing, or several things, no tests run.

What to do:
  --check            Sync and compile only, printing any compile errors.
  --list [patterns]  List tests whose full name contains a pattern. * is a wildcard for the whole
                     name. Without patterns, lists the classes.
  --stop             Stop the run that's using this project's worker, whoever started it.
  --install-bridge   Add or update the Editor-only bridge package in the project.
  --version          Print the version.

Options:
  --project <path>   Unity project folder. Defaults to the nearest one at or above the current folder.
  --mode <mode>      Run or list only edit or play tests. Defaults to all.
  --failed           Run only the tests that failed in the last run.
  --wait             If the worker is busy or memory is short, wait instead of failing.
  --timeout <secs>   Stop after this long, counting any wait.
  --verbose          Show the whole of each failure, including the test's log.
  --json             Print one JSON document to stdout. Everything else goes to stderr.
  --junit <file>     Write the results as JUnit XML.

Exit codes:
  0  Everything that ran passed (skipped tests are allowed), or the code compiles.
  1  A test failed or was inconclusive, or --check found compile errors.
  2  The run itself failed, was interrupted, timed out, or didn't report every test.
  3  A name matched no tests or several names, or there were no tests to run.`;

const FLAGS = {
    '--help': 'help', '-h': 'help', '--version': 'version',
    '--check': 'check', '--list': 'list', '--stop': 'stop', '--install-bridge': 'installBridge',
    '--failed': 'failed', '--wait': 'wait', '--verbose': 'verbose', '--json': 'json',
};
const VALUES = { '--project': 'project', '--mode': 'mode', '--timeout': 'timeout', '--junit': 'junit' };
const ACTIONS = ['check', 'list', 'stop', 'installBridge'];

/** Throws an Error with a message for the user when the arguments don't make sense. */
function parseArgs(args) {
    const options = { project: null, mode: 'all', timeout: null, junit: null, names: [] };
    for (let i = 0; i < args.length; i++) {
        if (!args[i].startsWith('-')) {
            options.names.push(args[i]);
            continue;
        }
        const [flag, inline] = args[i].split(/=(.*)/s);
        if (flag in VALUES) {
            const value = inline !== undefined ? inline : args[++i];
            if (!value || (inline === undefined && value.startsWith('-'))) throw new Error(`${flag} needs a value.`);
            options[VALUES[flag]] = value;
        } else if (flag in FLAGS && inline === undefined) {
            options[FLAGS[flag]] = true;
        } else {
            const known = Object.keys({ ...FLAGS, ...VALUES }).filter(name => name.startsWith('--'));
            const [suggestion] = closest(flag, known.map(name => ({ label: name, spellings: [name] })));
            throw new Error(`Unknown option ${args[i]}.${suggestion ? ` Did you mean ${suggestion}?` : ''}`);
        }
    }

    if (!MODES.includes(options.mode)) throw new Error(`--mode must be one of ${MODES.join(', ')}.`);
    if (options.timeout !== null) {
        const seconds = Number(options.timeout);
        if (!(seconds > 0)) throw new Error('--timeout must be a number of seconds.');
        options.timeout = seconds;
    }
    const chosen = ACTIONS.filter(action => options[action]);
    const flagOf = action => Object.keys(FLAGS).find(flag => FLAGS[flag] === action);
    if (chosen.length > 1) throw new Error(`${chosen.map(flagOf).join(' and ')} can't be combined.`);
    if (chosen.length === 1 && chosen[0] !== 'list' && options.names.length > 0) {
        throw new Error(`${flagOf(chosen[0])} doesn't take test names.`);
    }
    if (options.failed && (chosen.length > 0 || options.names.length > 0)) {
        throw new Error(`--failed can't be combined with ${chosen.length > 0 ? flagOf(chosen[0]) : 'test names'}.`);
    }
    return options;
}

function findProject(start) {
    let dir = path.resolve(start);
    while (true) {
        if (fs.existsSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/** Null when the project's bridge matches, isn't installed, or comes from somewhere that can't be read. */
function versionWarning(installed, bundled) {
    if (installed === null || installed === 'managed' || installed === bundled) return null;
    return `Warning: this project's test bridge is ${installed} and unity-tests is ${bundled}. The worker uses ${bundled}; `
        + 'the open Editor uses the project\'s. Update whichever is older (unity-tests --install-bridge updates the bridge).';
}

/** Cancels on Ctrl+C, a termination signal or the timeout. A second signal exits at once. */
function createCancellation(worker, timeoutSeconds) {
    const cancellation = { isCancellationRequested: false, reason: null };
    const cancel = reason => {
        cancellation.isCancellationRequested = true;
        cancellation.reason = cancellation.reason || reason;
    };
    const onSignal = () => {
        if (cancellation.isCancellationRequested) {
            worker.abort();
            process.exit(RUN_FAILED);
        }
        cancel('Interrupted.');
        process.stderr.write('\nStopping the worker...\n');
    };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])];
    signals.forEach(signal => process.on(signal, onSignal));
    const timer = timeoutSeconds ? setTimeout(() => cancel(`Timed out after ${timeoutSeconds} s.`), timeoutSeconds * 1000) : null;
    cancellation.dispose = () => {
        clearTimeout(timer);
        signals.forEach(signal => process.off(signal, onSignal));
    };
    return cancellation;
}

function printList(tests, patterns, print) {
    if (patterns.length > 0) {
        tests.forEach(test => print(`${test.fullName}${test.mode === 'play' ? '  [Play Mode]' : ''}${test.isExplicit ? '  [Explicit]' : ''}`));
        print(`\n${report.plural(tests.length, 'test')}`);
        return;
    }
    const classes = new Map();
    for (const test of tests) {
        const key = `${classOf(test)}${test.mode === 'play' ? '  [Play Mode]' : ''}`;
        classes.set(key, (classes.get(key) || 0) + 1);
    }
    classes.forEach((count, name) => print(`${name} (${count})`));
    print(`\n${report.plural(tests.length, 'test')} in ${classes.size} ${classes.size === 1 ? 'class' : 'classes'}. Add a pattern to list tests.`);
}

/** How this run is named to others waiting for the worker. */
function describeRun(options) {
    const flags = ['check', 'list', 'failed'].filter(option => options[option]).map(option => `--${option}`);
    return ['unity-tests', ...flags, ...options.names].join(' ').slice(0, MAX_STARTED_BY_LENGTH);
}

async function runWorker(project, options) {
    const worker = new TestWorker(project);
    const action = options.check ? 'check' : options.list ? 'list' : 'run';
    const start = Date.now();
    // With --json, stdout holds nothing but the document.
    const stream = options.json ? process.stderr : process.stdout;
    let progress = null;
    const print = text => {
        if (progress) progress.clear();
        stream.write(`${text}\n`);
    };

    const warning = versionWarning(installedVersion(project), bundledVersion());
    if (warning) process.stderr.write(`${warning}\n`);

    const lastFailed = options.failed ? worker.readLastFailed() : null;
    let noTests = 'There are no tests to run.';
    if (options.failed) noTests = lastFailed === null ? 'No run is recorded yet.' : 'Nothing failed in the last run.';

    const events = [];
    let running = null;
    let sync = null;
    let listed = null;
    let resolved = { matched: [], unmatched: [], ambiguous: [], leaves: [], selection: null };

    function select(tests) {
        const prefix = [report.formatSync(sync), 'compiled'].filter(Boolean).join(', ');
        if (action === 'list') {
            listed = listTests(tests, options.names, options.mode);
            print(prefix);
            return null;
        }
        resolved = lastFailed ? resolveFailed(tests, lastFailed, options.mode) : resolveNames(tests, options.names, options.mode);
        if (resolved.skipped && resolved.skipped.length > 0) {
            noTests = 'None of the last run\'s failures are left to run.';
            print(`Skipping ${report.plural(resolved.skipped.length, 'failure')} that no longer exist${resolved.skipped.length === 1 ? 's' : ''}${options.mode === 'all' ? '' : ' in this mode'}.`);
        }
        if (resolved.selection === null) {
            print(`${prefix}. Not running anything.`);
            return null;
        }
        print(`${prefix}, ${report.plural(resolved.leaves.length, 'test')} matched`);
        progress = new report.Progress(process.stderr.isTTY ? process.stderr : stream, resolved.leaves.length);
        return resolved.selection;
    }

    const cancellation = createCancellation(worker, options.timeout);
    let end;
    try {
        end = options.failed && !(lastFailed && lastFailed.length > 0) ? { type: 'done' } : await worker.run({
            check: action === 'check',
            select: action === 'check' ? null : select,
            wait: options.wait,
            startedBy: describeRun(options),
            cancellation,
            onStatus: print,
            onEvent: event => {
                if (event.type === 'synced') {
                    sync = event;
                } else if (event.type === 'started') {
                    running = event.fullName;
                    if (progress) progress.testStarted(event.fullName);
                } else if (event.type === 'test') {
                    running = null;
                    events.push(event);
                    if (event.status === 'failed' || event.status === 'inconclusive') print(`\n${report.formatFailure(event, options.verbose)}\n`);
                    if (progress) progress.testFinished(event.status);
                }
            },
        });
    } catch (error) {
        end = { type: 'error', message: error.stack };
    } finally {
        cancellation.dispose();
        if (progress) progress.stop();
    }

    const nodes = new Map(resolved.leaves.map(leaf => [leaf.fullName, leaf]));
    const counts = report.countResults(events);
    const finished = new Set(events.map(event => event.fullName));
    const ran = end.type === 'done' && resolved.selection !== null;
    // [Explicit] tests only run when named themselves, so they're not expected.
    const missing = ran ? resolved.leaves.filter(leaf => !leaf.isExplicit && !finished.has(leaf.fullName)).map(leaf => leaf.fullName) : [];

    let error = null;
    let exitCode = OK;
    if (end.type !== 'done') {
        error = end.type === 'cancelled' ? cancellation.reason || end.message || 'Cancelled.' : end.message || end.type;
        if (running) error += `\nIt was running ${running}.`;
        exitCode = action === 'check' && end.compileErrors ? TESTS_FAILED : RUN_FAILED;
    } else if (action === 'list') {
        exitCode = listed && listed.length > 0 ? OK : NO_MATCH;
    } else if (action === 'run' && resolved.selection === null) {
        exitCode = NO_MATCH;
        if (resolved.unmatched.length === 0 && resolved.ambiguous.length === 0) error = noTests;
    } else if (action === 'run' && events.length === 0) {
        exitCode = RUN_FAILED;
        error = 'Unity ran none of the matched tests.';
    } else if (missing.length > 0) {
        exitCode = RUN_FAILED;
        error = `${report.plural(missing.length, 'matched test')} reported no result.`;
    }
    if (exitCode === OK && counts.failed + counts.inconclusive > 0) exitCode = TESTS_FAILED;

    const seconds = Math.round((Date.now() - start) / 100) / 10;
    const result = {
        action,
        exitCode,
        error,
        running: end.type === 'done' ? null : running,
        project,
        version: VERSION,
        bridgeVersion: installedVersion(project),
        sync: sync && { changed: sync.changed, restored: sync.restored, isFirstRun: sync.isFirstRun },
        seconds,
        matched: resolved.matched.map(({ name, fullName, tests }) => ({ name, fullName, tests: tests.length })),
        unmatched: resolved.unmatched,
        ambiguous: resolved.ambiguous,
        missing,
        compileErrors: end.compileErrors || [],
        counts,
        tests: events.map(event => report.resultOf(event, nodes.get(event.fullName))),
    };
    if (listed) result.listed = listed.map(({ fullName, mode, isExplicit }) => ({ fullName, mode, isExplicit }));

    if (listed) printList(listed, options.names, print);
    if (action === 'check') {
        if (exitCode === OK) print(`${report.formatSync(sync)}. Compiled OK (${report.formatSeconds(seconds)})`);
        else if (end.compileErrors) print(`${end.compileErrors.join('\n')}\n\n${report.formatSync(sync)}. ${report.plural(end.compileErrors.length, 'compile error')}`);
    }
    const unresolved = report.formatUnresolved(resolved);
    if (unresolved) print(unresolved);
    if (missing.length > 0) print(`\nNo result from:\n${missing.slice(0, 20).map(name => `    ${name}`).join('\n')}${missing.length > 20 ? `\n    ... and ${missing.length - 20} more` : ''}`);

    if (events.length > 0) {
        const slow = report.slowest(events);
        if (slow.length > 0) print(`\nSlowest:\n${slow.map(event => `    ${report.formatSeconds(event.duration)}  ${event.fullName}`).join('\n')}`);
        const partial = ran ? '' : `, ${resolved.leaves.length - finished.size} not run`;
        print(`\n${report.formatCounts(counts)}${partial} (${report.formatSeconds(seconds)})`);
    }
    if (error && !(action === 'check' && end.compileErrors)) process.stderr.write(`${action === 'run' ? 'Run failed: ' : ''}${error}\n`);

    if (options.junit) {
        fs.mkdirSync(path.dirname(path.resolve(options.junit)), { recursive: true });
        fs.writeFileSync(options.junit, report.toJUnit(result));
    }
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return exitCode;
}

async function main(args) {
    let options;
    try {
        options = parseArgs(args);
    } catch (error) {
        console.error(`${error.message}\nRun unity-tests --help for the options.`);
        return RUN_FAILED;
    }
    if (options.help) {
        console.log(USAGE);
        return OK;
    }

    const project = options.project ? path.resolve(options.project) : findProject(process.cwd());
    const isProject = project !== null && fs.existsSync(path.join(project, 'ProjectSettings', 'ProjectVersion.txt'));
    if (options.version) {
        console.log(`unity-tests ${VERSION}`);
        const installed = isProject ? installedVersion(project) : null;
        if (installed !== null) console.log(`Test bridge in ${project}: ${installed}`);
        return OK;
    }
    if (!isProject) {
        console.error('No Unity project found. Run this inside one or pass --project.');
        return RUN_FAILED;
    }
    if (options.installBridge) {
        installBridge(project);
        console.log(`Test bridge ${bundledVersion()} installed. Open the project in Unity once so it can import the package.`);
        return OK;
    }
    if (options.stop) {
        const stopped = await new TestWorker(project).stop();
        console.log(stopped ? `Stopped the run ${describeHolder(stopped)}.` : 'No worker is running.');
        return OK;
    }
    return runWorker(project, options);
}

if (require.main === module) {
    main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
        console.error(error);
        process.exitCode = RUN_FAILED;
    });
}

module.exports = { parseArgs, versionWarning, describeRun };
