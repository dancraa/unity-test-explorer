// Pure logic with no dependency on VS Code, so it can run under `node --test`.
const path = require('path');

/** Splits appended bytes into complete lines; a partly written line waits for the next chunk. */
class LineBuffer {
    constructor() {
        this.pending = Buffer.alloc(0);
    }

    push(chunk) {
        const data = Buffer.concat([this.pending, chunk]);
        const end = data.lastIndexOf(0x0a);
        if (end < 0) {
            this.pending = data;
            return [];
        }
        this.pending = data.subarray(end + 1);
        return data.subarray(0, end).toString('utf8').split('\n').map(l => l.trim()).filter(Boolean);
    }
}

/** Turns the bridge's flat parent-indexed list into a tree, dropping Unity's project-level root. */
function buildTree(flat) {
    const nodes = flat.map(t => ({ ...t, children: [] }));
    const roots = [];
    nodes.forEach(node => {
        if (node.parent < 0) return;
        const parent = nodes[node.parent];
        // Parents come first in the list, and [Explicit] on a parameterized method covers its cases.
        node.isExplicit = Boolean(node.isExplicit || parent.isExplicit);
        if (parent.parent < 0) roots.push(node);
        else parent.children.push(node);
    });
    return roots;
}

function isLeaf(node) {
    return !node.isSuite;
}

function leavesOf(node, out = []) {
    if (isLeaf(node)) out.push(node);
    node.children.forEach(child => leavesOf(child, out));
    return out;
}

/** Tests slow the shared Editor down, so runs above class level or over the limit need confirming. */
function checkRunScope(nodes, maxTests) {
    const count = new Set(nodes.flatMap(n => leavesOf(n).map(l => l.fullName))).size;
    const broad = nodes.some(n => !n.typeName);
    return { needsConfirmation: broad || (maxTests > 0 && count > maxTests), broad, count };
}

/**
 * Tests that would hold the Editor for a while: slower than the threshold last time they ran, or
 * [Explicit] with no recorded time. `durations` maps full names to seconds.
 */
function findSlowTests(leaves, durations, thresholdSeconds) {
    return leaves
        .map(leaf => ({ leaf, seconds: durations[leaf.fullName] }))
        .filter(({ leaf, seconds }) => seconds === undefined ? leaf.isExplicit : thresholdSeconds > 0 && seconds >= thresholdSeconds)
        .map(({ leaf, seconds }) => ({ fullName: leaf.fullName, name: leaf.name, seconds: seconds === undefined ? null : seconds }));
}

function formatDuration(seconds) {
    if (seconds < 90) return `${Math.round(seconds)} s`;
    return `${Math.round(seconds / 60)} min`;
}

/** The confirmation shown before slow tests run in the open Editor. */
function describeSlowTests(slow) {
    const timed = slow.filter(test => test.seconds !== null);
    const total = timed.reduce((sum, test) => sum + test.seconds, 0);
    let title;
    if (slow.length === 1 && timed.length === 1) {
        title = `${slow[0].name} held Unity for ${formatDuration(total)} last time it ran.`;
    } else if (slow.length === 1) {
        title = `${slow[0].name} is marked [Explicit], which usually means it's slow.`;
    } else if (timed.length === slow.length) {
        title = `${slow.length} slow tests held Unity for ${formatDuration(total)} in total last time they ran.`;
    } else {
        title = `${slow.length} slow or [Explicit] tests are in this run.`;
    }
    const detail = 'Unity freezes while a test runs, and cancelling only takes effect once that test finishes.';
    return { title, detail };
}

/** Splits nodes into the per-mode name lists the bridge runs. */
function namesByMode(nodes) {
    const names = mode => [...new Set(nodes.filter(n => n.mode === mode).map(n => n.fullName))];
    return { editNames: names('edit'), playNames: names('play') };
}

function labelOf(node) {
    if (!node.isAssembly) return node.name;
    const name = node.name.replace(/\.dll$/, '');
    return node.mode === 'play' ? `${name} (Play Mode)` : name;
}

function isTestAssemblyDefinition(text) {
    return /UnityEngine\.TestRunner|UnityEditor\.TestRunner|TestAssemblies/.test(text);
}

function shortTypeName(typeName) {
    return typeName.split(/[.+]/).pop().replace(/`\d+$/, '');
}

/** Maps class names to their first declaration. Partial classes resolve to that first file. */
function indexSources(files) {
    const classes = new Map();
    for (const file of files) {
        const lines = file.text.split(/\r?\n/);
        lines.forEach((line, index) => {
            const match = /\b(?:class|struct)\s+(\w+)/.exec(line);
            if (match && !classes.has(match[1])) {
                classes.set(match[1], { path: file.path, line: index, lines });
            }
        });
    }
    return classes;
}

/** Finds a node's source line. Requires a return type before the name so call sites don't match. */
function locate(node, classes) {
    if (!node.typeName) return null;
    const source = classes.get(shortTypeName(node.typeName));
    if (!source) return null;
    if (node.methodName) {
        const declaration = new RegExp(`\\b[\\w<>\\[\\],.]+\\s+${node.methodName}\\s*\\(`);
        for (let i = source.line; i < source.lines.length; i++) {
            if (declaration.test(source.lines[i]) && !/^\s*return\b/.test(source.lines[i])) {
                return { path: source.path, line: i };
            }
        }
    }
    return { path: source.path, line: source.line };
}

/** Finds the first project frame of a stack trace, in the Mono, .NET or Unity format. */
function parseFailureLocation(stack, projectRoot) {
    for (const line of (stack || '').split(/\r?\n/)) {
        const match = / in (.+\.cs):(?:line )?(\d+)/.exec(line) || /\(at (.+\.cs):(\d+)\)/.exec(line);
        if (!match) continue;
        const file = path.isAbsolute(match[1]) ? match[1] : path.join(projectRoot, match[1]);
        const relative = path.relative(projectRoot, file);
        if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
        return { path: file, line: Number(match[2]) - 1 };
    }
    return null;
}

module.exports = {
    LineBuffer,
    buildTree,
    isLeaf,
    leavesOf,
    checkRunScope,
    findSlowTests,
    formatDuration,
    describeSlowTests,
    namesByMode,
    labelOf,
    isTestAssemblyDefinition,
    indexSources,
    locate,
    parseFailureLocation,
};
