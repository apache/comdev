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
// The interactive paste flow of performLogin() (local HTTP server,
// cookie-paste form, network validation) is not covered by these tests —
// it requires a real browser and network and belongs in an integration
// suite. The session-token flow (performTokenLogin) is covered end to end
// against a fake PonyMail server, with the browser simulated by the
// openUrl hook. The browser login (performBrowserLogin) runs against a fake
// browser that speaks the DevTools protocol over the same pipe Chrome uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, statSync } from "node:fs";
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
  // Always strip the opt-ins and credentials so individual tests can re-set them explicitly.
  delete baseEnv.PONYMAIL_AUTO_EXTRACT_COOKIE;
  delete baseEnv.PONYMAIL_AUTH_METHOD;
  delete baseEnv.PONYMAIL_TOKEN;
  delete baseEnv.PONYMAIL_SESSION_COOKIE;
  delete baseEnv.PONYMAIL_BROWSER;
  delete baseEnv.PONYMAIL_BROWSER_PROFILE;
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

// ---------------------------------------------------------------------------
// Credential selection (loadAuth / authHeaders / authMethod)
// ---------------------------------------------------------------------------

const IN_AN_HOUR = () => Math.floor(Date.now() / 1000) + 3600;

test("loadAuth returns null with no env vars and no session file", () => {
  withTempHome((home) => {
    assert.equal(runInChild(home, `return a.loadAuth();`), null);
    assert.deepEqual(runInChild(home, `return a.authHeaders();`), {});
  });
});

test("loadAuth prefers PONYMAIL_TOKEN over PONYMAIL_SESSION_COOKIE and the file", () => {
  withTempHome((home) => {
    writeSessionFile(home, { cookie: "ponymail=file", timestamp: Date.now() });
    const out = runInChild(home, `return [a.loadAuth(), a.authHeaders()];`, {
      PONYMAIL_TOKEN: "pmt_env",
      PONYMAIL_SESSION_COOKIE: "ponymail=env",
    });
    assert.deepEqual(out[0], { type: "token", value: "pmt_env", source: "env" });
    assert.deepEqual(out[1], { Authorization: "Bearer pmt_env" });
  });
});

test("loadAuth uses PONYMAIL_SESSION_COOKIE over the file", () => {
  withTempHome((home) => {
    writeSessionFile(home, { cookie: "ponymail=file", timestamp: Date.now() });
    const out = runInChild(home, `return a.authHeaders();`, { PONYMAIL_SESSION_COOKIE: "ponymail=env" });
    assert.deepEqual(out, { Cookie: "ponymail=env" });
  });
});

test("loadAuth returns a cached cookie as a cookie credential", () => {
  withTempHome((home) => {
    writeSessionFile(home, { cookie: "ponymail=file", timestamp: Date.now() });
    const out = runInChild(home, `return a.authHeaders();`);
    assert.deepEqual(out, { Cookie: "ponymail=file" });
  });
});

test("loadAuth returns a cached, unexpired token as a bearer credential", () => {
  withTempHome((home) => {
    const expires = IN_AN_HOUR();
    writeSessionFile(home, { type: "token", token: "pmt_file", expires, timestamp: Date.now() });
    const out = runInChild(home, `return [a.loadAuth(), a.authHeaders(), a.loadSession()];`);
    assert.equal(out[0].type, "token");
    assert.equal(out[0].expires, expires);
    assert.deepEqual(out[1], { Authorization: "Bearer pmt_file" });
    assert.equal(out[2], null, "loadSession only ever returns cookies");
  });
});

test("loadAuth drops a cached token that is expired or about to expire", () => {
  withTempHome((home) => {
    const soon = Math.floor(Date.now() / 1000) + 30;
    writeSessionFile(home, { type: "token", token: "pmt_file", expires: soon, timestamp: Date.now() });
    assert.equal(runInChild(home, `return a.loadAuth();`), null);
  });
});

