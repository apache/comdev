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

function runInChild(home, snippet) {
  const code = `
    const a = await import(${JSON.stringify(modulePath)});
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
