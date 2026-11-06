// One-way folder mirror. Only ever writes to the target.
const fs = require('fs');
const path = require('path');

const COPY_CONCURRENCY = 16;
const LOCKED_FILE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

function isSameFile(source, target) {
    // File systems store timestamps at different precisions, so a small gap still means unchanged.
    return target !== null && source.size === target.size && Math.abs(source.mtimeMs - target.mtimeMs) < 2000;
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
 * back into a parent folder can't recurse forever.
 */
async function mirror(source, target, { excludeNames = [], tolerateLockedFiles = false } = {}) {
    const excluded = new Set(excludeNames);
    const visited = new Set();
    const copies = [];
    const stats = { copied: 0, deleted: 0, skipped: 0 };

    async function walk(sourceDir, targetDir) {
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
        }

        for (const entry of entries) {
            const sourcePath = path.join(sourceDir, entry.name);
            const targetPath = path.join(targetDir, entry.name);
            const sourceStat = await statOrNull(sourcePath);
            if (sourceStat === null) continue;

            if (sourceStat.isDirectory()) {
                await walk(sourcePath, targetPath);
            } else if (!isSameFile(sourceStat, await statOrNull(targetPath))) {
                copies.push({ sourcePath, targetPath, sourceStat });
            }
        }
    }

    await walk(source, target);

    async function copyNext() {
        while (copies.length > 0) {
            const { sourcePath, targetPath, sourceStat } = copies.pop();
            try {
                await fs.promises.copyFile(sourcePath, targetPath);
                // Unity's importer relies on timestamps, so copies keep the original.
                await fs.promises.utimes(targetPath, sourceStat.atime, sourceStat.mtime);
                stats.copied++;
            } catch (error) {
                if (!tolerateLockedFiles || !LOCKED_FILE_CODES.has(error.code)) throw error;
                stats.skipped++;
            }
        }
    }
    await Promise.all(Array.from({ length: COPY_CONCURRENCY }, copyNext));
    return stats;
}

module.exports = { mirror };
