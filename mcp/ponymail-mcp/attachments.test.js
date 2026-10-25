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

// Tests for attachments.js. Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  attachmentRoots,
  normalizeAttachments,
  pinRoots,
  readLimited,
  safeFilename,
  checkTargetDir,
  verifyDigest,
  writeAttachment,
} from "./attachments.js";

// --- normalizeAttachments -----------------------------------------------------

test("normalizeAttachments reads Foal's list shape", () => {
  const atts = normalizeAttachments([
    { hash: "h1", filename: "a.patch", content_type: "text/x-diff", size: 12 },
    { filename: "no hash, skipped" },
  ]);
  assert.deepEqual(atts, [{ hash: "h1", filename: "a.patch", content_type: "text/x-diff", size: 12 }]);
});

test("normalizeAttachments reads the keyed-by-hash shape", () => {
  const atts = normalizeAttachments({ h2: { filename: "b.zip", size: "7" } });
  assert.deepEqual(atts, [{ hash: "h2", filename: "b.zip", content_type: "application/octet-stream", size: 7 }]);
});

test("normalizeAttachments keeps an unknown size unknown, not zero", () => {
  for (const size of [null, undefined, "", "abc", -1, 1.5]) {
    const [att] = normalizeAttachments([{ hash: "h", size }]);
    assert.equal(att.size, null, String(size));
  }
  assert.equal(normalizeAttachments([{ hash: "h", size: 0 }])[0].size, 0);
  assert.equal(normalizeAttachments([{ hash: "h", size: "42" }])[0].size, 42);
});

test("normalizeAttachments tolerates missing or empty input", () => {
  assert.deepEqual(normalizeAttachments(undefined), []);
  assert.deepEqual(normalizeAttachments([]), []);
  assert.deepEqual(normalizeAttachments({}), []);
});

// --- safeFilename ---------------------------------------------------------------

test("safeFilename keeps ordinary names", () => {
  assert.equal(safeFilename("Repro.java"), "Repro.java");
  assert.equal(safeFilename("fix-1.2_final.patch"), "fix-1.2_final.patch");
});

test("safeFilename drops non-ASCII, folding accents first", () => {
  assert.equal(safeFilename("résumé.pdf"), "resume.pdf");
  assert.equal(safeFilename("日本語.txt"), "txt");
  assert.equal(safeFilename("poc‮gnp.exe"), "pocgnp.exe");
  assert.equal(safeFilename("a​b.txt"), "ab.txt");
});

test("safeFilename removes path components and traversal", () => {
  for (const evil of ["../../etc/passwd", "..\\..\\x.txt", "/abs/path.sh", "a/../b", "..", ".", "...."]) {
    const s = safeFilename(evil, "deadbeef");
    assert.doesNotMatch(s, /[\\/]/, evil);
    assert.doesNotMatch(s, /\.\./, evil);
    assert.doesNotMatch(s, /^\./, evil);
  }
  assert.equal(safeFilename("../../etc/passwd"), "etc_passwd");
  assert.equal(safeFilename("a/../b"), "a_._b");
});

test("safeFilename strips leading dots, control chars and shell metacharacters", () => {
  assert.equal(safeFilename(".bashrc"), "bashrc");
  assert.equal(safeFilename("x\n\r\t.txt"), "x_.txt");
  assert.equal(safeFilename("$(rm -rf ~).sh"), "rm_-rf_.sh");
  assert.match(safeFilename("a b;c|d`e'.txt"), /^[A-Za-z0-9._-]+$/);
});

test("safeFilename falls back to the hash when nothing usable is left", () => {
  assert.equal(safeFilename("", "abc123/../x"), "attachment-abc123x");
  assert.equal(safeFilename("日本語", "f00"), "attachment-f00");
  assert.equal(safeFilename(undefined), "attachment");
});

test("safeFilename defuses Windows device names", () => {
  for (const name of ["CON", "nul.txt", "Com1.zip", "LPT9.tar.gz", "aux", "prn.", "COM¹.txt"]) {
    assert.match(safeFilename(name), /^_/, name);
  }
  assert.equal(safeFilename("nul.txt"), "_nul.txt");
  assert.equal(safeFilename("console.log"), "console.log");
  assert.equal(safeFilename("nulls.txt"), "nulls.txt");
});

