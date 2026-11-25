// Turns the names given to unity-tests into the tests they mean. No dependency on Unity or VS Code.
const { buildTree, leavesOf, namesByMode } = require('./logic');

const MAX_SUGGESTIONS = 3;
const MIN_EDIT_DISTANCE = 2;
const EDIT_DISTANCE_RATIO = 3;

function shortName(name) {
    return name.split(/[.+]/).pop();
}

function flatten(nodes, out = []) {
    nodes.forEach(node => {
        out.push(node);
        flatten(node.children, out);
    });
    return out;
}

/**
 * Whether a suite is one class. A [SetUpFixture] carries a type but covers its whole namespace, and
 * a class with several [TestFixture]s carries none but has one child per fixture.
 */
function isClass(node) {
    if (!node.isSuite || node.isAssembly || node.methodName) return false;
    const className = type => type.replace(/`\d+/g, '');
    if (node.typeName) {
        const name = className(node.typeName);
        return node.fullName === name || node.fullName.startsWith(`${name}(`) || node.fullName.startsWith(`${name}<`);
    }
    return node.children.length > 0 && node.children.every(child => child.typeName && className(child.typeName) === node.fullName);
}

function isMethod(node) {
    return Boolean(node.methodName) || !node.isSuite;
}

function endsWithName(fullName, name) {
    return fullName.endsWith(`.${name}`) || fullName.endsWith(`+${name}`);
}

/** `Class.Method` for a method or test case, which is how people usually write one. */
function classAndMethod(node) {
    const method = node.name || shortName(node.fullName);
    return node.typeName ? `${shortName(node.typeName)}.${method}` : method;
}

function editDistance(a, b) {
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        previous = current;
    }
    return previous[b.length];
}

/** How far apart two names are, or Infinity when they're too different to suggest. Ignores case. */
function nameDistance(wanted, candidate) {
    const a = wanted.toLowerCase();
    const b = candidate.toLowerCase();
    if (a === b) return 0;
    const limit = Math.max(MIN_EDIT_DISTANCE, Math.floor(a.length / EDIT_DISTANCE_RATIO));
    if (Math.abs(a.length - b.length) <= limit) {
        const distance = editDistance(a, b);
        if (distance <= limit) return distance;
    }
    // A fragment of a name is still a hint, but a weaker one than a misspelling.
    return a.length > 3 && b.includes(a) ? limit + 1 + (b.length - a.length) / b.length : Infinity;
}

function closest(wanted, candidates) {
    const best = new Map();
    for (const { label, spellings } of candidates) {
        const distance = Math.min(...spellings.map(spelling => nameDistance(wanted, spelling)));
        if (distance < (best.has(label) ? best.get(label) : Infinity)) best.set(label, distance);
    }
    const chosen = [];
    for (const [label] of [...best].sort((a, b) => a[1] - b[1])) {
        // A class already stands for its methods.
        if (!chosen.some(better => label.startsWith(`${better}.`))) chosen.push(label);
        if (chosen.length === MAX_SUGGESTIONS) break;
    }
    return chosen;
}

function suggest(name, nodes) {
    return closest(name, nodes.filter(node => isClass(node) || isMethod(node)).map(node => ({
        label: node.fullName,
        spellings: isClass(node)
            ? [node.fullName, shortName(node.fullName)]
            : [node.fullName, classAndMethod(node), node.methodName || node.name],
    })));
}

/** Exact full name first, then a class name, then Class.Method. */
function find(name, nodes) {
    const steps = [
        node => node.fullName === name,
        node => isClass(node) && endsWithName(node.fullName, name),
        node => name.includes('.') && isMethod(node) && endsWithName(node.fullName, name),
    ];
    for (const matches of steps) {
        const found = nodes.filter(node => !node.isAssembly && matches(node));
        if (found.length > 0) return found;
    }
    return [];
}

function leafNames(nodes) {
    return [...new Set(nodes.flatMap(node => leavesOf(node)).map(leaf => leaf.fullName))];
}

/**
 * Resolves each name against the bridge's test list. Every name gets its own answer, so a valid one
 * can't hide a misspelled one. `selection` is what to run, or null if any name had no single answer
 * or there is nothing to run. An empty `names` selects everything in the mode.
 */
function resolveNames(tests, names, mode) {
    const all = flatten(buildTree(tests));
    const inMode = all.filter(node => mode === 'all' || node.mode === mode);
    const result = { matched: [], unmatched: [], ambiguous: [], leaves: [], selection: null };
    const chosen = [];

    for (const name of [...new Set(names)]) {
        const found = find(name, inMode);
        const fullNames = [...new Set(found.map(node => node.fullName))];
        if (fullNames.length > 1) {
            result.ambiguous.push({ name, candidates: fullNames });
        } else if (leafNames(found).length === 0) {
            const elsewhere = find(name, all).find(node => leafNames([node]).length > 0);
            result.unmatched.push({
                name,
                suggestions: elsewhere ? [] : suggest(name, inMode),
                otherMode: elsewhere ? elsewhere.mode : null,
            });
        } else {
            result.matched.push({ name, fullName: fullNames[0], tests: leafNames(found) });
            chosen.push(...found);
        }
    }
    if (result.unmatched.length > 0 || result.ambiguous.length > 0) return result;

    const leaves = (names.length > 0 ? chosen.flatMap(node => leavesOf(node)) : inMode.filter(node => !node.isSuite));
    // The same test can be picked by two names, but one in both modes runs twice.
    result.leaves = [...new Map(leaves.map(leaf => [`${leaf.mode} ${leaf.fullName}`, leaf])).values()];
    if (result.leaves.length === 0) return result;

    const modes = new Set(result.leaves.map(leaf => leaf.mode));
    const selectedMode = modes.size === 1 ? [...modes][0] : 'all';
    // Unity's name filter is only relied on for classes and below.
    const named = chosen.flatMap(node => isClass(node) || isMethod(node) ? [node] : leavesOf(node));
    result.selection = { mode: selectedMode, ...namesByMode(named) };
    return result;
}

/**
 * Resolves the full names of tests that failed earlier. Ones that no longer exist, or are outside the
 * mode, are listed in `skipped` instead of stopping the rest.
 */
function resolveFailed(tests, names, mode) {
    const skipped = resolveNames(tests, names, mode).unmatched.map(({ name }) => name);
    const remaining = names.filter(name => !skipped.includes(name));
    // Resolving no names at all would select every test.
    const result = remaining.length > 0 ? resolveNames(tests, remaining, mode) : { matched: [], unmatched: [], ambiguous: [], leaves: [], selection: null };
    return { ...result, skipped };
}

function matchesPattern(text, pattern) {
    const lower = pattern.toLowerCase();
    if (!lower.includes('*')) return text.toLowerCase().includes(lower);
    const escaped = lower.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${escaped}$`).test(text.toLowerCase());
}

/** Tests whose full name matches any pattern, or all of them without one. */
function listTests(tests, patterns, mode) {
    return flatten(buildTree(tests))
        .filter(node => !node.isSuite && (mode === 'all' || node.mode === mode))
        .filter(node => patterns.length === 0 || patterns.some(pattern => matchesPattern(node.fullName, pattern)));
}

/** The class part of a test's full name. A method name or its arguments can contain dots. */
function classOf(node) {
    const suffix = `.${node.name}`;
    if (node.name && node.fullName.endsWith(suffix)) return node.fullName.slice(0, -suffix.length);
    return (node.typeName || node.fullName).replace(/`\d+/g, '');
}

module.exports = { resolveNames, resolveFailed, listTests, classOf, closest };