test("authMethod defaults to cookie and accepts token", () => {
  withTempHome((home) => {
    assert.equal(runInChild(home, `return a.authMethod();`), "cookie");
    assert.equal(runInChild(home, `return a.authMethod();`, { PONYMAIL_AUTH_METHOD: "Token" }), "token");
    assert.equal(runInChild(home, `return a.authMethod();`, { PONYMAIL_AUTH_METHOD: "bogus" }), "cookie");
  });
});

// ---------------------------------------------------------------------------
// Session-token login against a fake PonyMail server
// ---------------------------------------------------------------------------

// Child-process preamble: a fake PonyMail on a random loopback port. `mode`
// selects how its token endpoint behaves: "absent" (old server, 404),
// "disabled", or "enabled". Only the bearer token "pmt_good" is accepted.
function fakePonymail(mode) {
  return `
    const http = await import("node:http");
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const seen = { revoked: 0, opened: [] };
    const fake = http.createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      const json = (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const good = req.headers.authorization === "Bearer pmt_good";
      if (url.pathname === "/api/token.lua" && url.searchParams.get("action") === "info") {
        if (${JSON.stringify(mode)} === "absent") { res.writeHead(404); res.end("API Endpoint not found!"); return; }
        return json(200, { okay: true, enabled: ${JSON.stringify(mode)} === "enabled", ttl: 3600, max_ttl: 86400 });
      }
      if (url.pathname === "/api/preferences.lua") {
        if (!good) return json(200, { login: {} });
        return json(200, { login: {
          credentials: { fullname: "Test User", email: "test@apache.org" },
          token: { id: "abc", client: "ponymail-mcp", expires },
        } });
      }
      if (url.pathname === "/api/token.json" && req.method === "POST") {
        if (!good) return json(403, { okay: false, error: "login_required" });
        seen.revoked++;
        return json(200, { okay: true, revoked: 1 });
      }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => fake.listen(0, "127.0.0.1", r));
    const base = "http://127.0.0.1:" + fake.address().port;
    // Simulated browser: what token.html does after the user clicks a button.
    const post = (target, fields) => fetch(target, { method: "POST", body: new URLSearchParams(fields) });
    const browser = (respond) => (approvalUrl) => {
      const u = new URL(approvalUrl);
      seen.opened.push(u.pathname + " " + u.searchParams.get("client") + " " + new URL(u.searchParams.get("redirect_uri")).hostname);
      setTimeout(() => respond(u.searchParams.get("redirect_uri"), u.searchParams.get("state")), 10);
    };
  `;
}

test("performTokenLogin: approved token is validated and cached", () => {
  withTempHome((home) => {
    const out = runInChild(home, fakePonymail("enabled") + `
      const result = await a.performTokenLogin(base, {
        openUrl: browser((cb, state) => post(cb, { token: "pmt_good", state, expires: String(expires) })),
      });
      fake.close();
      return { result, auth: a.loadAuth(), seen };
    `);
    assert.equal(out.result.source, "token");
    assert.equal(out.result.token, "pmt_good");
    assert.deepEqual(out.result.user, { fullname: "Test User", email: "test@apache.org" });
    assert.deepEqual(out.seen.opened, ["/token.html ponymail-mcp 127.0.0.1"]);
    assert.equal(out.auth.type, "token");
    assert.equal(out.auth.value, "pmt_good");
    assert.equal(out.auth.source, "file");
  });
});

