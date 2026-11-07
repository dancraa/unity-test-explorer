const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { UnityBridge } = require('./bridge');
const { TestWorker } = require('./worker');
const logic = require('./logic');
const install = require('./install');

const INSTALL_BRIDGE = 'Install';
const RUN_IN_WORKER = 'Run in Worker';
const RUN_IN_UNITY = 'Run in Unity';
const LARGE_RUN_NOTICE_KEY = 'unityTests.largeRunNoticeShown';
const DURATIONS_KEY = 'unityTests.durations';

function activate(context) {
    const folder = (vscode.workspace.workspaceFolders || [])
        .find(f => fs.existsSync(path.join(f.uri.fsPath, 'ProjectSettings', 'ProjectVersion.txt')));
    if (!folder) return;

    const projectRoot = folder.uri.fsPath;
    const bridge = new UnityBridge(projectRoot);
    bridge.clearStaleFiles();
    const worker = new TestWorker(projectRoot);

    const controller = vscode.tests.createTestController('unityTests', 'Unity Tests');
    context.subscriptions.push(controller);

    const nodesByItem = new Map();
    const itemsByFullName = new Map();
    let loaded = false;
    let lastTree = '';

    // The bridge handles one command at a time, so every send goes through this chain.
    let queue = Promise.resolve();
    const enqueue = work => {
        const result = queue.then(work, work);
        queue = result.catch(() => {});
        return result;
    };

    // Test code lives wherever its assembly definition is, so those folders are searched first.
    async function findTestSources() {
        const glob = vscode.workspace.getConfiguration('unityTests').get('sourceGlob');
        if (glob) return vscode.workspace.findFiles(new vscode.RelativePattern(folder, glob));

        const definitions = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '{Assets,Packages}/**/*.asmdef'));
        const testFolders = definitions
            .filter(uri => logic.isTestAssemblyDefinition(fs.readFileSync(uri.fsPath, 'utf8')))
            .map(uri => path.dirname(uri.fsPath));
        if (testFolders.length === 0) {
            return vscode.workspace.findFiles(new vscode.RelativePattern(folder, 'Assets/**/*.cs'));
        }
        const found = await Promise.all(testFolders.map(testFolder =>
            vscode.workspace.findFiles(new vscode.RelativePattern(testFolder, '**/*.cs'))));
        return found.flat();
    }

    async function readSourceIndex() {
        const uris = await findTestSources();
        const files = uris.map(uri => ({ path: uri.fsPath, text: fs.readFileSync(uri.fsPath, 'utf8') }));
        return logic.indexSources(files);
    }

    function createItem(node, classes, siblings) {
        const location = logic.locate(node, classes);
        const uri = location ? vscode.Uri.file(location.path) : undefined;
        const item = controller.createTestItem(node.fullName, logic.labelOf(node), uri);
        if (location) item.range = new vscode.Range(location.line, 0, location.line, 0);
        nodesByItem.set(item, node);
        if (!node.isSuite) itemsByFullName.set(node.fullName, item);
        node.children.forEach(child => createItem(child, classes, item.children));
        siblings.add(item);
    }

    async function loadTests(refresh, showErrors) {
        const event = await enqueue(() => bridge.send({ action: 'list', refresh }, () => {}));
        if (event.type !== 'list') {
            if (showErrors) vscode.window.showWarningMessage(`Unity Tests: ${event.message}`);
            return;
        }
        loaded = true;

        const tree = JSON.stringify(event.tests);
        if (tree === lastTree) return;
        lastTree = tree;

        const classes = await readSourceIndex();
        nodesByItem.clear();
        itemsByFullName.clear();
        controller.items.replace([]);
        logic.buildTree(event.tests).forEach(root => createItem(root, classes, controller.items));
    }

    function installBridge() {
        install.installBridge(projectRoot);
        vscode.window.showInformationMessage('Test bridge installed. Switch to Unity so it can import the package, then refresh the Testing tab.');
    }

    /** Offers to add or update the bridge. Resolves true once this project has a usable one. */
    async function ensureBridge() {
        if (install.installedVersion(projectRoot) === null) {
            const choice = await vscode.window.showInformationMessage(
                `Unity Tests needs a small Editor-only package in this project (Packages/${install.PACKAGE_NAME}). It isn't included in player builds.`,
                INSTALL_BRIDGE);
            if (choice === INSTALL_BRIDGE) installBridge();
            return false;
        }
        if (install.needsUpdate(projectRoot)) {
            const choice = await vscode.window.showInformationMessage(
                `The test bridge in this project is out of date (${install.installedVersion(projectRoot)}, latest ${install.bundledVersion()}).`,
                INSTALL_BRIDGE);
            if (choice === INSTALL_BRIDGE) installBridge();
        }
        return true;
    }

    context.subscriptions.push(vscode.commands.registerCommand('unityTests.installBridge', installBridge));

    controller.refreshHandler = async () => {
        if (await ensureBridge()) await loadTests(true, true);
    };
    controller.resolveHandler = async item => {
        if (!item && !loaded && await ensureBridge()) await loadTests(false, false);
    };

    function failureMessage(event) {
        const text = [event.message, event.stack].filter(Boolean).join('\n\n');
        const message = new vscode.TestMessage(text || 'Test failed.');
        const location = logic.parseFailureLocation(event.stack, projectRoot);
        if (location) {
            message.location = new vscode.Location(vscode.Uri.file(location.path), new vscode.Position(location.line, 0));
        }
        return message;
    }

    function durations() {
        return context.workspaceState.get(DURATIONS_KEY, {});
    }

    function recordDuration(fullName, seconds) {
        context.workspaceState.update(DURATIONS_KEY, { ...durations(), [fullName]: seconds });
    }

    function reportResult(run, event) {
        const item = itemsByFullName.get(event.fullName);
        if (!item) return false;
        if (event.status === 'passed' || event.status === 'failed') recordDuration(event.fullName, event.duration);
        const duration = event.duration * 1000;
        if (event.status === 'passed') run.passed(item, duration);
        else if (event.status === 'failed') run.failed(item, failureMessage(event), duration);
        else run.skipped(item);
        return true;
    }

    function resolveSelection(request) {
        // Run All arrives with no include list.
        const included = request.include ? [...request.include] : [];
        if (!request.include) controller.items.forEach(item => included.push(item));
        const nodes = included.map(item => nodesByItem.get(item)).filter(Boolean);
        const excluded = new Set((request.exclude || [])
            .flatMap(item => logic.leavesOf(nodesByItem.get(item)))
            .map(leaf => leaf.fullName));
        const maxTests = vscode.workspace.getConfiguration('unityTests').get('maxTestsPerRun');
        const scope = logic.checkRunScope(nodes, maxTests);

        const leaves = [...new Map(nodes.flatMap(node => logic.leavesOf(node)).map(leaf => [leaf.fullName, leaf])).values()]
            .filter(leaf => !excluded.has(leaf.fullName));
        // Unity's name filter is only relied on for classes and below, so broad runs list each test.
        const named = excluded.size > 0 || scope.broad ? leaves : nodes;
        return { scope, leaves, names: logic.namesByMode(named) };
    }

    /** Reports one run in the tab. `execute` starts it, passing events to its callback. */
    async function reportRun(request, leaves, execute) {
        const run = controller.createTestRun(request);
        const remaining = new Set(leaves.map(leaf => leaf.fullName));
        leaves.forEach(leaf => run.enqueued(itemsByFullName.get(leaf.fullName)));

        try {
            const end = await execute(run, event => {
                const item = itemsByFullName.get(event.fullName);
                if (event.type === 'started' && item) {
                    run.started(item);
                } else if (event.type === 'status') {
                    run.appendOutput(`${event.message}\r\n`);
                    vscode.window.showInformationMessage(`Unity Tests: ${event.message}`);
                } else if (event.type === 'test' && reportResult(run, event)) {
                    remaining.delete(event.fullName);
                }
            });

            if (end.type === 'error' || end.type === 'rejected') {
                vscode.window.showWarningMessage(`Unity Tests: ${end.message}`);
                const message = new vscode.TestMessage(end.message);
                remaining.forEach(name => run.errored(itemsByFullName.get(name), message));
            } else {
                remaining.forEach(name => run.skipped(itemsByFullName.get(name)));
            }
        } finally {
            run.end();
        }
    }

    function isWorkerEnabled() {
        return vscode.workspace.getConfiguration('unityTests').get('enableWorker') === true;
    }

    function showLargeRunNotice() {
        if (context.globalState.get(LARGE_RUN_NOTICE_KEY)) return;
        context.globalState.update(LARGE_RUN_NOTICE_KEY, true);
        vscode.window.showInformationMessage(
            'Unity will be jerky during large test runs, and slow tests can stall it. To keep it free, turn on the Unity Tests: Enable Worker setting, which keeps a copy of your project next to it.');
    }

    /** Resolves to RUN_IN_UNITY, RUN_IN_WORKER, or undefined when the run was called off. */
    async function confirmSlowRun(slow) {
        const { title, detail } = logic.describeSlowTests(slow);
        const choices = isWorkerEnabled() ? [RUN_IN_WORKER, RUN_IN_UNITY] : [RUN_IN_UNITY];
        return vscode.window.showWarningMessage(title, { modal: true, detail }, ...choices);
    }

    async function runInEditor(request, token) {
        const { scope, leaves, names } = resolveSelection(request);
        const threshold = vscode.workspace.getConfiguration('unityTests').get('slowTestSeconds');
        const slow = logic.findSlowTests(leaves, durations(), threshold);
        if (slow.length > 0) {
            const choice = await confirmSlowRun(slow);
            if (choice === RUN_IN_WORKER) return runInWorker(request, token);
            if (choice !== RUN_IN_UNITY) return;
        } else if (scope.needsConfirmation && !isWorkerEnabled()) {
            showLargeRunNotice();
        } else if (scope.needsConfirmation) {
            const choice = await vscode.window.showWarningMessage(
                `Run ${scope.count} tests?`,
                { modal: true, detail: 'The worker runs them in the background and keeps Unity free. In Unity, the Editor is jerky until they finish, and slow tests can stall it.' },
                RUN_IN_WORKER,
                RUN_IN_UNITY);
            if (choice === RUN_IN_WORKER) return runInWorker(request, token);
            if (choice !== RUN_IN_UNITY) return;
        }
        if (leaves.length === 0) return;

        await reportRun(request, leaves, (run, onEvent) => enqueue(() =>
            bridge.send({ action: 'run', ...names, refresh: true }, onEvent, token)));

        // A run can recompile, which may add or remove tests.
        await loadTests(false, false);
    }

    async function runInWorker(request, token) {
        const { leaves, names } = resolveSelection(request);
        if (leaves.length === 0) return;

        // An empty list runs everything, which is what Run All asks for.
        const isRunAll = !request.include && !(request.exclude || []).length;
        await reportRun(request, leaves, (run, onEvent) => worker.run({
            ...(isRunAll ? {} : names),
            onEvent,
            onStatus: text => run.appendOutput(`${text}\r\n`),
            cancellation: token,
        }));
    }

    controller.createRunProfile(RUN_IN_UNITY, vscode.TestRunProfileKind.Run, runInEditor, true);

    let workerProfile = null;
    function syncWorkerProfile() {
        if (isWorkerEnabled() && !workerProfile) {
            workerProfile = controller.createRunProfile(RUN_IN_WORKER, vscode.TestRunProfileKind.Run, runInWorker, false);
        } else if (!isWorkerEnabled() && workerProfile) {
            workerProfile.dispose();
            workerProfile = null;
        }
    }
    syncWorkerProfile();
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('unityTests.enableWorker')) syncWorkerProfile();
    }));
}

function deactivate() {}

module.exports = { activate, deactivate };
