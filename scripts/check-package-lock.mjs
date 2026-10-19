#!/usr/bin/env node
// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

// package.json <-> package-lock.json sync check (zero runtime dependencies).
//
// npm copies a subset of package.json into the lock file's root entry
// (`packages[""]`). If package.json is edited without regenerating the lock
// file, the two silently disagree and the next `npm install` produces an
// unrelated diff. This check fails when any of those mirrored fields differ.
//
// Usage:  node scripts/check-package-lock.mjs <project-dir | package.json | package-lock.json>...
//         (default: "."; file arguments are checked as their containing directory)
//
// Fix a failure with:  (cd <project-dir> && npm install --package-lock-only)

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

// Fields npm mirrors from package.json into the lock file's root entry.
const MIRRORED_FIELDS = [
  "name",
  "version",
  "license",
  "bin",
  "engines",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

function checkProject(dir) {
  const pkgPath = join(dir, "package.json");
  const lockPath = join(dir, "package-lock.json");
  if (!existsSync(pkgPath)) return [`${pkgPath}: not found`];
  if (!existsSync(lockPath)) return [`${lockPath}: not found (lock files must be committed)`];

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const root = lock.packages?.[""];
  if (!root) return [`${lockPath}: missing root entry packages[""] (expected lockfileVersion >= 2)`];

  const problems = [];
  for (const top of ["name", "version"]) {
    if (pkg[top] !== lock[top]) {
      problems.push(`${top}: package.json has ${JSON.stringify(pkg[top])}, lock file has ${JSON.stringify(lock[top])}`);
    }
  }
  for (const field of MIRRORED_FIELDS) {
    if (!isDeepStrictEqual(pkg[field], root[field])) {
      problems.push(
        `packages[""].${field}: package.json has ${JSON.stringify(pkg[field])}, ` +
          `lock file has ${JSON.stringify(root[field])}`
      );
    }
  }
  return problems.map((p) => `${lockPath}: ${p}`);
}

// prek passes the changed package.json / package-lock.json files; check each
// containing project once.
const args = process.argv.slice(2);
const dirs = new Set(
  (args.length ? args : ["."]).map((a) =>
    /(^|[\\/])package(-lock)?\.json$/.test(a) ? dirname(a) : a
  )
);
let failed = false;
for (const dir of dirs) {
  const problems = checkProject(dir);
  if (problems.length) {
    failed = true;
    for (const p of problems) console.error(p);
    console.error(`  -> run: (cd ${dir} && npm install --package-lock-only)\n`);
  }
}
process.exit(failed ? 1 : 0);
