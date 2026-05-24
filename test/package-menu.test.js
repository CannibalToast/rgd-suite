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
    assert(/^validate@/.test(menuCommand(id).group), `${id} is grouped under validate@`);
}

assert.strictEqual(menuCommand('rgdSuite.checkParity').group, 'validate@1');

console.log('PASS package contributes validation commands and validate menu group');
