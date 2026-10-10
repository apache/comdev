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

/**
 * browser-login.js — log in through a throwaway browser window and read the
 * session cookie from it.
 *
 * Why not a normal OAuth redirect to localhost? ASF OAuth only redirects back
 * to registered ASF hosts (any other redirect_uri, including loopback, is
 * refused), and the PonyMail session cookie is HttpOnly, so no page script or
 * bookmarklet can read it. What *can* read it is the browser's own DevTools
 * protocol.
 *
 * So this module launches a Chromium-family browser (Chrome, Edge, Brave,
 * Chromium) with:
 *   - a fresh, temporary profile (--user-data-dir) — the MCP never sees your
 *     everyday browser profile, only the cookies of this one window;
 *   - --remote-debugging-pipe — the DevTools protocol over two inherited file
 *     descriptors (fd 3: commands to the browser, fd 4: replies), so no port is
 *     opened and nothing else on the machine can attach to it.
 *
 * The user logs in to PonyMail in that window as usual; we poll the browser's
 * cookie jar until the `ponymail` cookie for the PonyMail host shows up. The
 * caller validates it, then the window is closed and the profile deleted.
 *
 * Opt-in persistent profile (PONYMAIL_BROWSER_PROFILE): the profile is kept
 * between logins, so the ASF OAuth / PonyMail login — and a password saved in
 * the browser's password manager — survive and the next login is a click or
 * nothing at all. A kept profile uses the OS credential store (macOS
 * Keychain, Linux keyring) instead of the mock one, so its cookies and saved
 * passwords are encrypted at rest with a key only the browser can read
 * without an OS prompt.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const COOKIE_NAME = "ponymail";

/** A delay that does not keep the process alive on its own */
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms).unref());
}

// ---------------------------------------------------------------------------
// Browser discovery
// ---------------------------------------------------------------------------

function candidatePaths() {
  if (process.platform === "darwin") {
    return [
      "Google Chrome",
      "Chromium",
      "Microsoft Edge",
      "Brave Browser",
    ].flatMap((app) => [
      `/Applications/${app}.app/Contents/MacOS/${app}`,
      path.join(os.homedir(), `Applications/${app}.app/Contents/MacOS/${app}`),
    ]);
  }
  if (process.platform === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
      .filter(Boolean);
    return roots.flatMap((root) => [
      path.join(root, "Google/Chrome/Application/chrome.exe"),
      path.join(root, "Microsoft/Edge/Application/msedge.exe"),
      path.join(root, "BraveSoftware/Brave-Browser/Application/brave.exe"),
      path.join(root, "Chromium/Application/chrome.exe"),
    ]);
  }
  return [];
}

const LINUX_COMMANDS = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
  "microsoft-edge-stable",
  "brave-browser",
];

function onPath(cmd) {
  const res = spawnSync("which", [cmd], { encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() || null : null;
}

/**
 * The Chromium-family browser to log in with, or null when none is available.
 * PONYMAIL_BROWSER overrides discovery: a path to the executable, or "none"
 * to switch the browser login off and always use the paste form.
 */
export function findBrowser() {
  const override = (process.env.PONYMAIL_BROWSER || "").trim();
  if (override.toLowerCase() === "none") return null;
  if (override) return override;
  for (const p of candidatePaths()) {
    if (fs.existsSync(p)) return p;
  }
  if (process.platform === "linux") {
    for (const cmd of LINUX_COMMANDS) {
      const found = onPath(cmd);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// DevTools protocol over --remote-debugging-pipe
// ---------------------------------------------------------------------------

/**
 * Minimal CDP client: JSON messages, each terminated by a NUL byte, written to
 * the browser's fd 3 and read from its fd 4.
 */
export class PipeCdp {
  constructor(writable, readable) {
    this.writable = writable;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    let buf = "";
    readable.setEncoding("utf8");
    readable.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\0")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.#dispatch(raw);
      }
    });
    readable.on("close", () => this.#fail(new Error("browser connection closed")));
    readable.on("error", (err) => this.#fail(err));
    writable.on("error", (err) => this.#fail(err));
  }

  #dispatch(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // Events (no id) are not used here
    const waiter = msg.id !== undefined && this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(`${waiter.method}: ${msg.error.message}`));
    else waiter.resolve(msg.result || {});
  }

  #fail(err) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("browser connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.writable.write(JSON.stringify({ id, method, params }) + "\0");
    });
  }
}

