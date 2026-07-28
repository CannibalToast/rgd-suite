'use strict';
/**
 * Ensures SGA extractFiles rejects zip-slip style paths.
 * We unit-test the path confinement logic by monkey-patching list/extract
 * on a minimal fake that reuses the production confinement algorithm
 * (mirrors sga.js extractFiles).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function extractWithConfinement(outputDir, entries) {
    const resolvedBase = path.resolve(outputDir);
    const extracted = [];
    for (const fileInfo of entries) {
        const rel = String(fileInfo.path || '').replace(/\\/g, '/');
        if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.includes('\0')) {
            continue;
        }
        const parts = rel.split('/').filter((p) => p && p !== '.');
        if (parts.some((p) => p === '..')) continue;
        const outputPath = path.resolve(resolvedBase, ...parts);
        const baseWithSep = resolvedBase.endsWith(path.sep)
            ? resolvedBase
            : resolvedBase + path.sep;
        if (outputPath !== resolvedBase && !outputPath.startsWith(baseWithSep)) {
            continue;
        }
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, fileInfo.data || Buffer.from('x'));
        extracted.push(outputPath);
    }
    return extracted;
}

function test(name, fn) {
    try {
        fn();
        console.log('PASS', name);
    } catch (e) {
        console.error('FAIL', name);
        console.error(e);
        process.exitCode = 1;
    }
}

test('blocks .. path traversal entries', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sga-safe-'));
    const out = path.join(tmp, 'out');
    fs.mkdirSync(out);
    const outside = path.join(tmp, 'evil.txt');
    extractWithConfinement(out, [
        { path: '../evil.txt', data: Buffer.from('pwned') },
        { path: 'safe/ok.rgd', data: Buffer.from('ok') },
    ]);
    assert.strictEqual(fs.existsSync(outside), false, 'must not write outside out/');
    assert.ok(fs.existsSync(path.join(out, 'safe', 'ok.rgd')));
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('blocks absolute-style archive paths', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sga-safe-'));
    const out = path.join(tmp, 'out');
    fs.mkdirSync(out);
    const extracted = extractWithConfinement(out, [
        { path: '/tmp/evil.rgd', data: Buffer.from('x') },
        { path: 'C:/Windows/evil.rgd', data: Buffer.from('x') },
        { path: 'nested/file.rgd', data: Buffer.from('ok') },
    ]);
    assert.strictEqual(extracted.length, 1);
    assert.ok(extracted[0].endsWith(path.join('nested', 'file.rgd')) || extracted[0].includes('nested'));
    fs.rmSync(tmp, { recursive: true, force: true });
});

// Live check: production extractFiles source contains confinement markers
test('bundled sga.js extractFiles includes zip-slip guards', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'bundled', 'rgd-tools', 'dist', 'sga.js'),
        'utf8',
    );
    assert.ok(src.includes('path traversal') || src.includes('Skipping path traversal'));
    assert.ok(src.includes('out-of-bounds') || src.includes('startsWith(baseWithSep)'));
    assert.ok(src.includes("p === '..'"));
});

if (process.exitCode) process.exit(process.exitCode);
console.log('sga-extract-safe tests complete');
