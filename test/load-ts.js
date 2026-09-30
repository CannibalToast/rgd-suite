'use strict';
const path = require('path');
const { Module, createRequire } = require('module');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');

function loadTs(relativePath) {
    const filename = path.join(ROOT, relativePath);
    const code = esbuild.buildSync({
        entryPoints: [filename],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node16',
        write: false,
        external: ['vscode'],
        logLevel: 'silent',
    }).outputFiles[0].text;
    const m = new Module(filename, module);
    m.filename = filename;
    m.paths = Module._nodeModulePaths(path.dirname(filename));
    const localRequire = createRequire(filename);
    m.require = (id) => (id === 'vscode' ? {} : localRequire(id));
    m._compile(code, filename);
    return m.exports;
}

module.exports = { loadTs };
