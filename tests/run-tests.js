#!/usr/bin/env node
/**
 * Runs the Apps Script test suite locally with Node, no Google account
 * needed:   node tests/run-tests.js
 *
 * Apps Script files share one global scope, so they are loaded into a
 * single sandbox in the same order Apps Script would see them. Google
 * services (Gmail, Drive, Sheets) are never called by the tested
 * functions, so only Logger needs a stand-in.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'apps-script');
const files = ['config.example.gs', 'intake.gs', 'normalize.gs', 'health-check.gs', 'tests.gs'];

const logs = [];
const sandbox = { Logger: { log: function (msg) { logs.push(String(msg)); } } };
vm.createContext(sandbox);

const source = files.map(function (f) {
  return '// ---- ' + f + ' ----\n' + fs.readFileSync(path.join(root, f), 'utf8');
}).join('\n') + '\n;globalThis.__results = runAllTests();';

vm.runInContext(source, sandbox, { filename: 'apps-script-bundle.js' });

logs.forEach(function (l) { console.log(l); });
process.exit(sandbox.__results.failed === 0 ? 0 : 1);
