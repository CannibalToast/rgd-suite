#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

function command(id) {
    return pkg.contributes.commands.find((entry) => entry.command === id);
}

function menuCommand(id) {
    return pkg.contributes.menus['rgdSuite.explorerContext'].find((entry) => entry.command === id);
}

for (const id of ['rgd.validatePath', 'rgd.validateEncoding', 'rgd.validateReferences', 'rgd.batchValidate']) {
    assert(command(id), `${id} command is contributed`);
    assert(menuCommand(id), `${id} menu item is contributed`);
    assert(
      /validate@/.test(menuCommand(id).group || ''),
      `${id} is grouped under *validate@* (got ${menuCommand(id).group})`,
    );
}

assert.strictEqual(menuCommand('rgdSuite.checkParity').group, '3_validate@1');
assert(command('rgdSuite.showGitTableDiff'), 'rgdSuite.showGitTableDiff command is contributed');
assert(menuCommand('rgdSuite.showGitTableDiff'), 'rgdSuite.showGitTableDiff menu item is contributed');

const comfortIds = [
  'rgdSuite.cloneFile',
  'rgdSuite.openCounterpart',
  'rgdSuite.openPairSideBySide',
  'rgdSuite.openParentReference',
  'rgdSuite.findReferencesToFile',
  'rgdSuite.searchKeyInFolder',
  'rgdSuite.copyAttribPath',
  'rgdSuite.copyReferenceSnippet',
  'rgdSuite.copyHash',
  'rgdSuite.renamePair',
  'rgdSuite.compareTwoRgd',
  'rgdSuite.newRgdFromTemplate',
  'rgdSuite.convertSelectionToLua',
  'rgdSuite.stripBom',
  'rgdSuite.refreshCaches',
  'rgdSuite.findFilesByName',
];
for (const id of comfortIds) {
  assert(command(id), `${id} command is contributed`);
}

const submenus = (pkg.contributes.submenus || []).map((s) => s.id);
for (const id of ['rgdSuite.explorerCopy', 'rgdSuite.explorerNavigate', 'rgdSuite.explorerTools']) {
  assert(submenus.includes(id), `submenu ${id} is contributed`);
  assert(pkg.contributes.menus[id] && pkg.contributes.menus[id].length, `menu ${id} has items`);
}

assert(
  menuCommand('rgdSuite.cloneFile') ||
    pkg.contributes.menus['rgdSuite.explorerContext'].some((e) => e.command === 'rgdSuite.cloneFile'),
  'cloneFile is in explorer context',
);

const vscodeignore = fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8');
assert(/RGD/.test(vscodeignore), '.vscodeignore must exclude RGD/ reference tree');

console.log('PASS package contributes validation commands and validate menu group');
