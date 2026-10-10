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

// Unit tests for browser-login.js helpers. The end-to-end browser login is
// covered in auth.test.js against a fake browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { PipeCdp, pickSessionCookie, findBrowser } from "./browser-login.js";

test("pickSessionCookie returns the ponymail cookie for the host", () => {
  const cookies = [
    { name: "_pk_id", value: "x", domain: "lists.apache.org" },
    { name: "ponymail", value: "abc", domain: "lists.apache.org" },
  ];
  assert.equal(pickSessionCookie(cookies, "lists.apache.org"), "ponymail=abc");
});

test("pickSessionCookie accepts a parent-domain cookie", () => {
  const cookies = [{ name: "ponymail", value: "abc", domain: ".apache.org" }];
  assert.equal(pickSessionCookie(cookies, "lists.apache.org"), "ponymail=abc");
});

test("pickSessionCookie ignores other hosts, look-alike domains and empty values", () => {
  assert.equal(pickSessionCookie([{ name: "ponymail", value: "a", domain: "lists.example.org" }], "lists.apache.org"), null);
  assert.equal(pickSessionCookie([{ name: "ponymail", value: "a", domain: "evilapache.org" }], "lists.apache.org"), null);
  assert.equal(pickSessionCookie([{ name: "ponymail", value: "", domain: "lists.apache.org" }], "lists.apache.org"), null);
  assert.equal(pickSessionCookie(undefined, "lists.apache.org"), null);
});

test("PipeCdp frames commands with NUL and matches replies by id", async () => {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const cdp = new PipeCdp(toBrowser, fromBrowser);
  const sent = [];
  toBrowser.on("data", (d) => sent.push(d.toString()));

  const first = cdp.send("Storage.getCookies");
  const second = cdp.send("Browser.close");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent.join("").split("\0").filter(Boolean).map((m) => JSON.parse(m)), [
    { id: 1, method: "Storage.getCookies", params: {} },
    { id: 2, method: "Browser.close", params: {} },
  ]);

  // Replies out of order, split across chunks, with an event in between
  fromBrowser.write('{"id":2,"result":{}}\0{"method":"Target.event"}\0{"id":1,"res');
  fromBrowser.write('ult":{"cookies":[]}}\0');
  assert.deepEqual(await first, { cookies: [] });
  assert.deepEqual(await second, {});
});

test("PipeCdp rejects errors and pending commands when the pipe closes", async () => {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const cdp = new PipeCdp(toBrowser, fromBrowser);
  const failing = cdp.send("Nope.method");
  fromBrowser.write('{"id":1,"error":{"message":"not found"}}\0');
  await assert.rejects(failing, /Nope.method: not found/);

  const pending = cdp.send("Storage.getCookies");
  fromBrowser.destroy();
  await assert.rejects(pending, /closed/);
  await assert.rejects(cdp.send("Storage.getCookies"), /closed/);
});

test("findBrowser honours PONYMAIL_BROWSER", () => {
  const saved = process.env.PONYMAIL_BROWSER;
  try {
    process.env.PONYMAIL_BROWSER = "none";
    assert.equal(findBrowser(), null);
    process.env.PONYMAIL_BROWSER = "NONE";
    assert.equal(findBrowser(), null);
    process.env.PONYMAIL_BROWSER = "/opt/custom/chrome";
    assert.equal(findBrowser(), "/opt/custom/chrome");
  } finally {
    if (saved === undefined) delete process.env.PONYMAIL_BROWSER;
    else process.env.PONYMAIL_BROWSER = saved;
  }
});
