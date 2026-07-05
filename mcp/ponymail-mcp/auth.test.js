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
  // Always strip the opt-in and credential env vars so individual tests can
  // re-set them explicitly and aren't perturbed by the dev's own shell.
  delete baseEnv.PONYMAIL_AUTO_EXTRACT_COOKIE;
  delete baseEnv.PONYMAIL_API_TOKEN;
  delete baseEnv.PONYMAIL_SESSION_COOKIE;
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

function writeTokenFile(home, payload) {
  const dir = path.join(home, ".ponymail-mcp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "token.json"), JSON.stringify(payload));
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

// ---------------------------------------------------------------------------
// Long-term API token persistence
// ---------------------------------------------------------------------------

test("loadToken returns null when neither env var nor file is set", () => {
  withTempHome((home) => {
    const out = runInChild(home, `return a.loadToken();`);
    assert.equal(out, null);
  });
});

test("loadToken returns the env var when PONYMAIL_API_TOKEN is set", () => {
  withTempHome((home) => {
    const out = runInChild(home, `return a.loadToken();`, {
      PONYMAIL_API_TOKEN: "pmt_envtoken",
    });
    assert.equal(out, "pmt_envtoken");
  });
});

test("loadToken reads the cached token.json file when no env var is set", () => {
  withTempHome((home) => {
    writeTokenFile(home, { token: "pmt_filetoken", id: "abc", timestamp: Date.now() });
    const out = runInChild(home, `return a.loadToken();`);
    assert.equal(out, "pmt_filetoken");
  });
});

test("loadToken: env var wins over the cached file", () => {
  withTempHome((home) => {
    writeTokenFile(home, { token: "pmt_filetoken" });
    const out = runInChild(home, `return a.loadToken();`, {
      PONYMAIL_API_TOKEN: "pmt_envtoken",
    });
    assert.equal(out, "pmt_envtoken");
  });
});

test("loadToken returns null for a malformed token file", () => {
  withTempHome((home) => {
    const dir = path.join(home, ".ponymail-mcp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "token.json"), "{ not json");
    const out = runInChild(home, `return a.loadToken();`);
    assert.equal(out, null);
  });
});

test("saveToken then loadToken round-trips the secret", () => {
  withTempHome((home) => {
    const out = runInChild(
      home,
      `a.saveToken("pmt_new", { id: "id1", description: "desc" }); return a.loadToken();`
    );
    assert.equal(out, "pmt_new");
  });
});

test("loadTokenMeta returns the non-secret metadata but not the token", () => {
  withTempHome((home) => {
    writeTokenFile(home, {
      token: "pmt_secret",
      id: "id1",
      description: "laptop",
      expires: 123,
      timestamp: Date.now(),
    });
    const out = runInChild(home, `return a.loadTokenMeta();`);
    assert.deepEqual(out, { id: "id1", description: "laptop", expires: 123 });
    assert.equal(out.token, undefined);
  });
});

test("loadTokenMeta returns null when there is no metadata beyond the token", () => {
  withTempHome((home) => {
    writeTokenFile(home, { token: "pmt_secret", timestamp: Date.now() });
    const out = runInChild(home, `return a.loadTokenMeta();`);
    assert.equal(out, null);
  });
});

test("clearToken removes the token file", () => {
  withTempHome((home) => {
    writeTokenFile(home, { token: "pmt_x" });
    const tokenFile = path.join(home, ".ponymail-mcp", "token.json");
    assert.equal(existsSync(tokenFile), true, "precondition: file exists");
    runInChild(home, `a.clearToken(); return null;`);
    assert.equal(existsSync(tokenFile), false, "token file should be deleted");
  });
});

// ---------------------------------------------------------------------------
// Credential resolution (token preferred over cookie)
// ---------------------------------------------------------------------------

test("resolveAuthHeaders returns no credential when nothing is configured", () => {
  withTempHome((home) => {
    const out = runInChild(home, `return a.resolveAuthHeaders();`);
    assert.equal(out.kind, null);
    assert.deepEqual(out.headers, {});
  });
});

test("resolveAuthHeaders uses a Bearer token when one is configured", () => {
  withTempHome((home) => {
    const out = runInChild(home, `return a.resolveAuthHeaders();`, {
      PONYMAIL_API_TOKEN: "pmt_abc",
    });
    assert.equal(out.kind, "token");
    assert.equal(out.source, "env");
    assert.deepEqual(out.headers, { Authorization: "Bearer pmt_abc" });
  });
});

test("resolveAuthHeaders falls back to the cookie when no token is set", () => {
  withTempHome((home) => {
    writeSessionFile(home, { cookie: "ponymail=abc", timestamp: Date.now() });
    const out = runInChild(home, `return a.resolveAuthHeaders();`);
    assert.equal(out.kind, "cookie");
    assert.deepEqual(out.headers, { Cookie: "ponymail=abc" });
  });
});

test("resolveAuthHeaders prefers the token over an available cookie", () => {
  withTempHome((home) => {
    writeSessionFile(home, { cookie: "ponymail=abc", timestamp: Date.now() });
    const out = runInChild(home, `return a.resolveAuthHeaders();`, {
      PONYMAIL_API_TOKEN: "pmt_abc",
    });
    assert.equal(out.kind, "token");
    assert.deepEqual(out.headers, { Authorization: "Bearer pmt_abc" });
  });
});

test("resolveCookie returns null when no cookie is available, ignoring any token", () => {
  withTempHome((home) => {
    const out = runInChild(home, `return a.resolveCookie();`, {
      PONYMAIL_API_TOKEN: "pmt_abc",
    });
    assert.equal(out, null);
  });
});

test("resolveCookie: env cookie wins over the cached session file", () => {
  withTempHome((home) => {
    writeSessionFile(home, { cookie: "ponymail=fromfile", timestamp: Date.now() });
    const out = runInChild(home, `return a.resolveCookie();`, {
      PONYMAIL_SESSION_COOKIE: "ponymail=fromenv",
    });
    assert.deepEqual(out, { cookie: "ponymail=fromenv", source: "env" });
  });
});

// ---------------------------------------------------------------------------
// API error / auth-failure messaging (describeApiError)
// ---------------------------------------------------------------------------

function describe(status, body, auth) {
  return withTempHome((home) =>
    runInChild(
      home,
      `return a.describeApiError(${JSON.stringify(status)}, ${JSON.stringify(body)}, ${JSON.stringify(auth)});`
    )
  );
}

test("describeApiError: scope failure names the fix regardless of credential kind", () => {
  const body = JSON.stringify({ okay: false, message: "This API token lacks the required scope for this endpoint." });
  const out = describe(403, body, { kind: "token" });
  assert.match(out, /lacks the required scope/i);
  assert.match(out, /create_token/);
  // The server's own message is echoed in.
  assert.match(out, /required scope for this endpoint/i);
});

test("describeApiError: 401/403 with a token blames the token and points at auth_status", () => {
  const out = describe(401, JSON.stringify({ okay: false, message: "Unauthorized" }), { kind: "token" });
  assert.match(out, /rejected the API token/i);
  assert.match(out, /invalid, expired, or revoked/i);
  assert.match(out, /PONYMAIL_API_TOKEN/);
});

test("describeApiError: 401/403 with a cookie points back at login", () => {
  const out = describe(403, "", { kind: "cookie" });
  assert.match(out, /rejected the session/i);
  assert.match(out, /login again/i);
});

test("describeApiError: 401/403 with no credential asks the caller to authenticate", () => {
  const out = describe(401, "", { kind: null });
  assert.match(out, /requires authentication/i);
  assert.match(out, /login tool or set an API token/i);
});

test("describeApiError: a scope hint in a plain-text (non-JSON) body is still detected", () => {
  const out = describe(403, "token scope insufficient", { kind: "token" });
  assert.match(out, /lacks the required scope/i);
});

test("describeApiError: non-auth status falls through to a generic message", () => {
  const out = describe(500, JSON.stringify({ okay: false, message: "boom" }), { kind: "token" });
  assert.match(out, /^PonyMail API error 500: boom/);
});

test("describeApiError: non-auth status with a plain body keeps the raw text", () => {
  const out = describe(404, "Not found", { kind: null });
  assert.match(out, /PonyMail API error 404: Not found/);
});
