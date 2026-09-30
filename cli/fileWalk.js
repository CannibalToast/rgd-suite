'use strict';
const fs = require('fs');
const path = require('path');

async function walkFiles(folder, extensions, { grouped = false, yieldEvery = 0 } = {}) {
    const buckets = grouped ? extensions.map(() => []) : null;
    const files = [];
    const stack = [folder];
    let dirsVisited = 0;
    while (stack.length) {
        const dir = stack.pop();
        dirsVisited++;
        if (yieldEvery > 0 && dirsVisited % yieldEvery === 0) {
            await new Promise((resolve) => setImmediate(resolve));
        }
        let entries;
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                stack.push(full);
            } else if (e.isFile()) {
                const lower = e.name.toLowerCase();
                if (buckets) {
                    for (let i = 0; i < extensions.length; i++) {
                        if (lower.endsWith(extensions[i])) buckets[i].push(full);
                    }
                } else {
                    for (const ext of extensions) {
                        if (lower.endsWith(ext)) {
                            files.push(full);
                            break;
                        }
                    }
                }
            }
        }
    }
    return buckets ? buckets.flat() : files;
}

module.exports = { walkFiles };