test("performTokenLogin: the cached token file is owner-only", { skip: process.platform === "win32" }, () => {
  withTempHome((home) => {
    runInChild(home, fakePonymail("enabled") + `
      await a.performTokenLogin(base, {
        openUrl: browser((cb, state) => post(cb, { token: "pmt_good", state, expires: String(expires) })),
      });
      fake.close();
      return null;
    `);
    const mode = statSync(path.join(home, ".ponymail-mcp", "session.json")).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test("performTokenLogin: a callback with the wrong state is rejected and ignored", () => {
  withTempHome((home) => {
    const out = runInChild(home, fakePonymail("enabled") + `
      let forged;
      const result = await a.performTokenLogin(base, {
        openUrl: browser(async (cb, state) => {
          forged = (await post(cb, { token: "pmt_evil", state: "not-the-state" })).status;
          await post(cb, { token: "pmt_good", state, expires: String(expires) });
        }),
      });
      fake.close();
      return { forged, token: result.token };
    `);
    assert.equal(out.forged, 400);
    assert.equal(out.token, "pmt_good");
  });
});

test("performTokenLogin: denial in the browser fails the login", () => {
  withTempHome((home) => {
    const out = runInChild(home, fakePonymail("enabled") + `
      try {
        await a.performTokenLogin(base, { openUrl: browser((cb, state) => post(cb, { error: "access_denied", state })) });
        return "resolved";
      } catch (e) {
        return e.message;
      } finally {
        fake.close();
      }
    `);
    assert.match(out, /denied/);
    assert.equal(existsSync(path.join(home, ".ponymail-mcp", "session.json")), false);
  });
});

test("performTokenLogin: a token PonyMail does not accept is not cached", () => {
  withTempHome((home) => {
    const out = runInChild(home, fakePonymail("enabled") + `
      try {
        await a.performTokenLogin(base, { openUrl: browser((cb, state) => post(cb, { token: "pmt_bad", state })) });
        return "resolved";
      } catch (e) {
        return e.message;
      } finally {
        fake.close();
      }
    `);
    assert.match(out, /validation failed/);
    assert.equal(existsSync(path.join(home, ".ponymail-mcp", "session.json")), false);
  });
});

test("performTokenLogin: a server without the token endpoint fails fast, without a browser", () => {
  withTempHome((home) => {
    const out = runInChild(home, fakePonymail("absent") + `
      try {
        await a.performTokenLogin(base, { openUrl: browser(() => {}) });
        return "resolved";
      } catch (e) {
        return { message: e.message, opened: seen.opened.length };
      } finally {
        fake.close();
      }
    `);
    assert.match(out.message, /does not support session tokens/);
    assert.match(out.message, /lists\.apache\.org/);
    assert.equal(out.opened, 0);
  });
});

test("performTokenLogin: a server with tokens switched off fails fast", () => {
  withTempHome((home) => {
    const out = runInChild(home, fakePonymail("disabled") + `
      try {
        await a.performTokenLogin(base, { openUrl: browser(() => {}) });
        return "resolved";
      } catch (e) {
        return e.message;
      } finally {
        fake.close();
      }
    `);
    assert.match(out, /switched off/);
  });
});

test("performTokenLogin: times out when nobody approves", () => {
  withTempHome((home) => {
    const out = runInChild(home, fakePonymail("enabled") + `
      try {
        await a.performTokenLogin(base, { timeoutMs: 200, openUrl: () => {} });
        return "resolved";
      } catch (e) {
        return e.message;
      } finally {
        fake.close();
      }
    `);
    assert.match(out, /No approval received/);
  });
});

test("revokeToken revokes on the server and reports failure for unknown tokens", () => {
  withTempHome((home) => {
    const out = runInChild(home, fakePonymail("enabled") + `
      const ok = await a.revokeToken(base, "pmt_good");
      const bad = await a.revokeToken(base, "pmt_bad");
      fake.close();
      return { ok, bad, revoked: seen.revoked };
    `);
    assert.deepEqual(out, { ok: true, bad: false, revoked: 1 });
  });
});

// ---------------------------------------------------------------------------
// Browser login against a fake browser and a fake PonyMail server
// ---------------------------------------------------------------------------

// A stand-in for Chrome: a node script that speaks the DevTools protocol over
// --remote-debugging-pipe (commands on fd 3, replies on fd 4). FAKE_BROWSER_MODE
// picks the scenario; everything it was asked is logged to FAKE_BROWSER_LOG.
//   login — no cookie, then a rejected cookie, then a good one (plus a
//           ponymail cookie for another host that must be ignored)
//   close — the user closes the window without logging in
//   hang  — the user never logs in
const FAKE_BROWSER = `#!/usr/bin/env node
const fs = require("node:fs");
const mode = process.env.FAKE_BROWSER_MODE;
const log = (entry) => fs.appendFileSync(process.env.FAKE_BROWSER_LOG, JSON.stringify(entry) + "\\n");
log({ args: process.argv.slice(2) });
const out = fs.createWriteStream(null, { fd: 4 });
const reply = (id, result) => out.write(JSON.stringify({ id, result }) + "\\0");
const other = { name: "ponymail", value: "elsewhere", domain: "lists.example.org" };
const jars = [[], [{ name: "ponymail", value: "bad", domain: "127.0.0.1" }],
  [other, { name: "ponymail", value: "good", domain: "127.0.0.1" }]];
let polls = 0, buf = "";
fs.createReadStream(null, { fd: 3 }).on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\0")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    log({ method: msg.method });
    if (msg.method === "Browser.close") { reply(msg.id, {}); setTimeout(() => process.exit(0), 10); continue; }
    if (msg.method === "Storage.getCookies") {
      polls++;
      if (mode === "close" && polls > 2) process.exit(0);
      const cookies = mode === "login" ? jars[Math.min(polls - 1, jars.length - 1)] : [];
      reply(msg.id, { cookies });
    }
  }
});
`;

function fakeCookiePonymail() {
  return `
    const http = await import("node:http");
    const fake = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url.startsWith("/api/preferences.lua") && req.headers.cookie === "ponymail=good") {
        res.end(JSON.stringify({ login: { credentials: { fullname: "Test User", email: "test@apache.org" } } }));
      } else {
        res.end(JSON.stringify({ login: {} }));
      }
    });
    await new Promise((r) => fake.listen(0, "127.0.0.1", r));
    const base = "http://127.0.0.1:" + fake.address().port;
  `;
}

function withFakeBrowser(home, mode, fn) {
  const browserPath = path.join(home, "fake-browser.cjs");
  writeFileSync(browserPath, FAKE_BROWSER, { mode: 0o755 });
  const logPath = path.join(home, "browser.log");
  writeFileSync(logPath, "");
  const out = fn(browserPath, { FAKE_BROWSER_MODE: mode, FAKE_BROWSER_LOG: logPath });
  const log = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { out, log };
}

const skipOnWindows = { skip: process.platform === "win32" };

test("performBrowserLogin: picks up the logged-in cookie, caches it and cleans up", skipOnWindows, () => {
  withTempHome((home) => {
    const { out, log } = withFakeBrowser(home, "login", (browserPath, env) =>
      runInChild(home, fakeCookiePonymail() + `
        const result = await a.performBrowserLogin(base, { browserPath: ${JSON.stringify(browserPath)}, pollMs: 10 });
        fake.close();
        return { result, auth: a.loadAuth(), base };
      `, env));
    assert.equal(out.result.source, "browser-login");
    assert.equal(out.result.cookie, "ponymail=good");
    assert.deepEqual(out.result.user, { fullname: "Test User", email: "test@apache.org" });
    assert.equal(out.auth.type, "cookie");
    assert.equal(out.auth.value, "ponymail=good");

    const args = log[0].args;
    assert.ok(args.includes("--remote-debugging-pipe"));
    assert.equal(args.at(-1), `${out.base}/oauth.html`);
    const profile = args.find((x) => x.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
    assert.equal(existsSync(profile), false, "temporary profile is deleted");

    if (process.platform === "darwin") assert.ok(args.includes("--use-mock-keychain"));
    if (process.platform === "linux") assert.ok(args.includes("--password-store=basic"));

    const methods = log.slice(1).map((e) => e.method);
    assert.equal(methods.filter((m) => m === "Storage.getCookies").length, 3);
    assert.equal(methods.at(-1), "Browser.close");
  });
});

test("performBrowserLogin: PONYMAIL_BROWSER_PROFILE=persistent keeps an owner-only profile on the real credential store", skipOnWindows, () => {
  withTempHome((home) => {
    const { out, log } = withFakeBrowser(home, "login", (browserPath, env) =>
      runInChild(home, fakeCookiePonymail() + `
        const result = await a.performBrowserLogin(base, { browserPath: ${JSON.stringify(browserPath)}, pollMs: 10 });
        fake.close();
        return { result };
      `, { ...env, PONYMAIL_BROWSER_PROFILE: "persistent" }));
    assert.equal(out.result.cookie, "ponymail=good");
    const profile = path.join(home, ".ponymail-mcp", "browser-profile");
    const args = log[0].args;
    assert.ok(args.includes(`--user-data-dir=${profile}`));
    assert.ok(!args.includes("--use-mock-keychain"));
    assert.ok(!args.includes("--password-store=basic"));
    assert.equal(existsSync(profile), true, "kept profile survives the login");
    assert.equal(statSync(profile).mode & 0o777, 0o700);
  });
});

test("browserProfileDir: temporary by default, kept on opt-in", () => {
  withTempHome((home) => {
    const run = (value) => runInChild(home, "return a.browserProfileDir();",
      value === undefined ? {} : { PONYMAIL_BROWSER_PROFILE: value });
    assert.equal(run(undefined), null);
    assert.equal(run("temporary"), null);
    assert.equal(run("relative/dir"), null);
    assert.equal(run("persistent"), path.join(home, ".ponymail-mcp", "browser-profile"));
    assert.equal(run("1"), path.join(home, ".ponymail-mcp", "browser-profile"));
    assert.equal(run(path.join(home, "elsewhere")), path.join(home, "elsewhere"));
  });
});

test("performBrowserLogin: closing the window before logging in fails the login", skipOnWindows, () => {
  withTempHome((home) => {
    const { out } = withFakeBrowser(home, "close", (browserPath, env) =>
      runInChild(home, fakeCookiePonymail() + `
        let error = null;
        try { await a.performBrowserLogin(base, { browserPath: ${JSON.stringify(browserPath)}, pollMs: 10 }); }
        catch (err) { error = err.message; }
        fake.close();
        return { error, auth: a.loadAuth() };
      `, env));
    assert.match(out.error, /closed before the login completed/);
    assert.equal(out.auth, null);
  });
});

test("performBrowserLogin: times out and closes the window when nobody logs in", skipOnWindows, () => {
  withTempHome((home) => {
    const { out, log } = withFakeBrowser(home, "hang", (browserPath, env) =>
      runInChild(home, fakeCookiePonymail() + `
        let error = null;
        try { await a.performBrowserLogin(base, { browserPath: ${JSON.stringify(browserPath)}, pollMs: 10, timeoutMs: 200 }); }
        catch (err) { error = err.message; }
        fake.close();
        return { error, auth: a.loadAuth() };
      `, env));
    assert.match(out.error, /not completed in the browser within 0.2s/);
    assert.equal(out.auth, null);
    assert.equal(log.at(-1).method, "Browser.close");
  });
});

test("performBrowserLogin: a browser that cannot be started is reported as a launch failure", () => {
  withTempHome((home) => {
    const out = runInChild(home, fakeCookiePonymail() + `
      let error = null;
      try { await a.performBrowserLogin(base, { browserPath: ${JSON.stringify(path.join(home, "no-such-browser"))} }); }
      catch (err) { error = { message: err.message, code: err.code }; }
      fake.close();
      return error;
    `);
    assert.equal(out.code, "BROWSER_LAUNCH_FAILED");
    assert.match(out.message, /Could not start the browser/);
  });
});