test("safeFilename caps the length and keeps a short extension", () => {
  const s = safeFilename("a".repeat(500) + ".patch");
  assert.ok(s.length <= 120);
  assert.ok(s.endsWith(".patch"));
});

// --- verifyDigest ---------------------------------------------------------------

test("verifyDigest checks SHA-256 hashes and ignores other forms", () => {
  const one = "7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed";
  verifyDigest(one, Buffer.from("one"));
  verifyDigest(one.toUpperCase(), Buffer.from("one"));
  assert.throws(() => verifyDigest(one, Buffer.from("two")), /does not match/);
  verifyDigest("not-a-sha256", Buffer.from("anything"));
});

// --- attachmentRoots ------------------------------------------------------------

test("attachmentRoots is empty (saving disabled) unless configured", () => {
  assert.deepEqual(attachmentRoots({}), []);
  assert.deepEqual(attachmentRoots({ PONYMAIL_ATTACHMENT_DIRS: " , " }), []);
  assert.deepEqual(
    attachmentRoots({ PONYMAIL_ATTACHMENT_DIRS: "/a/b, /c/" }),
    [path.resolve("/a/b"), path.resolve("/c")]
  );
});

test("attachmentRoots rejects relative or dotted entries", () => {
  assert.throws(() => attachmentRoots({ PONYMAIL_ATTACHMENT_DIRS: "rel/dir" }), /absolute/);
  assert.throws(() => attachmentRoots({ PONYMAIL_ATTACHMENT_DIRS: "/a/../b" }), /segments/);
});

// --- checkTargetDir -------------------------------------------------------------

// A fresh temp dir with an allowed root inside it, and a sibling outside it.
async function sandbox() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "ponymail-att-")));
  const root = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  return { base, root, outside, pins: await pinRoots([root]) };
}

test("checkTargetDir is disabled without roots", async () => {
  await assert.rejects(checkTargetDir("/tmp/x", []), /disabled/);
  await assert.rejects(checkTargetDir("/tmp/x", undefined), /disabled/);
});

test("checkTargetDir rejects UNC and device paths before any lookup", async () => {
  // The roots are bogus pins: reaching realpath with them would fail
  // differently, so the message proves the path was refused up front.
  const roots = [{ configured: "/nonexistent", path: "/nonexistent", dev: 0, ino: 0 }];
  for (const p of ["//attacker.example/share/x", "\\\\attacker.example\\share\\x", "//?/C:/x", "\\\\.\\pipe\\x"]) {
    await assert.rejects(checkTargetDir(p, roots), /UNC or device|absolute path/, p);
  }
  assert.throws(() => attachmentRoots({ PONYMAIL_ATTACHMENT_DIRS: "//server/share" }), /UNC or device/);
});

test("checkTargetDir requires an absolute path without dot segments", async () => {
  const roots = [{ configured: "/tmp", path: "/tmp", dev: 0, ino: 0 }];
  await assert.rejects(checkTargetDir("relative/dir", roots), /absolute/);
  await assert.rejects(checkTargetDir("", roots), /absolute/);
  await assert.rejects(checkTargetDir(undefined, roots), /absolute/);
  await assert.rejects(checkTargetDir("/tmp/x/../y", roots), /segments/);
  await assert.rejects(checkTargetDir("/tmp/./y", roots), /segments/);
});

