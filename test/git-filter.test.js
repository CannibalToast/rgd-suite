'use strict';
/**
 * Contract of the `rgd` git clean/smudge filter (cli/setup-git-diff.*):
 * clean = `to-text - -o -`, smudge = `from-text - -o -`.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'cli', 'rgd-cli.js');
const bin = fs.readFileSync(path.join(__dirname, 'fixtures', 'space_marine_hq_addon_1.rgd'));
const run = cmd => input => execFileSync('node', [CLI, cmd, '-', '-o', '-'], { input, stdio: 'pipe' });
const clean = run('to-text');
const smudge = run('from-text');

const text = clean(bin);
assert.ok(text.toString().startsWith('# RGD Text Format'), 'clean stores text');
assert.ok(smudge(text).equals(bin), 'smudge restores byte-identical binary');
assert.ok(clean(text).equals(text), 'clean accepts already-text input (resolved merge)');
assert.ok(smudge(bin).equals(bin), 'smudge passes pre-filter binary blobs through');

const conflicted = Buffer.from(text.toString().replace(/^(\s*time_seconds.*)$/m, '<<<<<<< HEAD\n$1\n=======\n$1\n>>>>>>> other'));
assert.ok(smudge(conflicted).equals(conflicted), 'smudge leaves conflict markers for the user');
assert.throws(() => clean(conflicted), 'clean refuses unresolved conflicts');

// A float the text format can't reproduce (negative NaN) must be stored as binary, never altered.
const at = bin.indexOf(Buffer.from([0x00, 0x00, 0x7a, 0x44])); // 1000.0f, the health modifier value
assert.ok(at > 0, 'fixture contains 1000.0f');
const negNaN = Buffer.from(bin);
negNaN.writeUInt32LE(0xffc00000, at);
assert.ok(clean(negNaN).equals(negNaN), 'clean falls back to binary when text would be lossy');
const corrupt = bin.subarray(0, 200);
assert.ok(clean(corrupt).equals(corrupt), 'clean stores unparseable RGDs unchanged');
assert.ok(smudge(corrupt).equals(corrupt), 'and smudge hands them back unchanged');

// git-setup must restore .rgd files a pre-setup checkout left as text (git reports them clean).
const os = require('os');
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-setup-'));
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
git('init', '-q');
fs.writeFileSync(path.join(repo, '.gitattributes'), '*.rgd -text filter=rgd\n');
fs.writeFileSync(path.join(repo, 'hq.rgd'), text);
git('add', '.');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'text on disk, no filter yet');
execFileSync('node', [CLI, 'git-setup'], { cwd: repo, stdio: 'pipe' });
assert.ok(fs.readFileSync(path.join(repo, 'hq.rgd')).equals(bin), 'git-setup restores stale text checkouts to binary');
assert.strictEqual(git('status', '--porcelain').toString(), '', 'and the tree stays clean');
fs.rmSync(repo, { recursive: true, force: true });

console.log('git-filter tests complete');
