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

// Helpers for save_attachments: normalizing PonyMail's attachment metadata,
// turning an untrusted attachment filename into a safe local one, and writing
// the bytes without ever leaving the target directory or overwriting a file.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import path from "node:path";

// Create-only, and never through a symlink in the final component (O_NOFOLLOW
// is missing on Windows, where O_EXCL already refuses existing links).
const CREATE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

// Attachments larger than this are skipped rather than downloaded.
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const MAX_NAME_LENGTH = 120;

// A non-negative integer size, or null when absent or unusable. (Number(null)
// and Number("") are 0, which would wrongly cap the download at zero bytes.)
function parseSize(size) {
  if (size === null || size === undefined || size === "") return null;
  const n = Number(size);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// PonyMail Foal returns `attachments` as a list of
// { hash, filename, content_type, size }; older responses keyed the same
// records by hash. Accept both and always return a list carrying the hash.
export function normalizeAttachments(attachments) {
  if (!attachments) return [];
  const entries = Array.isArray(attachments)
    ? attachments.map((att) => [att?.hash, att])
    : Object.entries(attachments);
  const result = [];
  for (const [key, att] of entries) {
    const hash = att?.hash || key;
    if (!hash || typeof hash !== "string") continue;
    result.push({
      hash,
      filename: typeof att?.filename === "string" ? att.filename : "",
      content_type: att?.content_type || "application/octet-stream",
      size: parseSize(att?.size),
    });
  }
  return result;
}

// Turn an untrusted attachment filename into one that is safe to create in a
// directory: ASCII only (accents are folded first, everything else non-ASCII
// is dropped), only [A-Za-z0-9._-], no path separators, no "..", no leading
// dot. Falls back to a name derived from the attachment hash.
export function safeFilename(name, hash = "") {
  let s = String(name ?? "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/_{2,}/g, "_")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "");

  if (s.length > MAX_NAME_LENGTH) {
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : "";
    s = s.slice(0, MAX_NAME_LENGTH - ext.length).replace(/[._-]+$/, "") + ext;
  }

  if (!s) {
    const h = String(hash).replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
    s = h ? `attachment-${h}` : "attachment";
  }
  // Windows maps these names, with any extension, to devices.
  if (WINDOWS_DEVICE.test(s.split(".")[0])) s = `_${s}`;
  return s;
}

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

// Read a fetch Response body into a Buffer, cancelling the download and
// throwing as soon as it exceeds maxBytes (an unencoded response whose
// Content-Length is over the limit is refused before reading).
export async function readLimited(resp, maxBytes) {
  const tooBig = (n) => new Error(`attachment exceeds ${maxBytes} bytes (got ${n})`);
  // With a Content-Encoding, Content-Length counts the encoded bytes while
  // the body yields decoded ones; only the streamed count applies then.
  const encoding = (resp.headers?.get?.("content-encoding") || "identity").trim().toLowerCase();
  const declared = encoding === "identity" ? Number(resp.headers?.get?.("content-length")) : NaN;
  if (Number.isFinite(declared) && declared > maxBytes) {
    await resp.body?.cancel?.().catch(() => {});
    throw tooBig(declared);
  }
  if (!resp.body) return Buffer.alloc(0);

  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooBig(`more than ${maxBytes}`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

// PonyMail names each attachment by the SHA-256 of its decoded bytes. Throw
// when a hash in that form does not match the downloaded bytes; hashes in any
// other form are not checked.
export function verifyDigest(hash, data) {
  if (!/^[0-9a-f]{64}$/i.test(hash)) return;
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== hash.toLowerCase()) {
    throw new Error(`content does not match its hash (sha256 ${actual})`);
  }
}

// Reject anything but an absolute path without "." or ".." segments.
// Returns the normalized absolute path.
function checkAbsolute(p, what) {
  if (typeof p !== "string" || !p) {
    throw new Error(`${what} must be a non-empty absolute path`);
  }
  if (!path.isAbsolute(p)) {
    throw new Error(`${what} must be an absolute path, got: ${p}`);
  }
  // UNC (\\server\share, //server/share) and device-namespace (\\?\, \\.\)
  // paths would reach the network or a device on the first lookup, before
  // any containment check could run.
  if (/^[\\/]{2}/.test(p)) {
    throw new Error(`${what} must be a local path, not a UNC or device path, got: ${p}`);
  }
  if (p.split(/[\\/]+/).some((seg) => seg === ".." || seg === ".")) {
    throw new Error(`${what} must not contain "." or ".." segments, got: ${p}`);
  }
  return path.resolve(p);
}

// The directories save_attachments may write into, from
// PONYMAIL_ATTACHMENT_DIRS (comma-separated absolute paths). Unset or empty
// means saving is disabled.
export function attachmentRoots(env = process.env) {
  return String(env.PONYMAIL_ATTACHMENT_DIRS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((root) => checkAbsolute(root, "PONYMAIL_ATTACHMENT_DIRS entry"));
}

// Resolve symlinks in the longest existing prefix of an absolute path and
// append the part that does not exist yet.
async function realpathLoose(p) {
  const missing = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(await realpath(cur), ...missing.reverse());
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      const parent = path.dirname(cur);
      if (parent === cur) throw err;
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}

function isWithin(child, root) {
  const rel = path.relative(root, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

// Pin the allowed roots once, at server start: create each (0700) if
// missing, and record its canonical path and identity. Later checks compare
// against these pins and never re-resolve the configured paths, so replacing
// a root (or a directory above it) with a symlink cannot move the allowlist.
export async function pinRoots(roots) {
  const pinned = [];
  for (const root of roots) {
    // Check the path as configured before and after creating it: a planted
    // component (`/tmp/pm` -> elsewhere) vanishes from the canonical path the
    // later checks see.
    await checkConfiguredPath(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await checkConfiguredPath(root);
    if ((await lstat(root)).isSymbolicLink()) {
      throw new Error(`attachment root must not be a symlink: ${root}`);
    }
    const real = await realpath(root);
    const st = await stat(real);
    if (!st.isDirectory()) throw new Error(`attachment root is not a directory: ${root}`);
    await checkRootTrusted(root, real, st);
    pinned.push({ configured: root, path: real, dev: st.dev, ino: st.ino });
  }
  return pinned;
}

// On POSIX, walk the configured path from the top: every component that
// exists, symlinks included, must be owned by this user or root, and no
// directory on it may be writable by group or others unless sticky. So
// /tmp -> /private/tmp (root's) passes, a /tmp/pm someone else made does not.
async function checkConfiguredPath(root) {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  const uid = process.getuid();
  let cur = path.parse(root).root;
  for (const part of ["", ...root.split(path.sep).filter(Boolean)]) {
    if (part) cur = path.join(cur, part);
    let st;
    try {
      st = await lstat(cur);
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    if (st.uid !== uid && st.uid !== 0) {
      throw new Error(`attachment root ${root} goes through ${cur}, owned by another user`);
    }
    if (st.isDirectory() && st.mode & 0o022 && !(st.mode & 0o1000)) {
      throw new Error(`attachment root ${root} goes through ${cur}, which group or others can write to`);
    }
  }
}

// On POSIX, refuse a root someone else could have planted or could change:
// it must be owned by this user and not writable by group or others, and
// every directory above it must be owned by this user or root and not
// writable by group or others unless sticky (as /tmp is). Symlinked ancestors such as
// /tmp -> /private/tmp are fine: the checks run on the canonical path.
async function checkRootTrusted(root, real, st) {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  const uid = process.getuid();
  if (st.uid !== uid) throw new Error(`attachment root is not owned by the server's user: ${root}`);
  if (st.mode & 0o022) throw new Error(`attachment root is writable by group or others: ${root}`);
  for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
    const a = await stat(dir);
    if (a.uid !== uid && a.uid !== 0) {
      throw new Error(`attachment root ${root} is below ${dir}, owned by another user`);
    }
    if (a.mode & 0o022 && !(a.mode & 0o1000)) {
      throw new Error(`attachment root ${root} is below ${dir}, which group or others can write to`);
    }
    if (dir === path.dirname(dir)) break;
  }
}

// A pinned root still resolves to itself and is still the same directory.
async function rootIntact(root) {
  try {
    if ((await realpath(root.path)) !== root.path) return false;
    const st = await stat(root.path);
    return st.dev === root.dev && st.ino === root.ino;
  } catch {
    return false;
  }
}

// Resolve the caller-supplied target directory: absolute, no "." or ".."
// segments, and (after resolving symlinks) equal to or inside one of the
// pinned roots, which must not have been replaced since they were pinned.
// Returns the normalized path, its canonical form, and the root it is in.
async function resolveTarget(dir, roots) {
  const target = checkAbsolute(dir, "dir");
  if (!roots || roots.length === 0) {
    throw new Error(
      "Saving attachments is disabled: set PONYMAIL_ATTACHMENT_DIRS to the " +
        "comma-separated absolute directories the server may write into."
    );
  }
  const real = await realpathLoose(target);
  for (const root of roots) {
    if (!isWithin(real, root.path)) continue;
    if (!(await rootIntact(root))) {
      throw new Error(
        `attachment root ${root.configured} was replaced or moved since the server started; refusing to save`
      );
    }
    return { target, real, root };
  }
  throw new Error(
    `dir is not inside an allowed attachment directory (${roots.map((r) => r.configured).join(", ")}): ${dir}`
  );
}

// Validate the target directory as resolveTarget does; returns its
// normalized absolute path.
export async function checkTargetDir(dir, roots) {
  return (await resolveTarget(dir, roots)).target;
}

// Create `dir` (0700, with parents) inside one of `roots`, checking
// containment before and after. The directory is created at the canonical
// path the check approved, never through the caller's spelling of it, so a
// symlink on that spelling cannot be re-pointed in between.
// `hooks.beforeMkdir` exists only for tests.
export async function ensureDir(dir, roots, hooks = {}) {
  const { real } = await resolveTarget(dir, roots);
  await hooks.beforeMkdir?.();
  await mkdir(real, { recursive: true, mode: 0o700 });
  await resolveTarget(dir, roots);
}

// "name.ext" -> "name-1.ext", "name-2.ext", ...
function numbered(name, n) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

// True when `dir` (a canonical path that passed resolveTarget) still
// resolves to itself, is still the directory recorded in `dirStat`, still
// lies inside the intact pinned `root`, and `target` is still the file `fh`
// has open.
async function stillInPlace(fh, dir, dirStat, root, target) {
  try {
    if ((await realpath(dir)) !== dir) return false;
    if (!isWithin(dir, root.path) || !(await rootIntact(root))) return false;
    if (!sameFile(await stat(dir), dirStat)) return false;
    return sameFile(await fh.stat(), await lstat(target));
  } catch {
    return false;
  }
}

// Write `data` as `name` inside `dir` (created 0700 if missing), which must be
// inside one of `roots`. Never overwrites: an existing file gets a numbered
// sibling instead. Files are created 0600. Returns { name, path, sha256 }.
// `hooks.beforeMkdir`, `hooks.afterResolve`, `hooks.beforeOpen` and
// `hooks.afterOpen` exist only for tests.
export async function writeAttachment(dir, name, data, roots, hooks = {}) {
  await ensureDir(dir, roots, hooks);
  // Check again now the directory exists, and from here on use only the
  // canonical path that passed the check, never a fresh resolution of `dir`.
  const { real: root, root: pin } = await resolveTarget(dir, roots);
  await hooks.afterResolve?.();
  const rootStat = await stat(root);

  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? name : numbered(name, n);
    const target = path.resolve(root, candidate);
    // Defence in depth: the sanitized name must land directly in root.
    if (path.dirname(target) !== root || path.basename(target) !== candidate) {
      throw new Error(`refusing to write outside ${root}: ${candidate}`);
    }
    await hooks.beforeOpen?.();
    let fh;
    try {
      fh = await open(target, CREATE_FLAGS, 0o600);
    } catch (err) {
      if (err.code === "EEXIST") continue;
      throw err;
    }
    try {
      await hooks.afterOpen?.();
      // Node has no openat(), so a directory on the path could be swapped for
      // a symlink between the checks above and open(). Write nothing until
      // the file is proven to be `candidate` in the directory that was
      // checked; a swap leaves at most an empty file behind.
      if (!(await stillInPlace(fh, root, rootStat, pin, target))) {
        throw new Error(
          `${root} changed while saving ${candidate}; nothing was written ` +
            "(an empty file may have been left behind)"
        );
      }
      await fh.writeFile(data);
    } finally {
      await fh.close();
    }
    return {
      name: candidate,
      path: target,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  }
  throw new Error(`too many files named like ${name} in ${root}`);
}
