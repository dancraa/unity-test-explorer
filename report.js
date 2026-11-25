// Formats unity-tests results for people, CI and scripts.
const { classOf } = require('./select');

const MAX_LINE_LENGTH = 500;
const MAX_MESSAGE_LINES = 30;
const MAX_OUTPUT_LINES = 15;
const MAX_STACK_LINES = 10;
const MAX_SLOWEST = 5;
const MIN_SLOW_SECONDS = 0.5;
const PROGRESS_INTERVAL_MS = 15000;

function plural(count, noun) {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function formatSeconds(seconds) {
    if (seconds >= 120) return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
    return `${seconds.toFixed(seconds < 10 ? 2 : 0)} s`;
}

/** Keeps a long text readable. Logs keep their end, which is the part nearest the failure. */
function capText(text, maxLines, { keepEnd = false } = {}) {
    const lines = text.replace(/\s+$/, '').split(/\r?\n/)
        .map(line => line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}...` : line);
    const hidden = lines.length - maxLines;
    if (hidden <= 0) return lines.join('\n');
    const note = `... ${plural(hidden, 'more line')} (--verbose shows all)`;
    return keepEnd ? [note, ...lines.slice(-maxLines)].join('\n') : [...lines.slice(0, maxLines), note].join('\n');
}

function formatFailure(event, verbose) {
    const part = (text, maxLines, options) => text && text.trim() ? (verbose ? text.trimEnd() : capText(text, maxLines, options)) : null;
    const output = part(event.output, MAX_OUTPUT_LINES, { keepEnd: true });
    return [
        `${event.status.toUpperCase()} ${event.fullName} (${formatSeconds(event.duration)})`,
        part(event.message, MAX_MESSAGE_LINES),
        part(event.stack, MAX_STACK_LINES),
        output && `Output:\n${output}`,
    ].filter(Boolean).join('\n');
}

function slowest(results) {
    return results
        .filter(result => result.duration >= MIN_SLOW_SECONDS)
        .sort((a, b) => b.duration - a.duration)
        .slice(0, MAX_SLOWEST);
}

function countResults(results) {
    const counts = { passed: 0, failed: 0, skipped: 0, inconclusive: 0 };
    results.forEach(result => { counts[result.status] = (counts[result.status] || 0) + 1; });
    return counts;
}

function formatCounts(counts) {
    return `${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.inconclusive} inconclusive`;
}

function formatSync(sync) {
    if (!sync) return null;
    if (sync.isFirstRun) return 'Created the worker copy';
    const changed = sync.changed === 0 ? 'No files changed since the last sync' : `Synced ${plural(sync.changed, 'changed file')}`;
    return sync.restored === 0 ? changed : `${changed} (and restored ${sync.restored} the worker had changed)`;
}

/** Explains the names that can't be run, one by one. */
function formatUnresolved({ unmatched, ambiguous }) {
    const lines = [];
    for (const { name, suggestions, otherMode } of unmatched) {
        lines.push(`No test matches "${name}".`);
        if (otherMode) lines.push(`  It's ${otherMode === 'play' ? 'a Play' : 'an Edit'} Mode test, which --mode leaves out.`);
        else if (suggestions.length > 0) lines.push('  Closest:', ...suggestions.map(suggestion => `    ${suggestion}`));
    }
    for (const { name, candidates } of ambiguous) {
        lines.push(`"${name}" matches more than one name. Use one of:`, ...candidates.map(candidate => `    ${candidate}`));
    }
    return lines.join('\n');
}

/** A live status line in a terminal, or an occasional one in a log so a long run isn't silent. */
class Progress {
    constructor(stream, total) {
        this.stream = stream;
        this.total = total;
        this.finished = 0;
        this.failed = 0;
        this.current = null;
        this.startedAt = 0;
        if (!stream.isTTY) {
            this.timer = setInterval(() => this.log(), PROGRESS_INTERVAL_MS);
            this.timer.unref();
        }
    }

    text() {
        const failed = this.failed > 0 ? `, ${this.failed} failed` : '';
        const current = this.current ? `, running ${this.current} (${formatSeconds((Date.now() - this.startedAt) / 1000)})` : '';
        return `[${this.finished}/${this.total}]${failed}${current}`;
    }

    log() {
        this.stream.write(`${this.text()}\n`);
    }

    draw() {
        if (!this.stream.isTTY) return;
        const width = (this.stream.columns || 80) - 1;
        const failed = this.failed > 0 ? ` ${this.failed} failed` : '';
        this.stream.write(`\r\x1b[K${`[${this.finished}/${this.total}]${failed} ${this.current || ''}`.slice(0, width)}`);
    }

