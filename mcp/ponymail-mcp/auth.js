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
 * auth.js — PonyMail session management
 *
 * PonyMail Foal handles OAuth entirely server-side — the auth code from ASF OAuth
 * can only be exchanged by PonyMail's own backend (its redirect_uri is registered
 * with ASF OAuth, not ours). So we can't replicate the OAuth exchange from a CLI.
 *
 * Instead, this module:
 * 1. Opens the PonyMail login page in the user's browser
 * 2. Runs a tiny local server that waits for the user to paste their cookie
 *    OR watches for the cookie file to appear (if using browser extension)
 * 3. Caches the session cookie to ~/.ponymail-mcp/session.json
 *
 * The simplest reliable flow:
 * - Open lists.apache.org/oauth.html in the browser
 * - User logs in (ASF LDAP)
 * - After login, PonyMail sets a session cookie in the browser
 * - User copies the cookie value from DevTools (or we provide a bookmarklet)
 * - We cache it and use it for API requests
 *
 * Alternatively, set PONYMAIL_SESSION_COOKIE env var directly.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";
import { extractPonymailCookie } from "./cookie-extract.js";

const SESSION_DIR = path.join(os.homedir(), ".ponymail-mcp");
const SESSION_FILE = path.join(SESSION_DIR, "session.json");
const CALLBACK_PORT = 39817;
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

export function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    if (data.timestamp && Date.now() - data.timestamp > 20 * 60 * 60 * 1000) {
      console.error("[auth] Cached session expired");
      return null;
    }
    return data.cookie || null;
  } catch {
    return null;
  }
}

function saveSession(cookie, userInfo = {}) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(
    SESSION_FILE,
    JSON.stringify({ cookie, timestamp: Date.now(), user: userInfo }, null, 2)
  );
  console.error(`[auth] Session saved to ${SESSION_FILE}`);
}

/**
 * Pull the ponymail cookie out of whatever shape the user pasted: a full
 * `Cookie:` header line, a multi-line Request Headers block, the raw
 * `ponymail=<value>` token, or just the bare cookie value. Returns
 * "ponymail=<value>" or null if no plausible cookie was found.
 *
 * The cookie value is everything up to the next whitespace, semicolon,
 * comma, or quote — matching the cookie-octet character set loosely enough
 * to accept odd-shaped values while rejecting whatever comes after the
 * cookie. As a last resort, accept a bare RFC-4122 UUID since that's the
 * canonical shape of a PonyMail session cookie.
 */
