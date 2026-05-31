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
 * cookie-extract.js — read the `ponymail` HttpOnly cookie out of the local
 * Chrome (or Chromium-family) cookie store so the user doesn't have to paste
 * it from DevTools.
 *
 * ⚠️ SECURITY WARNING — READ BEFORE ENABLING THIS PATH
 *
 * Using this auto-extract path means the PonyMail MCP server is granted, at
 * runtime, the ability to:
 *
 *   1. Read your Chrome cookie database
 *      (~/Library/Application Support/Google/Chrome/<Profile>/Cookies).
 *      That file contains session cookies for *every* site you are logged in
 *      to in Chrome, not just lists.apache.org. This module only ever queries
 *      the single row for host=lists.apache.org / name=ponymail, but the
 *      operating-system permission you grant is "read the whole file".
 *
 *   2. Access your macOS Keychain entry "Chrome Safe Storage" via
 *      `security find-generic-password`. That password is what unlocks the
 *      AES key used to decrypt cookie values. macOS may prompt you for the
 *      keychain password on first use. Once granted, the MCP process can
 *      decrypt *any* cookie value in the Chrome DB, not just the ponymail
 *      one.
 *
 * Both capabilities are far broader than what the MCP server actually needs.
 * Treat the auto-extract path as a convenience that only makes sense if the
 * MCP server is itself running under additional isolation — for example, a
 * per-tool sandbox or a hardened launcher such as Apache Magpie that
 * mediates which files and keychain items the process can touch.
 *
 * Practically, that means:
 *   - You must explicitly allow the MCP server out of any host-level sandbox
 *     that would otherwise block reads under ~/Library/Application Support/.
 *   - You must explicitly approve the keychain access prompt (or pre-grant
 *     the keychain entry to the launcher) when it appears.
 *
 * If you do not have a wrapping sandbox / security layer you trust, prefer
 * the paste-from-DevTools fallback — it limits the MCP's exposure to the
 * single cookie value you intentionally copy in.
 *
 * Firefox and Safari were evaluated but removed: modern Firefox (Bounce
 * Tracking Protection, 109+) and modern Safari (ITP) hold OAuth-derived
 * session cookies in memory only and never persist them to the on-disk
 * cookie store, so there is no file for us to read.
 *
 * No native deps — shells out to /usr/bin/sqlite3 and /usr/bin/security.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const SQLITE3 = "/usr/bin/sqlite3";
const SECURITY = "/usr/bin/security";

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Try the local Chrome (and Chromium-family) cookie store(s) for the
 * `ponymail` cookie at the given host. Returns the full "name=value"
 * cookie string ready to set as a Cookie: header, or null.
 *
 * @param {string} baseUrl - e.g. "https://lists.apache.org"
 * @returns {string|null}
 */
