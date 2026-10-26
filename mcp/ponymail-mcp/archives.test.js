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

// Tests for archives.js. Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader, TextReader } from "@zip.js/zip.js";

import { inspectAttachment, extractZip, entryComponents } from "./archives.js";
import { pinRoots } from "./attachments.js";

// Build a ZIP in memory. `entries` is a list of [name, content, options],
// content being a string, a Buffer, or null for a directory entry.
async function makeZip(entries, options = {}) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), options);
  for (const [name, content, opts] of entries) {
    const reader =
      content === null ? null : typeof content === "string" ? new TextReader(content) : new Uint8ArrayReader(content);
    await writer.add(name, reader, opts);
  }
  return Buffer.from(await writer.close());
}

async function sandbox() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "ponymail-zip-")));
  const root = path.join(base, "allowed");
  await mkdir(root);
  return { base, root, pins: await pinRoots([root]) };
}

async function listTree(dir, prefix = "") {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listTree(path.join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

// --- inspectAttachment ----------------------------------------------------------

test("inspectAttachment tells encrypted from plain ZIPs", async () => {
  const plain = await makeZip([["a.txt", "a"]]);
  const zipcrypto = await makeZip([["a.txt", "a"]], { password: "pw", zipCrypto: true });
  const aes = await makeZip([["a.txt", "a"]], { password: "pw", encryptionStrength: 3 });
  assert.deepEqual(await inspectAttachment(plain), { kind: "zip", encrypted: false });
  assert.deepEqual(await inspectAttachment(zipcrypto), { kind: "zip", encrypted: true });
  assert.deepEqual(await inspectAttachment(aes), { kind: "zip", encrypted: true });
});

test("inspectAttachment recognizes 7z, RAR and PGP, and ignores other files", async () => {
  const sevenZ = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]);
  assert.deepEqual(await inspectAttachment(sevenZ), { kind: "7z", encrypted: null });
  assert.deepEqual(await inspectAttachment(Buffer.from("Rar!\x1a\x07\x01\x00")), { kind: "rar", encrypted: null });
  assert.deepEqual(
    await inspectAttachment(Buffer.from("-----BEGIN PGP MESSAGE-----\n\nhQEMA...")),
    { kind: "pgp", encrypted: true }
  );
  assert.deepEqual(await inspectAttachment(Buffer.from("diff --git a/x b/x")), { kind: null, encrypted: false });
  assert.deepEqual(await inspectAttachment(Buffer.alloc(0)), { kind: null, encrypted: false });
});

test("inspectAttachment reports a corrupt ZIP as unknown, not plain", async () => {
  const broken = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]);
  assert.deepEqual(await inspectAttachment(broken), { kind: "zip", encrypted: null });
});

// --- entryComponents ------------------------------------------------------------

test("entryComponents sanitizes every component and drops dot segments", () => {
  assert.deepEqual(entryComponents("src/Repro.java"), ["src", "Repro.java"]);
  assert.deepEqual(entryComponents("a/./b/../c.txt"), ["a", "b", "c.txt"]);
  assert.deepEqual(entryComponents("\\abs\\évil name.sh"), ["abs", "evil_name.sh"]);
  assert.deepEqual(entryComponents(".hidden/.env"), ["hidden", "env"]);
  assert.deepEqual(entryComponents("aux/con.txt"), ["_aux", "_con.txt"]);
  assert.deepEqual(entryComponents(""), ["entry"]);
  const deep = entryComponents("1/2/3/4/5/6/7/8/9/10/f.txt");
  assert.equal(deep.length, 8);
  assert.equal(deep[deep.length - 1], "f.txt");
});

// --- extractZip -----------------------------------------------------------------

