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

// Tests for mail.js. Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { Mail, extractListDomain, countDescendants } from "./mail.js";

// --- Field extraction --------------------------------------------------------

test("mid reads raw.mid and ignores the id alias", () => {
  assert.equal(new Mail({ mid: "abc", id: "def" }).mid, "abc");
  assert.equal(new Mail({ id: "def" }).mid, null);
  assert.equal(new Mail({}).mid, null);
});

test("inReplyTo reads the hyphenated header and rejects blank values", () => {
  assert.equal(new Mail({ "in-reply-to": "<x@y>" }).inReplyTo, "<x@y>");
  assert.equal(new Mail({ "in-reply-to": "" }).inReplyTo, null);
  assert.equal(new Mail({ "in-reply-to": "   " }).inReplyTo, null);
  assert.equal(new Mail({}).inReplyTo, null);
});

test("isPrivate coerces the private flag", () => {
  assert.equal(new Mail({ private: true }).isPrivate, true);
  assert.equal(new Mail({ private: false }).isPrivate, false);
  assert.equal(new Mail({}).isPrivate, false);
});

test("mapByMid keys by mid, skips records without one, last wins on duplicates", () => {
  const map = Mail.mapByMid([
    { mid: "a", subject: "first" },
    { subject: "no mid" },
    { mid: "a", subject: "second" },
    { id: "b", subject: "id alias only, skipped" },
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get("a").subject, "second");
  assert.equal(map.has("b"), false);
  assert.equal(Mail.mapByMid(null).size, 0);
});

// --- Date handling -----------------------------------------------------------

test("date prefers the date field over epoch", () => {
  assert.equal(new Mail({ date: "2026-01-02 03:04", epoch: 0 }).date, "2026-01-02 03:04");
});

test("date derives yyyy-mm-dd from epoch", () => {
  // 2026-07-12 in UTC
  assert.equal(new Mail({ epoch: 1783875892 }).date, "2026-07-12");
});

test("date falls back to the Unix epoch when neither field is set", () => {
  assert.equal(new Mail({}).date, "1970-01-01");
});

// --- Continuation heuristics ---------------------------------------------------

test("isPossibleContinuation matches Re: subjects case-insensitively", () => {
  assert.equal(new Mail({ subject: "Re: foo" }).isPossibleContinuation(), true);
  assert.equal(new Mail({ subject: "re: foo" }).isPossibleContinuation(), true);
  assert.equal(new Mail({ subject: "  Re: foo" }).isPossibleContinuation(), true);
});

test("isPossibleContinuation does not match Re-like prefixes", () => {
  assert.equal(new Mail({ subject: "Regarding foo" }).isPossibleContinuation(), false);
  assert.equal(new Mail({ subject: "[CVE] foo" }).isPossibleContinuation(), false);
});

test("isPossibleContinuation matches a non-empty In-Reply-To without Re:", () => {
  assert.equal(new Mail({ subject: "foo", "in-reply-to": "<x@y>" }).isPossibleContinuation(), true);
  assert.equal(new Mail({ "in-reply-to": "<x@y>" }).isPossibleContinuation(), true);
  assert.equal(new Mail({ subject: "foo", "in-reply-to": "" }).isPossibleContinuation(), false);
  assert.equal(new Mail({}).isPossibleContinuation(), false);
});

// --- Formatting ----------------------------------------------------------------

test("formatListItem renders the plain two-line summary", () => {
  const mail = new Mail({ subject: "Hello", from: "Jane <jane@example.org>", date: "2026-01-02", mid: "abc" });
  assert.equal(
    mail.formatListItem(),
    "- **Hello**\n  From: Jane <jane@example.org> | Date: 2026-01-02 | ID: abc"
  );
});

test("formatListItem uses placeholders for missing fields", () => {
  assert.equal(
    new Mail({}).formatListItem(),
    "- **(no subject)**\n  From: (unknown sender) | Date: 1970-01-01 | ID: (no id)"
  );
});

test("formatListItem appends the reply count when given", () => {
  const mail = new Mail({ subject: "Hello", from: "a@b", date: "2026-01-02", mid: "abc" });
  assert.equal(
    mail.formatListItem({ replyCount: 3 }),
    "- **Hello**\n  From: a@b | Date: 2026-01-02 | ID: abc | Replies: 3"
  );
});

test("formatListItem adds the continuation hint only when requested and applicable", () => {
  const cont = new Mail({ subject: "Re: Hello", from: "a@b", date: "2026-01-02", mid: "abc" });
  assert.equal(
    cont.formatListItem({ continuationHint: true }),
    "- **Re: Hello**\n  From: a@b | Date: 2026-01-02 | ID: abc\n" +
      "  (possible continuation of an earlier thread)"
  );
  // Hint not requested: no extra line even for a Re: subject.
  assert.equal(
    cont.formatListItem(),
    "- **Re: Hello**\n  From: a@b | Date: 2026-01-02 | ID: abc"
  );
  // Hint requested but not applicable: no extra line.
  const fresh = new Mail({ subject: "Hello", from: "a@b", date: "2026-01-02", mid: "abc" });
  assert.equal(
    fresh.formatListItem({ continuationHint: true }),
    "- **Hello**\n  From: a@b | Date: 2026-01-02 | ID: abc"
  );
});

// --- extractListDomain -----------------------------------------------------------

test("extractListDomain parses list@domain", () => {
  assert.deepEqual(
    extractListDomain({ list: "dev@community.apache.org" }),
    { list: "dev", domain: "community.apache.org" }
  );
});

test("extractListDomain parses <list.domain> from list_raw", () => {
  assert.deepEqual(
    extractListDomain({ list_raw: "<dev.community.apache.org>" }),
    { list: "dev", domain: "community.apache.org" }
  );
});

test("extractListDomain returns nulls for unusable input", () => {
  assert.deepEqual(extractListDomain({}), { list: null, domain: null });
  assert.deepEqual(extractListDomain(null), { list: null, domain: null });
  assert.deepEqual(extractListDomain({ list: 42, list_raw: "nodots" }), { list: null, domain: null });
});

// --- countDescendants ------------------------------------------------------------

test("countDescendants handles leaves and missing children", () => {
  assert.equal(countDescendants({ children: [] }), 0);
  assert.equal(countDescendants({ children: null }), 0);
  assert.equal(countDescendants({}), 0);
  assert.equal(countDescendants(null), 0);
});

test("countDescendants counts flat children", () => {
  assert.equal(countDescendants({ children: [{}, {}, {}] }), 3);
});

test("countDescendants counts nested reply chains in full", () => {
  const chain = { children: [{ children: [{ children: [{}] }] }, {}] };
  assert.equal(countDescendants(chain), 4);
});
