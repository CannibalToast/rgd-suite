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

console.log('git-filter tests complete');
