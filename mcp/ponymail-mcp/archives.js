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

// Archive handling for save_attachments: recognizing encrypted attachments
// and extracting password-protected ZIP archives (ZipCrypto or AES) through
// the same guarded writer as the attachments themselves. Security reports
// often ship their proof of concept in an encrypted ZIP, with the password in
// the message text, so mail filters do not strip or trigger on it.

import path from "node:path";
import { ZipReader, Uint8ArrayReader, Writer, configure } from "@zip.js/zip.js";

import { checkTargetDir, ensureDir, safeFilename, writeAttachment } from "./attachments.js";

configure({ useWebWorkers: false });

// Extraction limits, against archives that expand far beyond their size.
// The entry limit counts every entry read from the central directory
// (directories and skipped entries included), so an archive of a huge
// number of tiny entries is cut off before it is all held in memory.
export const MAX_EXTRACT_ENTRIES = 1000;
export const MAX_EXTRACT_BYTES = 200 * 1024 * 1024;
const MAX_DEPTH = 8;

const S_IFMT = 0o170000;
// The writer's refusals that mean the target moved or is not allowed.
const CONTAINMENT_ERROR = /changed while saving|replaced or moved|not inside|outside|disabled/;
const S_IFREG = 0o100000;

// Recognize the archive and encrypted-container formats reports arrive in.
// Returns { kind, encrypted } where encrypted is true, false, or null
// (unknown: the format can hide that, e.g. 7z with plain headers).
export async function inspectAttachment(bytes) {
  const b = Buffer.from(bytes);
  if (b.length >= 4 && b.readUInt32LE(0) === 0x04034b50) {
    try {
      const reader = new ZipReader(new Uint8ArrayReader(b));
      try {
        let seen = 0;
        for await (const entry of reader.getEntriesGenerator()) {
          if (entry.encrypted) return { kind: "zip", encrypted: true };
          // Too many entries to tell without reading them all.
          if (++seen >= MAX_EXTRACT_ENTRIES) return { kind: "zip", encrypted: null };
        }
        return { kind: "zip", encrypted: false };
      } finally {
        await reader.close();
      }
    } catch {
      return { kind: "zip", encrypted: null };
    }
  }
  if (b.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) {
    return { kind: "7z", encrypted: null };
  }
  if (b.subarray(0, 4).toString("latin1") === "Rar!") return { kind: "rar", encrypted: null };
  if (b.subarray(0, 64).toString("latin1").includes("-----BEGIN PGP MESSAGE-----")) {
    return { kind: "pgp", encrypted: true };
  }
  return { kind: null, encrypted: false };
}

// A zip.js Writer that keeps the entry in memory and fails as soon as it
// grows past `limit`, so an entry that lies about its size is cut off while
// it is being inflated rather than after.
class LimitedWriter extends Writer {
  constructor(limit) {
    super();
    this.limit = limit;
    this.chunks = [];
    this.total = 0;
  }

  writeUint8Array(array) {
    this.total += array.length;
    if (this.total > this.limit) {
      throw new Error(`extracted data exceeds ${this.limit} bytes`);
    }
    this.chunks.push(Buffer.from(array));
  }

  getData() {
    return Buffer.concat(this.chunks, this.total);
  }
}

// The safe relative directory components for an archive entry's name: each
// component reduced like an attachment filename, empty and dot components
// dropped, and nesting past MAX_DEPTH flattened into the last directory.
export function entryComponents(filename) {
  const parts = String(filename)
    .split(/[\\/]+/)
    .filter((p) => p && p !== "." && p !== "..")
    .map((p) => safeFilename(p));
  if (parts.length === 0) return ["entry"];
  const file = parts.pop();
  return [...parts.slice(0, MAX_DEPTH - 1), file];
}

// True for an entry whose Unix mode names a file type other than a regular
// file (a symlink, device, FIFO, ...). No type bits at all, as written by
// Windows tools or with permission bits only, means a regular file.
function isSymlinkOrSpecial(entry) {
  const type = ((entry.externalFileAttributes ?? 0) >>> 16) & S_IFMT;
  return type !== 0 && type !== S_IFREG;
}

