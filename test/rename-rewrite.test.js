'use strict';
/**
 * Tests for rename-pair path rewrite helpers (mirrors comfortCommands logic).
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');
const os = require('os');

// Compile comfortCommands helpers out of the TS source via esbuild for unit use.
// Simpler: reimplement the pure functions here in lockstep with the source
// (same approach as table-diff tests) and assert contract documented in source.

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRenameReplacements(oldRelNoExt, newRelNoExt) {
  const oldFwd = oldRelNoExt.replace(/\\/g, '/');
  const newFwd = newRelNoExt.replace(/\\/g, '/');
  const oldBack = oldFwd.replace(/\//g, '\\');
  const newBack = newFwd.replace(/\//g, '\\');
  const oldBase = path.posix.basename(oldFwd);
  const newBase = path.posix.basename(newFwd);
  const pairs = [];
  const add = (from, to) => {
    if (from && to && from !== to) pairs.push({ from, to });
  };
  for (const [o, n] of [[oldFwd, newFwd], [oldBack, newBack]]) {
    add(o, n);
    add(o + '.rgd', n + '.rgd');
    add(o + '.lua', n + '.lua');
  }
  add('data/attrib/' + oldFwd, 'data/attrib/' + newFwd);
  if (oldBase.length >= 4 && oldBase !== newBase) {
    add(oldBase + '.rgd', newBase + '.rgd');
    add(oldBase + '.lua', newBase + '.lua');
    add(oldBase, newBase);
  }
  pairs.sort((a, b) => b.from.length - a.from.length);
  const seen = new Set();
  return pairs.filter((p) => {
    if (seen.has(p.from)) return false;
    seen.add(p.from);
    return true;
  });
}

function applyPathReplacements(text, replacements) {
  let out = text;
  let count = 0;
  const samples = [];
  for (const { from, to } of replacements) {
    const isBareStem =
      !from.includes('/') && !from.includes('\\') && !/\.(rgd|lua|nil)$/i.test(from);
    if (isBareStem) {
      const re = new RegExp(
        `(^|[/\\\\."'])(${escapeRegExp(from)})(?=$|[/\\\\."'])`,
        'gi',
      );
      out = out.replace(re, (m, pre, stem) => {
        count++;
        if (samples.length < 5) samples.push(`${stem} → ${to}`);
        return pre + to;
      });
    } else if (out.includes(from)) {
      const parts = out.split(from);
      const n = parts.length - 1;
      if (n > 0) {
        count += n;
        if (samples.length < 5) samples.push(`${from} → ${to}`);
        out = parts.join(to);
      }
    }
  }
  return { text: out, count, samples };
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

test('buildRenameReplacements orders longest first', () => {
  const r = buildRenameReplacements('ebps/races/allies/soldiers/engineer', 'ebps/races/allies/soldiers/engineer_elite');
  assert.ok(r.length >= 3);
  assert.ok(r[0].from.length >= r[r.length - 1].from.length);
  assert.ok(r.some((p) => p.from.endsWith('.lua') && p.to.includes('engineer_elite')));
});

test('applyPathReplacements rewrites Reference and Inherit args', () => {
  const reps = buildRenameReplacements(
    'ebps/races/allies/soldiers/engineer',
    'ebps/races/allies/soldiers/engineer_elite',
  );
  const src = `
GameData = Inherit([[ebps\\races\\allies\\soldiers\\engineer.lua]])
GameData["child"] = Reference([[ebps/races/allies/soldiers/engineer]])
some_path = "ebps/races/allies/soldiers/engineer.rgd"
`;
  const r = applyPathReplacements(src, reps);
  assert.ok(r.count >= 3, 'expected multiple replacements, got ' + r.count);
  assert.ok(r.text.includes('engineer_elite'));
  assert.ok(!r.text.includes('soldiers/engineer.lua'));
  assert.ok(!r.text.includes('soldiers/engineer.rgd'));
});

test('bare stem does not rewrite substrings of other words', () => {
  const reps = buildRenameReplacements('x/unit_foo', 'x/unit_bar');
  // "unit_foo" as bare stem; "unit_foobar" must not become "unit_barbar"
  const src = 'unit_foobar and unit_foo and "unit_foo"';
  const r = applyPathReplacements(src, reps);
  assert.ok(r.text.includes('unit_foobar'), 'must not clobber longer names: ' + r.text);
  assert.ok(r.text.includes('unit_bar'), 'must rewrite whole stem: ' + r.text);
});

test('data/attrib prefixed forms', () => {
  const reps = buildRenameReplacements('sbps/races/foo', 'sbps/races/bar');
  const src = 'Reference("data/attrib/sbps/races/foo")';
  const r = applyPathReplacements(src, reps);
  assert.ok(r.text.includes('data/attrib/sbps/races/bar'));
});

if (process.exitCode) process.exit(process.exitCode);
console.log('rename-rewrite tests complete');
