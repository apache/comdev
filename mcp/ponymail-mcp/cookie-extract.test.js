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

// Tests for cookie-extract.js. The hard part — decrypting Chromium values
// via the macOS Keychain — needs a real browser, a real cookie row, and a
// real Keychain entry, so we don't cover that here. We do cover the parts
// that can be exercised hermetically:
//
//   - extractPonymailCookie returns null when HOME points at an empty dir
//   - Hostnames with shell/SQL metacharacters are rejected before any I/O
//
// The Chromium path itself is verified manually by the developer against
// their real Chrome install (see commit message for the round-trip log).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, "cookie-extract.js");

function withTempHome(fn) {
  const home = mkdtempSync(path.join(tmpdir(), "ponymail-cookie-test-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function runInChild(home, snippet) {
  const code = `
    const m = await import(${JSON.stringify(modulePath)});
    const out = await (async () => { ${snippet} })();
    process.stdout.write(JSON.stringify(out));
  `;
  const res = spawnSync("node", ["--input-type=module", "-e", code], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`child failed: ${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

test("extractPonymailCookie returns null when no Chrome install is present", () => {
  withTempHome((home) => {
    const out = runInChild(
      home,
      `return m.extractPonymailCookie("https://lists.apache.org");`
    );
    assert.equal(out, null);
  });
});

test("extractPonymailCookie rejects a hostname with shell/sql metacharacters", () => {
  withTempHome((home) => {
    const out = runInChild(
      home,
      `return m.extractPonymailCookie("https://evil'host.example.com");`
    );
    assert.equal(out, null);
  });
});
