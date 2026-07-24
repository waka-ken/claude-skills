#!/usr/bin/env node
/**
 * Collect top-level function / const / let / var names from all *.gs files
 * so ESLint can treat multi-file GAS projects as one shared global scope.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = path.join(root, 'eslint.gas-globals.json');

const DECL =
  /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=)/gm;

const globals = Object.create(null);
const files = fs
  .readdirSync(root)
  .filter(name => name.endsWith('.gs'))
  .sort();

for (const file of files) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  for (const match of source.matchAll(DECL)) {
    const name = match[1] || match[2];
    if (name) globals[name] = 'readonly';
  }
}

fs.writeFileSync(outPath, `${JSON.stringify(globals, null, 2)}\n`);
console.log(
  `Wrote ${Object.keys(globals).length} GAS project globals → ${path.relative(root, outPath)}`
);