    clear() {
        if (this.stream.isTTY) this.stream.write('\r\x1b[K');
    }

    testStarted(fullName) {
        this.current = fullName;
        this.startedAt = Date.now();
        this.draw();
    }

    testFinished(status) {
        this.finished++;
        if (status === 'failed') this.failed++;
        this.current = null;
        this.draw();
    }

    stop() {
        clearInterval(this.timer);
        this.clear();
    }
}

function escapeXml(text) {
    return String(text === undefined || text === null ? '' : text)
        // XML 1.0 has no way to write these characters, not even escaped.
        .replace(/[^\x09\x0A\x0D\x20-\uFFFD]/g, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** JUnit XML. A run that failed to happen is reported as an erroring test, since CI only reads those. */
function toJUnit(report) {
    const suites = new Map();
    for (const test of report.tests) {
        const name = test.className || '';
        if (!suites.has(name)) suites.set(name, []);
        suites.get(name).push(test);
    }

    const problems = [];
    if (report.error) problems.push({ name: report.running || report.action, message: report.error });
    report.unmatched.forEach(({ name }) => problems.push({ name, message: 'No test matches this name.' }));
    report.ambiguous.forEach(({ name, candidates }) => problems.push({ name, message: `Matches more than one name: ${candidates.join(', ')}` }));

    const properties = [
        ...report.matched.map(({ name }) => ['matched', name]),
        ...report.unmatched.map(({ name }) => ['unmatched', name]),
        ...report.ambiguous.map(({ name }) => ['ambiguous', name]),
    ].map(([name, value]) => `      <property name="${name}" value="${escapeXml(value)}"/>`);

    const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
    const { failed, inconclusive, skipped } = report.counts;
    lines.push(`<testsuites tests="${report.tests.length + problems.length}" failures="${failed + inconclusive}" errors="${problems.length}" skipped="${skipped}" time="${report.seconds}">`);

    if (problems.length > 0 || properties.length > 0) {
        lines.push(`  <testsuite name="unity-tests" tests="${problems.length}" failures="0" errors="${problems.length}">`);
        if (properties.length > 0) lines.push('    <properties>', ...properties, '    </properties>');
        for (const { name, message } of problems) {
            lines.push(`    <testcase classname="unity-tests" name="${escapeXml(name)}"><error message="${escapeXml(message)}"/></testcase>`);
        }
        lines.push('  </testsuite>');
    }

    for (const [name, tests] of suites) {
        const counts = countResults(tests);
        const time = tests.reduce((sum, test) => sum + test.duration, 0);
        lines.push(`  <testsuite name="${escapeXml(name)}" tests="${tests.length}" failures="${counts.failed + counts.inconclusive}" errors="0" skipped="${counts.skipped}" time="${time}">`);
        for (const test of tests) {
            const open = `    <testcase classname="${escapeXml(name)}" name="${escapeXml(test.name)}" time="${test.duration}"`;
            if (test.status === 'passed') {
                lines.push(`${open}/>`);
            } else if (test.status === 'skipped') {
                lines.push(`${open}><skipped message="${escapeXml(test.message)}"/></testcase>`);
            } else {
                const firstLine = (test.message || test.status).split(/\r?\n/).find(line => line.trim()) || test.status;
                lines.push(`${open}>`);
                lines.push(`      <failure type="${test.status}" message="${escapeXml(firstLine.trim())}">${escapeXml([test.message, test.stack].filter(Boolean).join('\n'))}</failure>`);
                if (test.output) lines.push(`      <system-out>${escapeXml(test.output)}</system-out>`);
                lines.push('    </testcase>');
            }
        }
        lines.push('  </testsuite>');
    }
    lines.push('</testsuites>');
    return `${lines.join('\n')}\n`;
}

/** One result as it appears in JSON and JUnit. Passing tests stay short. */
function resultOf(event, node) {
    const result = {
        fullName: event.fullName,
        className: node ? classOf(node) : '',
        name: node ? node.name : event.fullName,
        status: event.status,
        duration: event.duration,
    };
    if (event.status === 'passed') return result;
    return { ...result, message: event.message, stack: event.stack, output: event.output };
}

module.exports = {
    plural,
    formatSeconds,
    capText,
    formatFailure,
    slowest,
    countResults,
    formatCounts,
    formatSync,
    formatUnresolved,
    Progress,
    toJUnit,
    resultOf,
};
