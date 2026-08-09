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

// Schema and formatting for PonyMail email records.
// Wraps the raw email summary objects returned by the /api/stats and /api/thread
// endpoints and centralizes field access and Markdown rendering.

// Extract (list, domain) from a PonyMail email record.
// PonyMail returns `list` as "list@domain" and `list_raw` as "<list.domain>".
// We try both.
export function extractListDomain(record) {
  const candidates = [record?.list, record?.list_raw];
  for (const c of candidates) {
    if (!c || typeof c !== "string") continue;
    const stripped = c.replace(/^<|>$/g, "");
    if (stripped.includes("@")) {
      const [list, domain] = stripped.split("@", 2);
      if (list && domain) return { list, domain };
    }
    const dot = stripped.indexOf(".");
    if (dot > 0) {
      return { list: stripped.slice(0, dot), domain: stripped.slice(dot + 1) };
    }
  }
  return { list: null, domain: null };
}

// Count all descendants of a thread_struct node, recursively.
// `children.length` would undercount:
// a nested 10-message reply chain must not report a single reply.
export function countDescendants(node) {
  const children = node?.children;
  if (!Array.isArray(children)) return 0;
  let count = 0;
  for (const child of children) {
    count += 1 + countDescendants(child);
  }
  return count;
}

export class Mail {
  constructor(raw = {}) {
    this.raw = raw ?? {};
  }

  // The canonical email ID: the permalink, which is also the ES document id.
  // The Foal API also emits an `id` field,
  // but it is a response-time alias of `mid` (always equal when both are present).
  get mid() {
    return this.raw.mid || null;
  }

  get subject() {
    return this.raw.subject || null;
  }

  get from() {
    return this.raw.from || null;
  }

  get epoch() {
    return this.raw.epoch ?? null;
  }

  // Human-readable date: `date` when present,
  // else derived from `epoch` as yyyy-mm-dd (1970-01-01 when neither is set).
  get date() {
    return this.raw.date || new Date((this.raw.epoch || 0) * 1000).toISOString().slice(0, 10);
  }

  get inReplyTo() {
    const v = this.raw["in-reply-to"];
    return v && String(v).trim() ? v : null;
  }

  get isPrivate() {
    return Boolean(this.raw.private);
  }

  listDomain() {
    return extractListDomain(this.raw);
  }

  // Heuristic hint that this message continues an earlier conversation:
  // the subject starts with "Re:" or the message carries an In-Reply-To header.
  // Neither signal is reliable
  // (users reply without setting headers, forward messages and create new thread from old ones),
  // so callers must treat this as a hint, never as a filter.
  isPossibleContinuation() {
    if (this.subject && /^\s*re:/i.test(this.subject)) return true;
    return this.inReplyTo !== null;
  }

  // Render the Markdown list item used by search_list.
  // opts.replyCount appends a reply counter to the metadata line;
  // opts.continuationHint adds a continuation note when isPossibleContinuation() holds.
  formatListItem(opts = {}) {
    const lines = [];
    lines.push(`- **${this.subject || "(no subject)"}**`);
    let meta = `  From: ${this.from || "(unknown sender)"} | Date: ${this.date} | ID: ${this.mid || "(no id)"}`;
    if (opts.replyCount !== undefined) {
      meta += ` | Replies: ${opts.replyCount}`;
    }
    lines.push(meta);
    if (opts.continuationHint && this.isPossibleContinuation()) {
      lines.push("  (possible continuation of an earlier thread)");
    }
    return lines.join("\n");
  }

  // Build a Map from mid to Mail for an array of raw email records.
  // Records without a mid are skipped; on duplicate mids the last record wins.
  static mapByMid(emails) {
    const map = new Map();
    for (const raw of emails || []) {
      const mail = new Mail(raw);
      if (mail.mid) map.set(mail.mid, mail);
    }
    return map;
  }
}