export function extractPonymailCookie(baseUrl) {
  const host = new URL(baseUrl).hostname;
  if (!isSafeHost(host)) {
    console.error(`[auth] refusing to query browser cookies for unsafe host: ${host}`);
    return null;
  }
  const cookieName = "ponymail";

  try {
    const value = extractFromChromiumFamily(host, cookieName);
    if (value) return `${cookieName}=${value}`;
  } catch (err) {
    console.error(`[auth] browser cookie extraction failed: ${err.message}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Defensive: the host comes from new URL().hostname, but we interpolate it
// into a SQL string, so reject anything outside DNS-name characters.
function isSafeHost(host) {
  return typeof host === "string" && /^[a-zA-Z0-9.-]+$/.test(host) && host.length < 256;
}

// SQLite cookie DBs may be locked while the browser is running. Copy to a
// temp file before querying so we never trip locks. WAL/SHM siblings also
// copied so we don't miss recently-written rows.
function copyDbForReading(src) {
  const tmp = path.join(
    os.tmpdir(),
    `ponymail-mcp-cookies-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`
  );
  fs.copyFileSync(src, tmp);
  for (const ext of ["-wal", "-shm"]) {
    const sibling = src + ext;
    if (fs.existsSync(sibling)) {
      try { fs.copyFileSync(sibling, tmp + ext); } catch {}
    }
  }
  return tmp;
}

function cleanupDb(tmp) {
  for (const p of [tmp, tmp + "-wal", tmp + "-shm"]) {
    try { fs.unlinkSync(p); } catch {}
  }
}

function runSqlite(dbPath, sql) {
  return execFileSync(SQLITE3, ["-readonly", "-bail", dbPath, sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// ---------------------------------------------------------------------------
// Chromium family
// ---------------------------------------------------------------------------

function chromiumBrowsers() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [
      { root: path.join(home, "Library/Application Support/Google/Chrome"), keychain: "Chrome" },
      { root: path.join(home, "Library/Application Support/Chromium"), keychain: "Chromium" },
      { root: path.join(home, "Library/Application Support/BraveSoftware/Brave-Browser"), keychain: "Brave" },
      { root: path.join(home, "Library/Application Support/Microsoft Edge"), keychain: "Microsoft Edge" },
      { root: path.join(home, "Library/Application Support/Vivaldi"), keychain: "Vivaldi" },
      { root: path.join(home, "Library/Application Support/Arc/User Data"), keychain: "Arc" },
      { root: path.join(home, "Library/Application Support/com.operasoftware.Opera"), keychain: "Opera" },
    ];
  }
  if (process.platform === "linux") {
    return [
      { root: path.join(home, ".config/google-chrome"), keychain: null },
      { root: path.join(home, ".config/chromium"), keychain: null },
      { root: path.join(home, ".config/BraveSoftware/Brave-Browser"), keychain: null },
      { root: path.join(home, ".config/microsoft-edge"), keychain: null },
    ];
  }
  return [];
}

function chromiumProfiles(root) {
  if (!fs.existsSync(root)) return [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .filter((e) => e.name === "Default" || /^Profile \d+$/.test(e.name))
    .map((e) => path.join(root, e.name));
}

function chromiumCookiesPath(profileDir) {
  // Newer Chromium puts the cookie DB under <profile>/Network/Cookies.
  // Older versions (and some forks) keep it directly at <profile>/Cookies.
  const candidates = [
    path.join(profileDir, "Network", "Cookies"),
    path.join(profileDir, "Cookies"),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function extractFromChromiumFamily(host, cookieName) {
  for (const browser of chromiumBrowsers()) {
    for (const profile of chromiumProfiles(browser.root)) {
      const dbPath = chromiumCookiesPath(profile);
      if (!dbPath) continue;
      const value = extractFromChromiumProfile(dbPath, browser, host, cookieName);
      if (value) {
        console.error(`[auth] found ponymail cookie in ${browser.root} (${path.basename(profile)})`);
        return value;
      }
    }
  }
  return null;
}

function extractFromChromiumProfile(dbPath, browser, host, cookieName) {
  let tmp;
  try {
    tmp = copyDbForReading(dbPath);
  } catch {
    return null;
  }
  try {
    // Cookies table columns we care about: value (plaintext, usually empty),
    // encrypted_value (BLOB). Hex-encode so we can carry binary through the
    // sqlite3 CLI's pipe-separated output.
    const sql =
      `SELECT hex(value), hex(encrypted_value) FROM cookies ` +
      `WHERE (host_key = '${host}' OR host_key = '.${host}') ` +
      `AND name = '${cookieName}' LIMIT 1;`;
    let out;
    try {
      out = runSqlite(tmp, sql).trim();
    } catch {
      return null; // table missing, file corrupt, etc.
    }
    if (!out) return null;
    const [hexVal, hexEnc] = out.split("|");
    if (hexVal && hexVal.length > 0) {
      return Buffer.from(hexVal, "hex").toString("utf8");
    }
    if (hexEnc && hexEnc.length > 0) {
      return decryptChromium(Buffer.from(hexEnc, "hex"), browser, host);
    }
    return null;
  } finally {
    cleanupDb(tmp);
  }
}

function macKeychainPassword(account) {
  try {
    return execFileSync(
      SECURITY,
      ["find-generic-password", "-w", "-s", `${account} Safe Storage`, "-a", account],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).replace(/\n$/, "");
  } catch {
    return null;
  }
}

function decryptChromium(encBuf, browser, host) {
  if (encBuf.length < 3) return null;
  const prefix = encBuf.slice(0, 3).toString("utf8");

  // v20 = App-Bound Encryption. Requires a code-signed Chromium binary to
  // unwrap, which we can't do from Node. Skip and let the user fall back.
  if (prefix === "v20") return null;

  if (prefix !== "v10" && prefix !== "v11") return null;
  const ciphertext = encBuf.slice(3);

  let password;
  if (process.platform === "darwin") {
    if (prefix !== "v10") return null;
    if (!browser.keychain) return null;
    password = macKeychainPassword(browser.keychain);
    if (!password) return null;
  } else if (process.platform === "linux") {
    // Without libsecret/kwallet bindings, we can only decrypt v10 (uses
    // the well-known "peanuts" passphrase). v11 needs the keyring secret.
    if (prefix !== "v10") return null;
    password = "peanuts";
  } else {
    return null;
  }

  const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20); // 16 ASCII spaces
  let plaintext;
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null;
  }

  // Recent Chromium (~v24-style scheme upgrade) prefixes the plaintext with
  // SHA256(host_key) as an integrity check. Strip it when present.
  if (plaintext.length >= 32) {
    const expected = crypto.createHash("sha256").update(host).digest();
    const expectedDot = crypto.createHash("sha256").update("." + host).digest();
    const head = plaintext.slice(0, 32);
    if (head.equals(expected) || head.equals(expectedDot)) {
      plaintext = plaintext.slice(32);
    }
  }

  const str = plaintext.toString("utf8");
  return str.length > 0 ? str : null;
}
