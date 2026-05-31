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

// Tests for the session-persistence helpers in auth.js (loadSession,
// clearSession). The session file lives at ~/.ponymail-mcp/session.json,
// computed at module import time from os.homedir(), so each test spawns a
// child node process with HOME pointed at a temporary directory.
//
// The interactive performLogin() flow (browser open, local HTTP server,
// cookie-paste form, network validation) is not covered by these tests —
// it requires a real browser and network and belongs in an integration
// suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, "auth.js");

function withTempHome(fn) {
  const home = mkdtempSync(path.join(tmpdir(), "ponymail-auth-test-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function runInChild(home, snippet, extraEnv = {}) {
  const code = `
    const a = await import(${JSON.stringify(modulePath)});
    const out = await (async () => { ${snippet} })();
    process.stdout.write(JSON.stringify(out));
  `;
  const baseEnv = { ...process.env, HOME: home, USERPROFILE: home };
  // Always strip the opt-in so individual tests can re-set it explicitly.
  delete baseEnv.PONYMAIL_AUTO_EXTRACT_COOKIE;
  const res = spawnSync("node", ["--input-type=module", "-e", code], {
    env: { ...baseEnv, ...extraEnv },
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`child failed: ${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

function writeSessionFile(home, payload) {
  const dir = path.join(home, ".ponymail-mcp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "session.json"), JSON.stringify(payload));
}

test("loadSession returns null when no session file exists", () => {
  withTempHome((home) => {
    const out = runInChild(home, `return a.loadSession();`);
    assert.equal(out, null);
  });
});

test("loadSession returns the cookie when the file is fresh", () => {
  withTempHome((home) => {
    writeSessionFile(home, {
      cookie: "ponymail=abc123",
      timestamp: Date.now(),
      user: { fullname: "Test" },
    });
    const out = runInChild(home, `return a.loadSession();`);
    assert.equal(out, "ponymail=abc123");
  });
});

test("loadSession returns null when the session is older than 20 hours", () => {
  withTempHome((home) => {
    const TWENTY_ONE_HOURS = 21 * 60 * 60 * 1000;
    writeSessionFile(home, {
      cookie: "ponymail=stale",
      timestamp: Date.now() - TWENTY_ONE_HOURS,
    });
    const out = runInChild(home, `return a.loadSession();`);
    assert.equal(out, null);
  });
});

test("loadSession returns the cookie when there is no timestamp at all", () => {
  // Behaviour today: missing timestamp skips the expiry check.
  withTempHome((home) => {
    writeSessionFile(home, { cookie: "ponymail=untimestamped" });
    const out = runInChild(home, `return a.loadSession();`);
    assert.equal(out, "ponymail=untimestamped");
  });
});

test("loadSession returns null when the file is malformed JSON", () => {
  withTempHome((home) => {
    const dir = path.join(home, ".ponymail-mcp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "session.json"), "{ not json");
    const out = runInChild(home, `return a.loadSession();`);
    assert.equal(out, null);
  });
});

test("loadSession returns null when the cookie field is missing", () => {
  withTempHome((home) => {
    writeSessionFile(home, { timestamp: Date.now() });
    const out = runInChild(home, `return a.loadSession();`);
    assert.equal(out, null);
  });
});

test("clearSession removes an existing session file", () => {
  withTempHome((home) => {
    writeSessionFile(home, { cookie: "ponymail=x", timestamp: Date.now() });
    const sessionFile = path.join(home, ".ponymail-mcp", "session.json");
    assert.equal(existsSync(sessionFile), true, "precondition: file exists");

    runInChild(home, `a.clearSession(); return null;`);

    assert.equal(existsSync(sessionFile), false, "session file should be deleted");
  });
});

test("clearSession is a no-op when no session file exists", () => {
  withTempHome((home) => {
    // Should not throw.
    const out = runInChild(home, `a.clearSession(); return "ok";`);
    assert.equal(out, "ok");
  });
});

// ---------------------------------------------------------------------------
// Auto-extract opt-in gate
// ---------------------------------------------------------------------------

test("autoExtractEnabled is false by default (env var unset)", () => {
  withTempHome((home) => {
    const out = runInChild(home, `return a.autoExtractEnabled();`);
    assert.equal(out, false);
  });
});

test("autoExtractEnabled is false for empty / falsy env var values", () => {
  withTempHome((home) => {
    for (const v of ["", "0", "no", "false", "off", "anything-else"]) {
      const out = runInChild(home, `return a.autoExtractEnabled();`, {
        PONYMAIL_AUTO_EXTRACT_COOKIE: v,
      });
      assert.equal(out, false, `expected false for env value ${JSON.stringify(v)}`);
    }
  });
});

test("autoExtractEnabled is true for the four accepted opt-in values", () => {
  withTempHome((home) => {
    for (const v of ["1", "true", "yes", "on", "TRUE", " 1 "]) {
      const out = runInChild(home, `return a.autoExtractEnabled();`, {
        PONYMAIL_AUTO_EXTRACT_COOKIE: v,
      });
      assert.equal(out, true, `expected true for env value ${JSON.stringify(v)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Smart paste extraction
// ---------------------------------------------------------------------------

function extract(input) {
  return withTempHome((home) =>
    runInChild(home, `return a.extractPonymailFromPaste(${JSON.stringify(input)});`)
  );
}

test("extractPonymailFromPaste returns null for empty / whitespace input", () => {
  assert.equal(extract(""), null);
  assert.equal(extract("   \n  "), null);
  assert.equal(extract(null), null);
  assert.equal(extract(undefined), null);
});

test("extractPonymailFromPaste accepts the raw ponymail=<value> token", () => {
  assert.equal(
    extract("ponymail=5dc60945-f52a-4690-aaaa-bbbbbbbbbbbb"),
    "ponymail=5dc60945-f52a-4690-aaaa-bbbbbbbbbbbb"
  );
});

test("extractPonymailFromPaste extracts from a full Cookie: header line", () => {
  const input = "Cookie: lang=en; ponymail=5dc60945-f52a-4690-aaaa-bbbbbbbbbbbb; _ga=GA1.1.42";
  assert.equal(extract(input), "ponymail=5dc60945-f52a-4690-aaaa-bbbbbbbbbbbb");
});

test("extractPonymailFromPaste extracts from a multi-line Request Headers paste", () => {
  const input = [
    "Host: lists.apache.org",
    "User-Agent: Mozilla/5.0",
    "Accept: application/json",
    "Cookie: foo=bar; ponymail=5dc60945-f52a-4690-aaaa-bbbbbbbbbbbb; baz=qux",
    "Connection: keep-alive",
  ].join("\n");
  assert.equal(extract(input), "ponymail=5dc60945-f52a-4690-aaaa-bbbbbbbbbbbb");
});

test("extractPonymailFromPaste accepts a bare UUID (8-4-4-4-12)", () => {
  assert.equal(
    extract("5dc60945-f52a-4690-aaaa-bbbbbbbbbbbb"),
    "ponymail=5dc60945-f52a-4690-aaaa-bbbbbbbbbbbb"
  );
});

test("extractPonymailFromPaste is case-insensitive on the token name", () => {
  assert.equal(
    extract("Cookie: PonyMail=5dc60945-f52a-4690-aaaa-bbbbbbbbbbbb;"),
    "ponymail=5dc60945-f52a-4690-aaaa-bbbbbbbbbbbb"
  );
});

test("extractPonymailFromPaste stops the value at the first separator", () => {
  // The implementation breaks on whitespace, ;, ',', single-quote, double-quote
  // — make sure trailing cookies / quotes don't leak into the value.
  assert.equal(
    extract('"ponymail=abc-123"; other=xx'),
    "ponymail=abc-123"
  );
  assert.equal(
    extract("ponymail=abc-123,other=xx"),
    "ponymail=abc-123"
  );
});

test("extractPonymailFromPaste returns null when no ponymail token is present", () => {
  assert.equal(extract("Cookie: lang=en; _ga=GA1.1.42"), null);
  assert.equal(extract("definitely not a cookie"), null);
});

test("extractPonymailFromPaste rejects a malformed bare value (not a UUID)", () => {
  // We only accept bare UUIDs without the prefix; arbitrary strings shouldn't
  // be silently wrapped in "ponymail=".
  assert.equal(extract("not-a-uuid-shaped-string"), null);
});