export function extractPonymailFromPaste(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  const m = trimmed.match(/ponymail=([^\s;,'"]+)/i);
  if (m) return `ponymail=${m[1]}`;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return `ponymail=${trimmed}`;
  }
  return null;
}

/**
 * Validate a candidate cookie against PonyMail's preferences endpoint.
 * Returns { ok, user } on success, { ok: false, reason } on failure.
 */
async function validateCookie(cookie, baseUrl) {
  try {
    const url = new URL("/api/preferences.lua", baseUrl);
    const resp = await fetch(url.toString(), {
      headers: { Accept: "application/json", Cookie: cookie },
    });
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
    const data = await resp.json();
    const creds = data.login && data.login.credentials;
    if (!creds) return { ok: false, reason: "no login credentials in response" };
    return {
      ok: true,
      user: { fullname: creds.fullname || "Unknown", email: creds.email || "" },
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Try to find a valid ponymail cookie in a local browser store. On success,
 * caches it to ~/.ponymail-mcp/session.json and returns a result describing
 * which browser/user it came from. Returns null if no usable cookie was found.
 */
export async function tryBrowserExtraction(baseUrl) {
  const cookie = extractPonymailCookie(baseUrl);
  if (!cookie) return null;
  const result = await validateCookie(cookie, baseUrl);
  if (!result.ok) {
    console.error(`[auth] extracted cookie failed validation: ${result.reason}`);
    return null;
  }
  saveSession(cookie, result.user);
  return { cookie, user: result.user };
}

export function clearSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
      console.error("[auth] Session cleared");
    }
  } catch (err) {
    console.error("[auth] Failed to clear session:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Browser helper
// ---------------------------------------------------------------------------

function openBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.error("[auth] Could not open browser:", err.message);
  });
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

/**
 * Whether the user has explicitly opted in to the Chrome auto-extract path
 * by setting PONYMAIL_AUTO_EXTRACT_COOKIE=1 (or true/yes/on) in their MCP
 * server config. This path lets the MCP read the Chrome cookie DB and call
 * the macOS Keychain — see cookie-extract.js for the full security note.
 */
export function autoExtractEnabled() {
  const v = (process.env.PONYMAIL_AUTO_EXTRACT_COOKIE || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Perform login.
 *
 * Default flow (auto-extract OFF): opens a local HTTP server with a paste
 * form where the user pastes the ponymail cookie copied from DevTools.
 *
 * If PONYMAIL_AUTO_EXTRACT_COOKIE=1 is set in the environment, the function
 * FIRST tries to read the cookie out of the local Chrome (or Chromium-family)
 * cookie store via cookie-extract.js. Only falls back to the paste form if
 * the auto-extract returns nothing or doesn't validate.
 *
 * @param {string} baseUrl - PonyMail base URL
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] - Max time to wait for paste flow (default 3 min)
 * @returns {Promise<{cookie: string, source: "browser"|"paste", user?: {fullname: string, email: string}}>}
 */
export async function performLogin(baseUrl, opts = {}) {
  const { timeoutMs = LOGIN_TIMEOUT_MS } = opts;

  if (autoExtractEnabled()) {
    const extracted = await tryBrowserExtraction(baseUrl);
    if (extracted) {
      return { cookie: extracted.cookie, source: "browser", user: extracted.user };
    }
    console.error("[auth] no ponymail cookie found in local Chrome — falling back to paste flow");
  }

  return new Promise((resolve, reject) => {
    let server;
    let settled = false;

    function settle(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (server) {
        try { server.close(); } catch {}
      }
      if (err) reject(err);
      else resolve(result);
    }

    const timer = setTimeout(() => {
      settle(new Error(
        `Login timed out after ${timeoutMs / 1000}s. Call login again to retry.`
      ));
    }, timeoutMs);

    server = http.createServer(async (req, res) => {
      // Serve the cookie-paste form
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(loginPage(baseUrl));
        return;
      }

      // Live preview/validation — called from the login page as the user
      // types. Returns JSON so the page can show "✅ would log in as ..."
      // before they commit to Submit. Does NOT save the cookie.
      if (req.method === "POST" && req.url === "/preview") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const params = new URLSearchParams(body);
        const raw = params.get("cookie") || "";
        const extracted = extractPonymailFromPaste(raw);
        res.writeHead(200, { "Content-Type": "application/json" });
        if (!extracted) {
          res.end(JSON.stringify({
            extracted: null,
            valid: false,
            reason: "no ponymail token detected",
          }));
          return;
        }
        const result = await validateCookie(extracted, baseUrl);
        res.end(JSON.stringify({
          extracted,
          valid: result.ok,
          user: result.ok ? result.user : undefined,
          reason: result.ok ? undefined : result.reason,
        }));
        return;
      }

      // Receive the pasted cookie
      if (req.method === "POST" && req.url === "/save") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const params = new URLSearchParams(body);
        const raw = params.get("cookie") || "";
        const cookie = extractPonymailFromPaste(raw);

        if (!cookie) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(resultPage(false,
            "Couldn't find a ponymail cookie in what you pasted. " +
            "Try copying the entire <code>Cookie:</code> header line from DevTools."
          ));
          return;
        }

        const result = await validateCookie(cookie, baseUrl);
        if (result.ok) {
          saveSession(cookie, result.user);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(resultPage(true, `Authenticated as ${result.user.fullname} (${result.user.email})`));
          settle(null, { cookie, source: "paste", user: result.user });
        } else {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(resultPage(false,
            `Cookie validation failed: ${result.reason}. ` +
            "Make sure you copied the full cookie string and that you are logged in. Try again."
          ));
        }
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.on("error", (err) => {
      settle(new Error(`Could not start callback server on port ${CALLBACK_PORT}: ${err.message}`));
    });

    server.listen(CALLBACK_PORT, () => {
      // Open the local helper page (which has a link to PonyMail login + paste form)
      const helperUrl = `http://localhost:${CALLBACK_PORT}`;
      console.error(`[auth] Opening login helper at ${helperUrl}`);
      openBrowser(helperUrl);
    });
  });
}

// ---------------------------------------------------------------------------
// HTML pages
// ---------------------------------------------------------------------------

export function loginPage(baseUrl) {
  const oauthUrl = `${baseUrl}/oauth.html`;
  const hostname = new URL(baseUrl).hostname;
  const autoOn = autoExtractEnabled();
  return `<!DOCTYPE html>
<html>
<head>
  <title>PonyMail MCP — Authenticate</title>
  <meta charset="utf-8">
  <style>
    :root { color-scheme: light dark; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      max-width: 720px; margin: 32px auto; padding: 0 20px; color: #222;
      line-height: 1.5; }
    h1 { margin: 0 0 8px 0; font-size: 1.6em; }
    .sub { color: #666; margin: 0 0 28px 0; }
    .step { display: flex; gap: 16px; margin: 22px 0; }
    .step-num { flex: 0 0 32px; height: 32px; border-radius: 50%;
      background: #0066cc; color: white; display: flex; align-items: center;
      justify-content: center; font-weight: 600; font-size: 0.95em; }
    .step-body { flex: 1; min-width: 0; }
    .step-body h2 { margin: 4px 0 6px; font-size: 1.05em; }
    .step-body ol, .step-body p { margin: 6px 0; }
    .hint { background: #fff8e1; border-left: 3px solid #f0b400; padding: 8px 12px;
      border-radius: 4px; font-size: 0.9em; color: #5a4500; }
    .hint code { background: rgba(0,0,0,0.06); }
    .warning { background: #ffebee; border-left: 3px solid #b71c1c; padding: 10px 14px;
      border-radius: 4px; font-size: 0.92em; color: #7a1414; margin: 8px 0; }
    .warning strong { color: #b71c1c; }
    .warning code { background: rgba(0,0,0,0.06); }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px;
      font-size: 0.78em; font-weight: 600; margin-left: 8px; vertical-align: 1px; }
    .badge.on { background: #b71c1c; color: white; }
    .badge.off { background: #888; color: white; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: #f3f3f3; padding: 1px 5px; border-radius: 3px; font-size: 0.9em; }
    pre { padding: 10px 12px; overflow-x: auto; white-space: pre-wrap;
      word-break: break-all; }
    textarea { width: 100%; min-height: 84px; padding: 10px 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.9em; border: 2px solid #ccc; border-radius: 6px;
      box-sizing: border-box; resize: vertical; background: white; color: #222; }
    textarea:focus { outline: none; border-color: #0066cc; }
    button { padding: 11px 24px; font-size: 1em; background: #0066cc;
      color: white; border: none; border-radius: 6px; cursor: pointer;
      font-weight: 500; margin-top: 12px; }
    button:disabled { background: #b0b0b0; cursor: not-allowed; }
    button:hover:not(:disabled) { background: #0055aa; }
    .preview { margin: 10px 0 0 0; padding: 10px 14px; border-radius: 6px;
      font-size: 0.92em; min-height: 1.4em; }
    .preview.empty { background: #f3f3f3; color: #888; }
    .preview.checking { background: #fff8e1; color: #6d4c00; }
    .preview.valid { background: #e8f5e9; color: #1b5e20; }
    .preview.invalid { background: #ffebee; color: #b71c1c; }
    .preview code { background: rgba(0,0,0,0.06); }
    details { margin: 22px 0 0 0; color: #555; }
    details > summary { cursor: pointer; font-weight: 500; padding: 4px 0; }
    details > summary:hover { color: #0066cc; }
    a.openlink { display: inline-block; padding: 6px 12px; background: #f0f7ff;
      border: 1px solid #0066cc; color: #0066cc; border-radius: 4px;
      text-decoration: none; font-weight: 500; font-size: 0.95em; }
    a.openlink:hover { background: #0066cc; color: white; }
    .footnote { color: #888; margin-top: 32px; font-size: 0.85em; }
    @media (prefers-color-scheme: dark) {
      body { color: #ddd; background: #1a1a1a; }
      .sub, .footnote, details { color: #999; }
      code, pre { background: #2a2a2a; }
      textarea { background: #1f1f1f; color: #ddd; border-color: #444; }
      .preview.empty { background: #2a2a2a; color: #999; }
      .preview.checking { background: #3a2f1c; color: #ffd699; }
      .preview.valid { background: #1f3a25; color: #a7e0b2; }
      .preview.invalid { background: #3a1f22; color: #ff9ea1; }
      .hint { background: #3a2f1c; border-left-color: #b88600; color: #ffd699; }
      .warning { background: #3a1f22; border-left-color: #ff5a5f; color: #ffb3b6; }
      .warning strong { color: #ff8a8e; }
      a.openlink { background: #0d2840; }
    }
  </style>
</head>
<body>
  <h1>🐴 PonyMail MCP — Authenticate</h1>
  <p class="sub">Three short steps. Most of it is copy-paste; we figure out the rest.</p>

  <div class="step">
    <div class="step-num">1</div>
    <div class="step-body">
      <h2>Log in to ${hostname}</h2>
      <p>Skip if you're already logged in there.</p>
      <a class="openlink" href="${oauthUrl}" target="_blank">Open ${hostname} →</a>
    </div>
  </div>

  <div class="step">
    <div class="step-num">2</div>
    <div class="step-body">
      <h2>Grab the cookie from DevTools</h2>
      <p>On <code>${hostname}</code>, open DevTools (<code>Cmd+Opt+I</code> / <code>F12</code>) → <strong>Network</strong> tab → reload the page so requests show up.</p>
      <p>Then:</p>
      <ol>
        <li>In the Network filter box, type <code>preferences.lua</code>.</li>
        <li>Click the matching row (there should be exactly one).</li>
        <li><strong>Headers</strong> → <strong>Request Headers</strong> → copy the entire <code>Cookie:</code> line.</li>
      </ol>
      <p class="hint"><strong>Why <code>preferences.lua</code> specifically?</strong> Not every request that goes to <code>${hostname}</code> carries cookies — analytics (Matomo and friends), tracking pixels, and many static-asset fetches are deliberately sent without credentials, so their <code>Cookie:</code> header is empty or missing. <code>preferences.lua</code> is an authenticated API call that PonyMail makes on every page load, so it's guaranteed to have the <code>ponymail=</code> token in its <code>Cookie:</code> line.</p>
      <p>(You don't need to pick out just the <code>ponymail=…</code> part — paste the whole <code>Cookie:</code> line and we'll extract it.)</p>
    </div>
  </div>

  <div class="step">
    <div class="step-num">3</div>
    <div class="step-body">
      <h2>Paste here</h2>
      <textarea id="paste" autofocus
        placeholder="Paste the Cookie: header line (or the bare ponymail=… value, or just the UUID)…"></textarea>
      <div id="preview" class="preview empty">Waiting for input…</div>
      <button id="submit" disabled>Authenticate</button>
    </div>
  </div>

  <details>
    <summary>💡 Quick check: am I logged in?</summary>
    <p>Open <a href="${baseUrl}/api/preferences.lua" target="_blank"><code>${baseUrl}/api/preferences.lua</code></a> in a new tab on <code>${hostname}</code>.</p>
    <ul>
      <li>If the JSON shows <code>"credentials": { "fullname": "…", "email": "…" }</code>, you're logged in.</li>
      <li>If <code>"login"</code> is empty (<code>{}</code>) or only lists OAuth providers, you're not — go back to step 1.</li>
    </ul>
    <p>Bonus: opening that URL also fires the exact <code>preferences.lua</code> request you'll filter for in step 2, so it'll be sitting in your Network tab waiting to be clicked.</p>
  </details>

  <details>
    <summary>💡 Alternative: set the cookie as an env var</summary>
    <p>Skip this whole flow by adding to your MCP server config:</p>
    <pre>"env": { "PONYMAIL_SESSION_COOKIE": "ponymail=…" }</pre>
  </details>

  <details>
    <summary>⚙️ Advanced: skip the paste with Chrome auto-extract
      <span class="badge ${autoOn ? "on" : "off"}">${autoOn ? "ENABLED" : "DISABLED"}</span>
    </summary>
    <p>If your locally-running PonyMail MCP server (the Node process on this machine that's serving this page on <code>localhost:${CALLBACK_PORT}</code>, not the PonyMail server at <code>${hostname}</code>) is started with the env var:</p>
    <pre>"env": { "PONYMAIL_AUTO_EXTRACT_COOKIE": "1" }</pre>
    <p>…then on <code>login</code> your local MCP server will <strong>first</strong> try to read the <code>ponymail</code> cookie directly from your local Chrome (or Chromium-family) cookie store, decrypting it via the macOS Keychain. If that succeeds, the paste form is skipped entirely. Otherwise you fall back to the paste form you're looking at now.</p>
    ${autoOn
      ? `<div class="hint"><strong>Status:</strong> auto-extract is currently <strong>enabled</strong> on your local MCP server. The fact that you're seeing the paste form means the Chrome lookup didn't find a valid <code>ponymail</code> cookie — either you're not logged in to <code>${hostname}</code> in Chrome, or decryption failed (e.g. Chrome ≥ 127 App-Bound Encryption <code>v20</code>).</div>`
      : `<div class="hint"><strong>Status:</strong> auto-extract is currently <strong>disabled</strong> on your local MCP server. Set the env var above in your MCP client config and restart the local MCP server to enable it — but read the warning first.</div>`
    }
    <div class="warning">
      <strong>⚠️ Only enable this if your local MCP server is running under additional sandboxing / a hardened launcher (e.g. Apache Magpie).</strong>
      <p style="margin:6px 0">When enabled, the local MCP server (the Node process on this machine) is granted, at runtime, the ability to:</p>
      <ol style="margin:6px 0 6px 20px">
        <li><strong>Read your entire Chrome cookie database.</strong> The DB at <code>~/Library/Application&nbsp;Support/Google/Chrome/&lt;Profile&gt;/Cookies</code> contains session cookies for <em>every</em> site you're logged in to in Chrome — not just <code>${hostname}</code>. The code only queries the single <code>ponymail</code> row, but the OS-level read permission you grant covers the whole file.</li>
        <li><strong>Access your macOS Keychain entry "Chrome Safe Storage."</strong> That password decrypts the AES key for cookie values. macOS may prompt you to approve it once; from then on the local MCP process can decrypt <em>any</em> cookie value in the Chrome DB.</li>
      </ol>
      <p style="margin:6px 0">Both capabilities are far broader than the MCP needs. On a bare install with no additional protection layer, <strong>leave the env var unset</strong> and use the paste form on this page.</p>
    </div>
    <p style="font-size:.9em;color:#777;margin-top:8px">Firefox and Safari were evaluated and removed: modern Firefox (Bounce Tracking Protection, 109+) and modern Safari (ITP) hold OAuth-derived session cookies in memory only and never persist them to the on-disk cookie store, so there is no file for the extractor to read.</p>
  </details>

  <p class="footnote">
    On success, the session is cached at <code>~/.ponymail-mcp/session.json</code> and this tab closes automatically. Session expires after ~20 hours.
  </p>

<script>
(function () {
  const paste = document.getElementById('paste');
  const preview = document.getElementById('preview');
  const submit = document.getElementById('submit');
  let pendingExtracted = null;
  let lastCheckedExtracted = null;
  let debounceTimer = null;

  function clientExtract(text) {
    const t = (text || '').trim();
    if (!t) return null;
    const m = t.match(/ponymail=([^\\s;,'"]+)/i);
    if (m) return 'ponymail=' + m[1];
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) {
      return 'ponymail=' + t;
    }
    return null;
  }

  function setPreview(state, html) {
    preview.className = 'preview ' + state;
    preview.innerHTML = html;
  }

  async function check(extracted) {
    lastCheckedExtracted = extracted;
    try {
      const body = new URLSearchParams({ cookie: extracted });
      const r = await fetch('/preview', { method: 'POST', body });
      // Stale response — user kept typing.
      if (lastCheckedExtracted !== extracted) return;
      const j = await r.json();
      if (j.valid && j.user) {
        const email = j.user.email ? ' (' + j.user.email + ')' : '';
        setPreview('valid',
          '✅ Valid — would log in as <strong>' + escapeHtml(j.user.fullname) + '</strong>' +
          escapeHtml(email) + '.<br><span style="opacity:.7;font-size:.85em">' +
          escapeHtml(j.extracted) + '</span>');
        submit.disabled = false;
      } else {
        setPreview('invalid',
          '❌ PonyMail did not accept this cookie: ' + escapeHtml(j.reason || 'unknown reason') +
          '. Make sure you are actually logged in to <code>${hostname}</code> and that you copied the right line.');
        submit.disabled = true;
      }
    } catch (e) {
      setPreview('invalid', 'Could not contact local server: ' + escapeHtml(e.message));
      submit.disabled = true;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }

  paste.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const extracted = clientExtract(paste.value);
    if (!extracted) {
      submit.disabled = true;
      if (paste.value.trim()) {
        setPreview('invalid',
          '❌ No <code>ponymail=…</code> token found in what you pasted. ' +
          'Try the entire <code>Cookie:</code> header line from DevTools.');
      } else {
        setPreview('empty', 'Waiting for input…');
      }
      pendingExtracted = null;
      return;
    }
    if (extracted === pendingExtracted) return;
    pendingExtracted = extracted;
    submit.disabled = true;
    setPreview('checking',
      '🔎 Detected <code>' + escapeHtml(extracted) + '</code> — checking with PonyMail…');
    debounceTimer = setTimeout(() => check(extracted), 350);
  });

  submit.addEventListener('click', () => {
    if (submit.disabled) return;
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/save';
    const inp = document.createElement('input');
    inp.type = 'hidden';
    inp.name = 'cookie';
    inp.value = paste.value;
    form.appendChild(inp);
    document.body.appendChild(form);
    form.submit();
  });
})();
</script>
</body>
</html>`;
}

function resultPage(success, message) {
  const icon = success ? "✅" : "❌";
  const color = success ? "#1b5e20" : "#b71c1c";
  const bg = success ? "#e8f5e9" : "#ffebee";
  const autoClose = success
    ? `<script>setTimeout(() => { document.title = "Done"; try { window.close(); } catch (e) {} }, 2000);</script>`
    : "";
  const action = success
    ? `<p style="margin-top:24px">You can close this tab — the MCP server is now authenticated.</p>
       <button onclick="window.close()" style="margin-top:8px;padding:10px 22px;background:#0066cc;color:white;border:none;border-radius:6px;font-size:1em;cursor:pointer">Close tab</button>`
    : `<p style="margin-top:24px"><a href="/" style="color:#0066cc;text-decoration:none;font-weight:500">← Try again</a></p>`;
  return `<!DOCTYPE html>
<html>
<head>
  <title>PonyMail MCP — ${success ? "Authenticated" : "Authentication error"}</title>
  <meta charset="utf-8">
  <style>
    :root { color-scheme: light dark; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      max-width: 640px; margin: 80px auto; padding: 0 20px; text-align: center; color: #222; }
    .card { background: ${bg}; border-radius: 12px; padding: 28px 24px; }
    h1 { margin: 0 0 4px 0; color: ${color}; font-size: 1.4em; }
    p { margin: 8px 0; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: rgba(0,0,0,0.06); padding: 1px 5px; border-radius: 3px; }
    @media (prefers-color-scheme: dark) { body { color: #ddd; background: #1a1a1a; } }
  </style>
</head>
<body>
  <div class="card">
    <h1>${icon} ${message}</h1>
    ${action}
  </div>
  ${autoClose}
</body>
</html>`;
}
