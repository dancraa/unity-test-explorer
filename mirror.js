// One-way folder mirror. Only ever writes to the target.
const fs = require('fs');
const path = require('path');

const COPY_CONCURRENCY = 16;
// Enough for a copied timestamp to lose its fraction of a millisecond, and too short to save a file twice in.
const FINE_TOLERANCE_MS = 5;
// FAT stores even seconds and HFS+ whole ones.
const COARSE_TOLERANCE_MS = 2001;
const LOCKED_FILE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

function isSameFile(source, target, toleranceMs) {
    return target !== null && source.size === target.size && Math.abs(source.mtimeMs - target.mtimeMs) < toleranceMs;
}

/** How far apart the timestamps of a file and its copy in `dir` can be, which depends on the file system. */
async function measureTolerance(dir) {
    const probe = path.join(dir, `timestamp-probe-${process.pid}`);
    // An odd second with a fraction, which a coarse file system can't store.
    const seconds = 1500000001.987;
    try {
        await fs.promises.writeFile(probe, '');
        await fs.promises.utimes(probe, seconds, seconds);
        const gap = Math.abs((await fs.promises.stat(probe)).mtimeMs - seconds * 1000);
        return gap < FINE_TOLERANCE_MS ? FINE_TOLERANCE_MS : COARSE_TOLERANCE_MS;
    } finally {
        await fs.promises.rm(probe, { force: true });
    }
}

async function statOrNull(filePath) {
    try {
        return await fs.promises.stat(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

/**
 * Makes `target` match `source`: copies new or changed files and deletes everything else.
 * Names in `excludeNames` are neither copied nor deleted. Links are followed once, so a link
 * back into a parent folder can't recurse forever. Stops early once `isCancelled` returns true.
 */
async function mirror(source, target, { excludeNames = [], tolerateLockedFiles = false, toleranceMs = FINE_TOLERANCE_MS, isCancelled = () => false } = {}) {
    const excluded = new Set(excludeNames);
    const visited = new Set();
    const copies = [];
    // `restored` are the copies and deletions that undo a change made in the target.
    const stats = { copied: 0, deleted: 0, skipped: 0, restored: 0 };

    async function walk(sourceDir, targetDir) {
        if (isCancelled()) return;
        const real = await fs.promises.realpath(sourceDir);
        if (visited.has(real)) return;
        visited.add(real);

        await fs.promises.mkdir(targetDir, { recursive: true });
        const entries = (await fs.promises.readdir(sourceDir, { withFileTypes: true })).filter(e => !excluded.has(e.name));
        const names = new Set(entries.map(e => e.name));

        for (const existing of await fs.promises.readdir(targetDir)) {
            if (names.has(existing) || excluded.has(existing)) continue;
            await fs.promises.rm(path.join(targetDir, existing), { recursive: true, force: true });
            stats.deleted++;
            // Unity adds a missing .meta itself, and a deleted one goes along with its asset anyway.
            if (existing.endsWith('.meta')) stats.restored++;
        }

        for (const entry of entries) {
            const sourcePath = path.join(sourceDir, entry.name);
            const targetPath = path.join(targetDir, entry.name);
            const sourceStat = await statOrNull(sourcePath);
            if (sourceStat === null) continue;

            if (sourceStat.isDirectory()) {
                await walk(sourcePath, targetPath);
            } else {
                const targetStat = await statOrNull(targetPath);
                if (isSameFile(sourceStat, targetStat, toleranceMs)) continue;
                // Copies keep their timestamp, so a newer target was written to since.
                const isRestore = targetStat !== null && targetStat.mtimeMs - sourceStat.mtimeMs >= toleranceMs;
                copies.push({ sourcePath, targetPath, sourceStat, isRestore });
            }
        }
    }

    await walk(source, target);

    async function copyNext() {
        while (copies.length > 0 && !isCancelled()) {
            const { sourcePath, targetPath, sourceStat, isRestore } = copies.pop();
            try {
                await fs.promises.copyFile(sourcePath, targetPath);
                // Unity's importer relies on timestamps, so copies keep the original.
                await fs.promises.utimes(targetPath, sourceStat.atime, sourceStat.mtime);
                stats.copied++;
                if (isRestore) stats.restored++;
            } catch (error) {
                if (!tolerateLockedFiles || !LOCKED_FILE_CODES.has(error.code)) throw error;
                stats.skipped++;
            }
        }
    }
    await Promise.all(Array.from({ length: COPY_CONCURRENCY }, copyNext));
    return stats;
}

module.exports = { mirror, isSameFile, measureTolerance, FINE_TOLERANCE_MS };