for (const [label, options] of [
  ["ZipCrypto", { zipCrypto: true }],
  ["AES-256", { encryptionStrength: 3 }],
]) {
  test(`extractZip decrypts a ${label} archive with the password`, async () => {
    const { base, root, pins } = await sandbox();
    try {
      const zip = await makeZip(
        [
          ["poc/Repro.java", "class Repro {}"],
          ["poc/run.sh", "#!/bin/sh\necho hi\n"],
          ["README.txt", "steps"],
        ],
        { password: "infected", ...options }
      );
      const dest = path.join(root, "poc-extracted");
      const { files, skipped } = await extractZip(zip, "infected", dest, pins);
      assert.deepEqual(skipped, []);
      assert.deepEqual(files.map((f) => f.relative).sort(), ["README.txt", "poc/Repro.java", "poc/run.sh"]);
      assert.deepEqual(await listTree(dest), ["README.txt", "poc/Repro.java", "poc/run.sh"]);
      assert.equal(await readFile(path.join(dest, "poc", "Repro.java"), "utf8"), "class Repro {}");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test(`extractZip refuses a ${label} archive with a wrong or missing password`, async () => {
    const { base, root, pins } = await sandbox();
    try {
      const zip = await makeZip([["a.txt", "secret"]], { password: "infected", ...options });
      const dest = path.join(root, "x");
      await assert.rejects(extractZip(zip, "nope", dest, pins), /wrong password/);
      await assert.rejects(extractZip(zip, "", dest, pins), /encrypted/);
      await assert.rejects(extractZip(zip, undefined, dest, pins), /encrypted/);
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
}

test("extractZip also extracts a plain archive", async () => {
  const { base, root, pins } = await sandbox();
  try {
    const zip = await makeZip([["a.txt", "a"]]);
    const { files } = await extractZip(zip, "unused", path.join(root, "x"), pins);
    assert.deepEqual(files.map((f) => f.relative), ["a.txt"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("extractZip refuses an archive whose entries try to escape", async () => {
  const { base, root, pins } = await sandbox();
  try {
    for (const name of ["../evil.txt", "/etc/evil", "a/../../evil"]) {
      const zip = await makeZip([[name, "x"]], { password: "pw", zipCrypto: true });
      await assert.rejects(extractZip(zip, "pw", path.join(root, "x"), pins), /unsafe/i, name);
    }
    assert.deepEqual(await readdir(base), ["allowed"]);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("extractZip sanitizes entry names and never overwrites", async () => {
  const { base, root, pins } = await sandbox();
  try {
    const zip = await makeZip(
      [
        ["résumé.txt", "1"],
        ["dir/$(x).sh", "2"],
        [".env", "3"],
      ],
      { password: "pw", zipCrypto: true }
    );
    const dest = path.join(root, "x");
    await extractZip(zip, "pw", dest, pins);
    const again = await extractZip(zip, "pw", dest, pins);
    assert.deepEqual(again.files.map((f) => f.relative).sort(), ["dir/x_-1.sh", "env-1", "resume-1.txt"]);
    assert.deepEqual(await listTree(dest), ["dir/x_-1.sh", "dir/x_.sh", "env", "env-1", "resume-1.txt", "resume.txt"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("extractZip never creates symlink entries", async () => {
  const { base, root, pins } = await sandbox();
  try {
    const zip = await makeZip(
      [
        ["link", "/etc/passwd", { externalFileAttributes: ((0o120777 << 16) >>> 0) }],
        ["real.txt", "ok"],
      ],
      { password: "pw", zipCrypto: true }
    );
    const dest = path.join(root, "x");
    const { files, skipped } = await extractZip(zip, "pw", dest, pins);
    assert.deepEqual(files.map((f) => f.relative), ["real.txt"]);
    assert.deepEqual(skipped.map((s) => s.entry), ["link"]);
    assert.deepEqual(await listTree(dest), ["real.txt"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("extractZip writes only inside the allowed roots", async () => {
  const { base, root, pins } = await sandbox();
  try {
    const zip = await makeZip([["a.txt", "a"]], { password: "pw", zipCrypto: true });
    await assert.rejects(extractZip(zip, "pw", path.join(base, "elsewhere"), pins), /not inside/);
    assert.deepEqual(await readdir(base), ["allowed"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("extractZip stops at the entry-count and size limits", async () => {
  const { base, root, pins } = await sandbox();
  try {
    const many = await makeZip(
      Array.from({ length: 5 }, (_, i) => [`f${i}.txt`, "x"]),
      { password: "pw", zipCrypto: true }
    );
    const capped = await extractZip(many, "pw", path.join(root, "many"), pins, { maxEntries: 3 });
    assert.equal(capped.files.length, 3);
    // The rest is not even read: one summary line, not one per entry.
    assert.deepEqual(capped.skipped, [
      { entry: "(rest of the archive)", reason: "more than 3 entries; not read" },
    ]);

    const big = await makeZip([["small.txt", "x"], ["zeros.bin", Buffer.alloc(100_000)]]);
    const sized = await extractZip(big, "", path.join(root, "big"), pins, { maxBytes: 1000 });
    assert.deepEqual(sized.files.map((f) => f.relative), ["small.txt"]);
    assert.match(sized.skipped[0].reason, /exceed 1000/);

    // An encrypted entry too large to check the password on refuses the archive.
    const bigEnc = await makeZip([["zeros.bin", Buffer.alloc(100_000)]], { password: "pw", zipCrypto: true });
    await assert.rejects(extractZip(bigEnc, "pw", path.join(root, "big-enc"), pins, { maxBytes: 1000 }), /cannot check the password/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// Rewrite every uncompressed-size field of a single-entry ZIP to `size`,
// the way a decompression bomb understates what it expands to.
function forgeUncompressedSize(zip, size) {
  const b = Buffer.from(zip);
  for (let i = 0; i + 4 <= b.length; i++) {
    const sig = b.readUInt32LE(i);
    if (sig === 0x04034b50) b.writeUInt32LE(size, i + 22);
    if (sig === 0x02014b50) b.writeUInt32LE(size, i + 24);
  }
  return b;
}

test("extractZip cuts off an entry that expands past its declared size", async () => {
  const { base, root, pins } = await sandbox();
  try {
    // Unencrypted: the entry is skipped, nothing written.
    const plain = forgeUncompressedSize(await makeZip([["zeros.bin", Buffer.alloc(1_000_000)]]), 10);
    const { files, skipped } = await extractZip(plain, "", path.join(root, "plain"), pins, { maxBytes: 4096 });
    assert.deepEqual(files, []);
    assert.equal(skipped.length, 1);
    // zip.js stops the stream once it passes the declared size; the writer's
    // own cap is the backstop. Either way nothing is written.
    assert.match(skipped[0].reason, /exceeds 4096 bytes|Invalid uncompressed size/);

    // Encrypted: it is the entry the password is checked on, so the archive is refused.
    const enc = forgeUncompressedSize(
      await makeZip([["zeros.bin", Buffer.alloc(1_000_000)]], { password: "pw", zipCrypto: true }),
      10
    );
    await assert.rejects(extractZip(enc, "pw", path.join(root, "enc"), pins, { maxBytes: 4096 }), /exceeds|Invalid uncompressed size/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("extractZip counts directory entries toward the entry limit", async () => {
  const { base, root, pins } = await sandbox();
  try {
    const dirs = Array.from({ length: 10 }, (_, i) => [`d${i}/`, null, { directory: true }]);
    const zip = await makeZip([...dirs, ["last.txt", "x"]]);
    const { files, skipped } = await extractZip(zip, "", path.join(root, "x"), pins, { maxEntries: 5 });
    assert.deepEqual(files, []);
    assert.equal(skipped.length, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("inspectAttachment gives up on encryption after the entry limit", async () => {
  const many = await makeZip(Array.from({ length: 1001 }, (_, i) => [`f${i}`, "x"]));
  assert.deepEqual(await inspectAttachment(many), { kind: "zip", encrypted: null });
});

test("extractZip extracts entries with permission bits but no file type", async () => {
  const { base, root, pins } = await sandbox();
  try {
    const zip = await makeZip(
      [["plain.txt", "ok", { externalFileAttributes: ((0o600 << 16) >>> 0) }]],
      { password: "pw", zipCrypto: true }
    );
    const { files, skipped } = await extractZip(zip, "pw", path.join(root, "x"), pins);
    assert.deepEqual(files.map((f) => f.relative), ["plain.txt"]);
    assert.deepEqual(skipped, []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// Flip one byte inside the stored data of a single-entry ZIP made with
// level 0, after the local header and (for ZipCrypto) its 12-byte header.
function corruptStoredData(zip, skip) {
  const b = Buffer.from(zip);
  const nameLen = b.readUInt16LE(26);
  const extraLen = b.readUInt16LE(28);
  b[30 + nameLen + extraLen + skip] ^= 0xff;
  return b;
}

test("extractZip catches a stored entry whose data fails its checksum", async () => {
  const { base, root, pins } = await sandbox();
  try {
    const plain = corruptStoredData(await makeZip([["a.txt", "hello world"]], { level: 0 }), 0);
    const { files, skipped } = await extractZip(plain, "", path.join(root, "plain"), pins);
    assert.deepEqual(files, []);
    assert.match(skipped[0].reason, /crc32/i);

    const enc = corruptStoredData(
      await makeZip([["a.txt", "hello world"]], { level: 0, password: "pw", zipCrypto: true }),
      12
    );
    await assert.rejects(extractZip(enc, "pw", path.join(root, "enc"), pins), /checksum/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("extractZip writes nothing when a later entry name tries to escape", async () => {
  const { base, root, pins } = await sandbox();
  try {
    const zip = await makeZip([["good.txt", "ok"], ["../evil.txt", "x"]]);
    await assert.rejects(extractZip(zip, "", path.join(root, "x"), pins), /unsafe/i);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("extractZip checks the password before writing any plain entry", async () => {
  const { base, root, pins } = await sandbox();
  try {
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("plain.txt", new TextReader("not secret"));
    await writer.add("secret.txt", new TextReader("secret"), { password: "pw", zipCrypto: true });
    const zip = Buffer.from(await writer.close());
    await assert.rejects(extractZip(zip, "wrong", path.join(root, "x"), pins), /wrong password/);
    assert.deepEqual(await readdir(root), []);
    const ok = await extractZip(zip, "pw", path.join(root, "y"), pins);
    assert.deepEqual(ok.files.map((f) => f.relative).sort(), ["plain.txt", "secret.txt"]);
    assert.equal(ok.error, null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// Flip a byte in the stored data of every entry of a level-0, unencrypted ZIP.
function corruptEveryStoredEntry(zip) {
  const b = Buffer.from(zip);
  for (let i = 0; i + 30 <= b.length; i++) {
    if (b.readUInt32LE(i) !== 0x04034b50) continue;
    const dataStart = i + 30 + b.readUInt16LE(i + 26) + b.readUInt16LE(i + 28);
    b[dataStart] ^= 0xff;
    i = dataStart;
  }
  return b;
}

test("extractZip charges failed entries to the extraction budget", async () => {
  const { base, root, pins } = await sandbox();
  try {
    const entries = Array.from({ length: 5 }, (_, i) => [`e${i}.bin`, Buffer.alloc(1000, i + 1)]);
    const zip = corruptEveryStoredEntry(await makeZip(entries, { level: 0 }));
    const { files, skipped } = await extractZip(zip, "", path.join(root, "x"), pins, { maxBytes: 2500 });
    assert.deepEqual(files, []);
    // Two entries are inflated and fail their checksum; their 2000 bytes use
    // up the budget, so the other three are never inflated.
    assert.match(skipped[0].reason, /crc32/i);
    assert.match(skipped[1].reason, /crc32/i);
    for (const s of skipped.slice(2)) assert.match(s.reason, /would exceed 2500/);
    assert.equal(skipped.length, 5);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("extractZip writes the password-checked entry even at the budget boundary", async () => {
  const { base, root, pins } = await sandbox();
  try {
    // The encrypted entry alone uses the whole budget when it is checked.
    const exact = await makeZip([["secret.bin", Buffer.alloc(1000, 1)]], { password: "pw", zipCrypto: true });
    const one = await extractZip(exact, "pw", path.join(root, "exact"), pins, { maxBytes: 1000 });
    assert.deepEqual(one.files.map((f) => f.relative), ["secret.bin"]);

    // A plain entry before it uses up what the check left.
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("plain.bin", new Uint8ArrayReader(Buffer.alloc(500, 2)));
    await writer.add("secret.bin", new Uint8ArrayReader(Buffer.alloc(500, 3)), { password: "pw", zipCrypto: true });
    await writer.add("late.bin", new Uint8ArrayReader(Buffer.alloc(10, 4)));
    const mixed = Buffer.from(await writer.close());
    const two = await extractZip(mixed, "pw", path.join(root, "mixed"), pins, { maxBytes: 1000 });
    assert.deepEqual(two.files.map((f) => f.relative).sort(), ["plain.bin", "secret.bin"]);
    assert.deepEqual(two.skipped, [
      { entry: "(rest of the archive)", reason: "the 1000-byte extraction budget is used up" },
    ]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("extractZip renames a file whose sanitized name collides with a directory", async () => {
  const { base, root, pins } = await sandbox();
  try {
    for (const order of [
      [["config", "file"], [".config/repro.txt", "inner"]],
      [[".config/repro.txt", "inner"], ["config", "file"]],
    ]) {
      const dest = path.join(root, `x${order[0][0].length}`);
      const zip = await makeZip(order);
      const { files, skipped, error } = await extractZip(zip, "", dest, pins);
      assert.equal(error, null);
      assert.deepEqual(skipped, []);
      assert.deepEqual(files.map((f) => f.relative).sort(), ["config-1", "config/repro.txt"]);
      assert.equal(await readFile(path.join(dest, "config", "repro.txt"), "utf8"), "inner");
      assert.equal(await readFile(path.join(dest, "config-1"), "utf8"), "file");
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("extractZip skips an entry that clashes with a file already in place and goes on", async () => {
  const { base, root, pins } = await sandbox();
  try {
    const dest = path.join(root, "x");
    await mkdir(dest, { recursive: true });
    await writeFile(path.join(dest, "sub"), "already a file");
    const zip = await makeZip([["sub/a.txt", "a"], ["b.txt", "b"]]);
    const { files, skipped, error } = await extractZip(zip, "", dest, pins);
    assert.equal(error, null);
    assert.deepEqual(files.map((f) => f.relative), ["b.txt"]);
    assert.deepEqual(skipped.map((s) => s.entry), ["sub/a.txt"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("extractZip keeps numbered names off reserved directories", async () => {
  const { base, root, pins } = await sandbox();
  try {
    const dest = path.join(root, "x");
    const zip = await makeZip([["config", "a"], [".config", "b"], ["config-1/repro.txt", "c"]]);
    const { files, skipped, error } = await extractZip(zip, "", dest, pins);
    assert.equal(error, null);
    assert.deepEqual(skipped, []);
    assert.deepEqual(files.map((f) => f.relative).sort(), ["config", "config-1/repro.txt", "config-2"]);
    assert.equal(await readFile(path.join(dest, "config-1", "repro.txt"), "utf8"), "c");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