// Extract a ZIP archive into `destDir` (inside one of `roots`), decrypting
// with `password` when given. Directory entries are implied; symlinks and
// other special entries are skipped, never created.
//
// Everything that can reject the whole archive happens before the first
// write: reading the (bounded) entry list, where zip.js refuses entry names
// that try to escape, and decrypting the first encrypted entry in full, which
// proves the password (a ZipCrypto password can pass its one-byte check and
// still be wrong; the CRC-32 check catches that). Those failures throw.
// A failure after files were written stops the extraction and is returned as
// `error` alongside the files already saved.
//
// Every inflated byte counts against maxBytes, including those of entries that
// then fail, and extraction stops once it is used up.
//
// Returns { files: [{ entry, relative, path, size, sha256 }],
// skipped: [{ entry, reason }], error }, where `relative` is the file's path
// below destDir and `error` is null when the extraction ran to the end.
export async function extractZip(bytes, password, destDir, roots, limits = {}) {
  const maxEntries = limits.maxEntries ?? MAX_EXTRACT_ENTRIES;
  const maxBytes = limits.maxBytes ?? MAX_EXTRACT_BYTES;
  const reader = new ZipReader(new Uint8ArrayReader(Buffer.from(bytes)), {
    password: password || undefined,
    // Off by default in zip.js; without it a wrong ZipCrypto password that
    // passes the one-byte check yields garbage of the right length.
    checkCrc32: true,
  });
  const files = [];
  const skipped = [];
  let error = null;
  let budget = maxBytes;
  let exhausted = false;

  // Inflate one entry into memory, charging it to the budget whether or not
  // it succeeds. A failed entry is charged its declared size: zip.js stops
  // inflating an entry at that size, and with CRC checking it may hold the
  // data back from the writer, so the writer's count can read low.
  const inflate = async (entry) => {
    const writer = new LimitedWriter(budget);
    try {
      const data = await entry.getData(writer);
      budget -= data.length;
      return data;
    } catch (err) {
      budget -= Math.max(writer.total, entry.uncompressedSize || 0);
      throw err;
    }
  };

  await checkTargetDir(destDir, roots);
  try {
    const entries = [];
    let truncated = false;
    for await (const entry of reader.getEntriesGenerator()) {
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
    const wanted = entries.filter((e) => !e.directory && !isSymlinkOrSpecial(e));

    // Sanitizing can map a file and a directory to the same path (`config`
    // and `.config/x`). Collect every directory path now and create them
    // below before any file, so a file that would take one (under its own
    // name or a numbered one) hits it and moves on to the next number.
    const planned = new Map();
    const dirs = new Set();
    for (const entry of wanted) {
      const parts = entryComponents(entry.filename);
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      planned.set(entry, parts);
    }

    const verified = new Map();
    const firstEncrypted = wanted.find((e) => e.encrypted);
    if (firstEncrypted) {
      if (!password) throw new Error("the archive is encrypted: pass the password given in the report");
      if (firstEncrypted.uncompressedSize > budget) {
        throw new Error(`cannot check the password: the first encrypted entry exceeds ${maxBytes} bytes`);
      }
      try {
        verified.set(firstEncrypted, await inflate(firstEncrypted));
      } catch (err) {
        if (/invalid password/i.test(err.message)) throw new Error("wrong password for the archive");
        if (/crc32/i.test(err.message)) {
          throw new Error("wrong password for the archive (decrypted data fails its checksum)");
        }
        throw err;
      }
    }

    for (const dir of [...dirs].sort()) {
      try {
        await ensureDir(path.join(destDir, ...dir.split("/")), roots);
      } catch (err) {
        if (CONTAINMENT_ERROR.test(err.message)) throw err;
        // Blocked by a file already in destDir: entries below it are skipped.
      }
    }

    for (const entry of entries) {
      if (entry.directory) continue;
      if (isSymlinkOrSpecial(entry)) {
        skipped.push({ entry: entry.filename, reason: "symlink or special file, not created" });
        continue;
      }
      // The entry the password was proven on is already inflated and paid
      // for: write it whatever the budget says now.
      let data = verified.get(entry);
      if (!data) {
        if (budget <= 0) {
          if (!exhausted) {
            skipped.push({ entry: "(rest of the archive)", reason: `the ${maxBytes}-byte extraction budget is used up` });
            exhausted = true;
          }
          continue;
        }
        if (entry.uncompressedSize > budget) {
          skipped.push({ entry: entry.filename, reason: `would exceed ${maxBytes} extracted bytes` });
          continue;
        }
        try {
          data = await inflate(entry);
        } catch (err) {
          skipped.push({ entry: entry.filename, reason: err.message });
          continue;
        }
      }
      try {
        const parts = planned.get(entry);
        const dir = path.join(destDir, ...parts.slice(0, -1));
        const saved = await writeAttachment(dir, parts[parts.length - 1], data, roots);
        files.push({
          entry: entry.filename,
          relative: [...parts.slice(0, -1), saved.name].join("/"),
          path: saved.path,
          size: data.length,
          sha256: saved.sha256,
        });
      } catch (err) {
        // A containment failure stops everything; anything else (an odd name
        // clash with files already in destDir, say) costs only this entry.
        if (CONTAINMENT_ERROR.test(err.message)) {
          error = err.message;
          break;
        }
        skipped.push({ entry: entry.filename, reason: err.message });
      }
    }
    if (truncated) {
      skipped.push({ entry: "(rest of the archive)", reason: `more than ${maxEntries} entries; not read` });
    }
  } finally {
    await reader.close();
  }
  return { files, skipped, error };
}