/** The ponymail cookie for `host` out of a CDP cookie list, as "ponymail=<value>" */
export function pickSessionCookie(cookies, host) {
  const match = (cookies || []).find((c) => {
    if (c.name !== COOKIE_NAME || !c.value) return false;
    const domain = String(c.domain || "").replace(/^\./, "").toLowerCase();
    const h = host.toLowerCase();
    return domain === h || h.endsWith(`.${domain}`);
  });
  return match ? `${COOKIE_NAME}=${match.value}` : null;
}

function browserArgs(profileDir, startUrl, persistent) {
  const args = [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-pipe",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--new-window",
  ];
  // Keep a throwaway profile away from the OS credential store: no Keychain
  // prompt on macOS, no keyring prompt on Linux. A kept profile must use the
  // real store — with the mock one its cookies and passwords are encrypted
  // with a well-known key, i.e. effectively stored in plain text.
  if (!persistent) {
    if (process.platform === "darwin") args.push("--use-mock-keychain");
    if (process.platform === "linux") args.push("--password-store=basic");
  }
  args.push(startUrl);
  return args;
}

/**
 * Open `startUrl` in a fresh browser window and wait until the user has logged
 * in, i.e. until a `ponymail` cookie for `host` appears that `accept` approves.
 *
 * @param {object} opts
 * @param {string} opts.browserPath - Chromium-family executable
 * @param {string} opts.startUrl - Page to open (the PonyMail login page)
 * @param {string} opts.host - Host the session cookie belongs to
 * @param {(cookie: string) => Promise<any>} opts.accept - Resolves to a truthy
 *   value when the cookie is a logged-in session; that value is returned
 * @param {number} opts.timeoutMs - Max time to wait for the login
 * @param {number} [opts.pollMs] - How often to read the cookie jar
 * @param {string} [opts.profileDir] - Profile to keep between logins; by
 *   default a temporary profile is created and deleted afterwards
 * @returns {Promise<{cookie: string, accepted: any}>}
 */
export function loginInBrowser({ browserPath, startUrl, host, accept, timeoutMs, pollMs = 1000, profileDir: keptProfile }) {
  const persistent = !!keptProfile;
  let profileDir;
  if (persistent) {
    fs.mkdirSync(keptProfile, { recursive: true, mode: 0o700 });
    fs.chmodSync(keptProfile, 0o700);
    profileDir = keptProfile;
  } else {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "ponymail-mcp-browser-"));
  }
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    let pollTimer = null;
    let lastTried = null;

    const proc = spawn(browserPath, browserArgs(profileDir, startUrl, persistent), {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    });
    const cdp = new PipeCdp(proc.stdio[3], proc.stdio[4]);

    const exited = new Promise((r) => {
      if (proc.exitCode !== null) r();
      else {
        proc.once("exit", r);
        proc.once("error", r);
      }
    });

    async function shutDown() {
      clearTimeout(pollTimer);
      clearTimeout(timer);
      try {
        await Promise.race([cdp.send("Browser.close"), exited]);
      } catch {}
      await Promise.race([exited, delay(3000)]);
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      await Promise.race([exited, delay(1000)]);
      if (!persistent) fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }

    function settle(err, result) {
      if (settled) return;
      settled = true;
      shutDown().finally(() => (err ? reject(err) : resolve(result)));
    }

    const timer = setTimeout(() => {
      settle(new Error(`Login not completed in the browser within ${timeoutMs / 1000}s. Call login again to retry.`));
    }, timeoutMs);

    proc.once("error", (err) => {
      const launchErr = new Error(`Could not start the browser (${browserPath}): ${err.message}`);
      launchErr.code = "BROWSER_LAUNCH_FAILED";
      settle(launchErr);
    });
    proc.once("exit", () => {
      // A browser already running on a kept profile takes the new window over
      // and the process we started exits at once — without a pipe to us.
      const hint = persistent && Date.now() - startedAt < 5000
        ? ` If a browser window using the PonyMail login profile (${profileDir}) is still open, close it and call login again.`
        : "";
      settle(new Error(`The browser window was closed before the login completed.${hint}`));
    });

    async function poll() {
      if (settled) return;
      try {
        const { cookies } = await cdp.send("Storage.getCookies");
        const cookie = pickSessionCookie(cookies, host);
        // Only re-check a cookie when it changes: before login PonyMail may
        // not set one, and a value that was rejected once stays rejected.
        if (cookie && cookie !== lastTried) {
          lastTried = cookie;
          const accepted = await accept(cookie);
          if (accepted) {
            settle(null, { cookie, accepted });
            return;
          }
        }
      } catch (err) {
        if (cdp.closed) return; // the exit handler reports this
        console.error(`[auth] reading browser cookies failed: ${err.message}`);
      }
      if (!settled) pollTimer = setTimeout(poll, pollMs);
    }
    poll();
  });
}
