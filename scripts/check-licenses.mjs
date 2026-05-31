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

// Dependency-license allowlist check (zero runtime dependencies).
//
// Walks an installed project's node_modules, reads each dependency's declared
// license, and fails if any license falls outside the ASF Category-A allowlist
// below. Run AFTER `npm ci` so node_modules reflects the committed lock file.
//
// Usage:  node scripts/check-licenses.mjs [project-dir]   (default: ".")
//
// A project may whitelist vetted exceptions in
// `<project-dir>/.license-allowlist-exceptions.json`:
//   { "some-pkg": "reason", "other-pkg@1.2.3": "reason" }

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// ASF Category-A (permissive) SPDX identifiers — safe to depend on.
// https://www.apache.org/legal/resolved.html#category-a
const ALLOWLIST = new Set([
  "Apache-2.0",
  "Apache-1.1",
  "MIT",
  "MIT-0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSD-3-Clause-Clear",
  "BSD-2-Clause-Patent",
  "0BSD",
  "Zlib",
  "Unlicense",
  "CC0-1.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "BSL-1.0",
  "BlueOak-1.0.0",
  "Python-2.0",
  "PSF-2.0",
  "WTFPL",
]);

const projectDir = resolve(process.argv[2] || ".");
const modulesDir = join(projectDir, "node_modules");
const lockFile = join(projectDir, "package-lock.json");

if (!existsSync(modulesDir)) {
  console.error(
    `SKIP: ${modulesDir} not found — run \`npm ci\` first so licenses can be checked.`
  );
  process.exit(0); // non-fatal: nothing installed to inspect (e.g. local pre-push without install)
}
if (!existsSync(lockFile)) {
  console.error(`ERROR: ${lockFile} is missing — commit the lock file for reproducible checks.`);
  process.exit(1);
}

// Load per-project exceptions.
let exceptions = {};
const exFile = join(projectDir, ".license-allowlist-exceptions.json");
if (existsSync(exFile)) {
  exceptions = JSON.parse(readFileSync(exFile, "utf8"));
}

// Normalize a package's license field (string | {type} | deprecated licenses[]).
function readLicense(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((l) => (typeof l === "string" ? l : l.type)).filter(Boolean).join(" OR ");
  }
  return null;
}

// Evaluate a (simple) SPDX license expression against the allowlist.
// OR: any operand allowed → allowed. AND: all operands allowed. WITH: use the
// left license. Parentheses are stripped pragmatically (real-world expressions
// are flat enough that precedence edge cases don't arise).
function isAllowed(expr) {
  if (!expr) return false;
  const clean = expr.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  if (/ OR /i.test(clean)) return clean.split(/ OR /i).some((p) => isAllowed(p));
  if (/ AND /i.test(clean)) return clean.split(/ AND /i).every((p) => isAllowed(p));
  const id = clean.split(/ WITH /i)[0].trim().replace(/\+$/, "");
  return ALLOWLIST.has(id);
}

// Recursively collect package.json files under node_modules (incl. nested + scoped).
function* walkPackages(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const name = entry.name;
    if (name === ".bin" || name === ".cache") continue;
    const full = join(dir, name);
    if (name.startsWith("@")) {
      yield* walkPackages(full); // scope dir — descend into each scoped pkg
      continue;
    }
    const pkgJson = join(full, "package.json");
    if (existsSync(pkgJson)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
        if (pkg.name && pkg.version) yield pkg;
      } catch {
        /* ignore unparseable package.json */
      }
    }
    // descend into nested node_modules
    const nested = join(full, "node_modules");
    if (existsSync(nested) && statSync(nested).isDirectory()) yield* walkPackages(nested);
  }
}

const violations = [];
const seen = new Set();
let checked = 0;

for (const pkg of walkPackages(modulesDir)) {
  const idKey = `${pkg.name}@${pkg.version}`;
  if (seen.has(idKey)) continue;
  seen.add(idKey);
  if (exceptions[pkg.name] || exceptions[idKey]) continue;
  checked++;
  const license = readLicense(pkg);
  if (!isAllowed(license)) {
    violations.push({ id: idKey, license: license || "(none declared)" });
  }
}

const projectName = (() => {
  try {
    return JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")).name;
  } catch {
    return projectDir;
  }
})();

if (violations.length) {
  console.error(`\n✗ ${projectName}: ${violations.length} dependency license(s) outside the ASF Category-A allowlist:\n`);
  for (const v of violations.sort((a, b) => a.id.localeCompare(b.id))) {
    console.error(`  - ${v.id}: ${v.license}`);
  }
  console.error(
    `\nResolve by removing the dependency, or — if the license is ASF-compatible —\n` +
      `add it to the ALLOWLIST in scripts/check-licenses.mjs, or record a vetted\n` +
      `exception in ${join(projectDir, ".license-allowlist-exceptions.json")}.`
  );
  process.exit(1);
}

console.log(`✓ ${projectName}: ${checked} dependencies checked, all licenses in the ASF Category-A allowlist.`);