test("checkTargetDir accepts a root and directories inside it, existing or not", async () => {
  const { base, root, pins } = await sandbox();
  try {
    assert.equal(await checkTargetDir(root, pins), root);
    assert.equal(await checkTargetDir(root + "/", pins), root);
    assert.equal(await checkTargetDir(path.join(root, "a", "b"), pins), path.join(root, "a", "b"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("checkTargetDir rejects directories outside every root", async () => {
  const { base, root, outside, pins } = await sandbox();
  try {
    await assert.rejects(checkTargetDir(outside, pins), /not inside/);
    await assert.rejects(checkTargetDir(base, pins), /not inside/);
    // A sibling sharing the root's name as a prefix is not inside it.
    await assert.rejects(checkTargetDir(root + "-evil", pins), /not inside/);
    await assert.rejects(checkTargetDir("/", pins), /not inside/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("checkTargetDir follows symlinks before comparing", async () => {
  if (process.platform === "win32") return;
  const { base, root, outside, pins } = await sandbox();
  try {
    // A link inside the root that points out of it is rejected...
    await symlink(outside, path.join(root, "escape"));
    await assert.rejects(checkTargetDir(path.join(root, "escape"), pins), /not inside/);
    await assert.rejects(checkTargetDir(path.join(root, "escape", "deeper"), pins), /not inside/);
    // ...and a link outside the root that points into it is accepted.
    await symlink(root, path.join(base, "into"));
    assert.ok(await checkTargetDir(path.join(base, "into", "x"), pins));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("pinRoots creates missing roots 0700 and records their canonical paths", async () => {
  const { base } = await sandbox();
  try {
    const fresh = path.join(base, "fresh", "root");
    const [pin] = await pinRoots([fresh]);
    assert.equal(pin.path, fresh);
    assert.equal(pin.configured, fresh);
    if (process.platform !== "win32") {
      assert.equal((await stat(fresh)).mode & 0o777, 0o700);
    }
    await writeFile(path.join(base, "file"), "x");
    await assert.rejects(pinRoots([path.join(base, "file")]), /EEXIST|not a directory/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("checkTargetDir refuses a root replaced by a symlink after pinning", async () => {
  if (process.platform === "win32") return;
  const { base, root, outside, pins } = await sandbox();
  try {
    // The attack: move the pinned root away and point its name elsewhere.
    // Either check may catch it; both refuse.
    await rename(root, path.join(base, "allowed-moved"));
    await symlink(outside, root);
    await assert.rejects(checkTargetDir(root, pins), /replaced or moved|not inside/);
    await assert.rejects(checkTargetDir(path.join(root, "x"), pins), /replaced or moved|not inside/);
    await assert.rejects(
      writeAttachment(path.join(root, "x"), "authorized_keys", Buffer.from("ssh-ed25519 AAAA"), pins),
      /replaced or moved|not inside/
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("checkTargetDir refuses a root replaced by a new directory after pinning", async () => {
  const { base, root, pins } = await sandbox();
  try {
    await rename(root, path.join(base, "allowed-moved"));
    await mkdir(root);
    await assert.rejects(checkTargetDir(root, pins), /replaced or moved/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// --- writeAttachment ------------------------------------------------------------

test("writeAttachment creates the directory, writes 0600 and never overwrites", async () => {
  const { base, root, pins } = await sandbox();
  try {
    const dir = path.join(root, "nested", "out");
    const first = await writeAttachment(dir, "a.patch", Buffer.from("one"), pins);
    const second = await writeAttachment(dir, "a.patch", Buffer.from("two"), pins);
    assert.equal(first.name, "a.patch");
    assert.equal(second.name, "a-1.patch");
    assert.equal(await readFile(first.path, "utf8"), "one");
    assert.equal(await readFile(second.path, "utf8"), "two");
    assert.equal(
      first.sha256,
      "7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed"
    );
    if (process.platform !== "win32") {
      assert.equal((await stat(first.path)).mode & 0o777, 0o600);
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
    }
    assert.deepEqual((await readdir(dir)).sort(), ["a-1.patch", "a.patch"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("writeAttachment refuses a directory outside the roots and writes nothing", async () => {
  const { base, root, outside, pins } = await sandbox();
  try {
    await assert.rejects(writeAttachment(outside, "x.txt", Buffer.from("x"), pins), /not inside/);
    await assert.rejects(writeAttachment(path.join(outside, "new"), "x.txt", Buffer.from("x"), pins), /not inside/);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("writeAttachment leaves an existing file or symlink untouched", async () => {
  const { base, root, outside, pins } = await sandbox();
  try {
    await writeFile(path.join(root, "keep.txt"), "original");
    const saved = await writeAttachment(root, "keep.txt", Buffer.from("new"), pins);
    assert.equal(saved.name, "keep-1.txt");
    assert.equal(await readFile(path.join(root, "keep.txt"), "utf8"), "original");

    if (process.platform !== "win32") {
      const target = path.join(outside, "target.txt");
      await writeFile(target, "outside");
      await symlink(target, path.join(root, "link.txt"));
      const viaLink = await writeAttachment(root, "link.txt", Buffer.from("new"), pins);
      assert.equal(viaLink.name, "link-1.txt");
      assert.equal(await readFile(target, "utf8"), "outside");
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("writeAttachment refuses names that would leave the directory", async () => {
  const { base, root, pins } = await sandbox();
  try {
    await assert.rejects(writeAttachment(root, "../escape.txt", Buffer.from("x"), pins), /outside/);
    await assert.rejects(writeAttachment(root, "sub/x.txt", Buffer.from("x"), pins), /outside/);
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual((await readdir(base)).sort(), ["allowed", "outside"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("writeAttachment writes nothing when the directory is swapped for a symlink before open", async () => {
  if (process.platform === "win32") return;
  const { base, root, outside, pins } = await sandbox();
  try {
    const dir = path.join(root, "r1");
    const swap = async () => {
      await rename(dir, path.join(root, "r1-moved"));
      await symlink(outside, dir);
    };
    await assert.rejects(
      writeAttachment(dir, "poc.txt", Buffer.from("secret"), pins, { beforeOpen: swap }),
      /changed while saving/
    );
    // At most an empty file landed outside; none of the bytes did.
    for (const f of await readdir(outside)) {
      assert.equal((await stat(path.join(outside, f))).size, 0);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("writeAttachment writes nothing when the directory is swapped after open", async () => {
  if (process.platform === "win32") return;
  const { base, root, outside, pins } = await sandbox();
  try {
    const dir = path.join(root, "r1");
    const swap = async () => {
      await rename(dir, path.join(root, "r1-moved"));
      await symlink(outside, dir);
    };
    await assert.rejects(
      writeAttachment(dir, "poc.txt", Buffer.from("secret"), pins, { afterOpen: swap }),
      /changed while saving/
    );
    assert.deepEqual(await readdir(outside), []);
    assert.equal((await stat(path.join(root, "r1-moved", "poc.txt"))).size, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// --- readLimited ----------------------------------------------------------------

function streamResponse(chunks, headers = {}) {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (chunks.length === 0) controller.close();
      else controller.enqueue(new Uint8Array(chunks.shift()));
    },
    cancel() {
      cancelled = true;
    },
  });
  const resp = new Response(body, { headers });
  return { resp, wasCancelled: () => cancelled };
}

test("readLimited returns the whole body within the limit", async () => {
  const { resp } = streamResponse([[1, 2], [3]]);
  assert.deepEqual([...(await readLimited(resp, 3))], [1, 2, 3]);
});

test("readLimited refuses a Content-Length over the limit before reading", async () => {
  const { resp } = streamResponse([[1, 2, 3]], { "content-length": "100" });
  await assert.rejects(readLimited(resp, 10), /exceeds 10 bytes/);
});

test("readLimited cancels a stream that runs past the limit without a usable length", async () => {
  // Endless chunks: only an incremental limit makes this terminate.
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(readLimited(new Response(body), 4096), /exceeds 4096 bytes/);
  assert.ok(cancelled);
  assert.ok(pulled <= 8);
});

test("readLimited catches a body larger than an understated size", async () => {
  const { resp, wasCancelled } = streamResponse([[1, 2, 3], [4, 5, 6]]);
  await assert.rejects(readLimited(resp, 4), /exceeds 4 bytes/);
  assert.ok(wasCancelled());
});

test("writeAttachment writes nothing when the directory is swapped during final resolution", async () => {
  if (process.platform === "win32") return;
  const { base, root, outside, pins } = await sandbox();
  try {
    const dir = path.join(root, "r1");
    const swap = async () => {
      await rename(dir, path.join(root, "r1-moved"));
      await symlink(outside, dir);
    };
    await assert.rejects(
      writeAttachment(dir, "poc.txt", Buffer.from("secret"), pins, { afterResolve: swap }),
      /changed while saving/
    );
    for (const f of await readdir(outside)) {
      assert.equal((await stat(path.join(outside, f))).size, 0);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("writeAttachment writes nothing when the pinned root is swapped after open", async () => {
  if (process.platform === "win32") return;
  const { base, root, outside, pins } = await sandbox();
  try {
    const swap = async () => {
      await rename(root, path.join(base, "allowed-moved"));
      await symlink(outside, root);
    };
    await assert.rejects(
      writeAttachment(path.join(root, "r1"), "poc.txt", Buffer.from("secret"), pins, { afterOpen: swap }),
      /changed while saving/
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("pinRoots refuses a root planted as a symlink", async () => {
  if (process.platform === "win32") return;
  const { base, outside } = await sandbox();
  try {
    const planted = path.join(base, "planted");
    await symlink(outside, planted);
    await assert.rejects(pinRoots([planted]), /must not be a symlink/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("pinRoots refuses a root writable by group or others", async () => {
  if (process.platform === "win32") return;
  const { base, root } = await sandbox();
  try {
    await chmod(root, 0o777);
    await assert.rejects(pinRoots([root]), /(writable by|which) group or others/);
    await chmod(root, 0o770);
    await assert.rejects(pinRoots([root]), /(writable by|which) group or others/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("pinRoots refuses a root below a group- or world-writable, non-sticky directory", async () => {
  if (process.platform === "win32") return;
  const { base } = await sandbox();
  try {
    const shared = path.join(base, "shared");
    await mkdir(shared);
    for (const mode of [0o777, 0o770, 0o757]) {
      await chmod(shared, mode);
      await assert.rejects(pinRoots([path.join(shared, "root")]), /group or others can write to/, mode.toString(8));
    }
    await chmod(shared, 0o1777);
    const [pin] = await pinRoots([path.join(shared, "root")]);
    assert.equal(pin.path, path.join(shared, "root"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("ensureDir creates nothing outside when an outside symlink into the root is re-pointed", async () => {
  if (process.platform === "win32") return;
  const { base, root, outside, pins } = await sandbox();
  try {
    // `link` lives outside the root and points into it; the pinned root is untouched.
    const link = path.join(base, "link");
    await symlink(root, link);
    const swap = async () => {
      await rm(link);
      await symlink(outside, link);
    };
    await assert.rejects(
      writeAttachment(path.join(link, "new", "deeper"), "x.txt", Buffer.from("x"), pins, { beforeMkdir: swap }),
      /not inside/
    );
    assert.deepEqual(await readdir(outside), []);
    // The directory was created where the check pointed: inside the root.
    assert.deepEqual(await readdir(path.join(root, "new")), ["deeper"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("pinRoots checks the configured path, not only where it resolves", async () => {
  if (process.platform === "win32") return;
  const { base, outside } = await sandbox();
  try {
    // A link planted in a directory others can write to is refused even
    // though its target, `outside`, is a perfectly private directory.
    const shared = path.join(base, "shared");
    await mkdir(shared);
    await chmod(shared, 0o777);
    await symlink(outside, path.join(shared, "pm"));
    await assert.rejects(pinRoots([path.join(shared, "pm", "downloads")]), /goes through .*shared, which group or others/);
    assert.deepEqual(await readdir(outside), []);

    // The same link in a directory only we control is trusted.
    await chmod(shared, 0o700);
    const [pin] = await pinRoots([path.join(shared, "pm", "downloads")]);
    assert.equal(pin.path, path.join(outside, "downloads"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("readLimited ignores the wire length of an encoded response", async () => {
  // Content-Length is the gzip size, larger than the decoded body here.
  const { resp } = streamResponse([[1, 2, 3]], { "content-encoding": "gzip", "content-length": "40" });
  assert.deepEqual([...(await readLimited(resp, 3))], [1, 2, 3]);
  const { resp: big } = streamResponse([[1, 2, 3, 4]], { "content-encoding": "gzip", "content-length": "2" });
  await assert.rejects(readLimited(big, 3), /exceeds 3 bytes/);
});
