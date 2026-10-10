#!/usr/bin/env node
/**
 * Guarded test runner for dsh-vision-better.
 *
 * Why this exists instead of a plain `node --test` in package.json:
 * on Node v24.16.0 `node --test` exits 0 when it discovers ZERO test files —
 * even when given an explicit glob that matches nothing (both verified). A
 * renamed or lost test file therefore still reports green. This runner asserts
 * the suite size first and exits 2 when the suite shrinks, so "all passed" can
 * never silently mean "nothing ran".
 *
 * Usage:
 *   node test/run.mjs [expectedMinFiles]
 * Exit codes: 0 all passed, 1 at least one test failed, 2 discovery guard tripped.
 */

import { globSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const toPosix = (value) => value.replaceAll('\\', '/');

/** Minimum number of test files that must be discovered for the run to be meaningful. */
const EXPECTED_MIN = Number(process.argv[2] ?? 8);

const files = globSync(`${toPosix(root)}/test/**/*.test.mjs`).sort();

if (files.length < EXPECTED_MIN) {
  console.error(`DISCOVERY GUARD FAILED: found ${files.length} test file(s), expected >= ${EXPECTED_MIN}`);
  for (const file of files) console.error(`  discovered: ${relative(root, file)}`);
  process.exit(2);
}

if (files.length === 0) {
  console.error('DISCOVERY GUARD FAILED: no test files at all');
  process.exit(2);
}

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];

for await (const event of run({ files, concurrency: 1 })) {
  if (event.type === 'test:pass') {
    if (event.data?.skip === true || event.data?.skipped === true) skipped += 1;
    else pass += 1;
  } else if (event.type === 'test:fail') {
    fail += 1;
    const detail = event.data?.details?.error;
    failures.push(`  FAIL ${event.data?.name ?? '(unnamed)'}\n       ${String(detail?.message ?? detail ?? 'no detail').split('\n')[0]}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failing test(s):`);
  for (const line of failures) console.error(line);
}

console.log(`\nvision-better: files=${files.length} pass=${pass} fail=${fail} skipped=${skipped}`);
process.exit(fail > 0 ? 1 : 0);
