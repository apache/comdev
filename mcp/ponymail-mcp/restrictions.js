// Mailing list access restrictions.
//
// Some mailing lists (board@apache.org, members@apache.org, private@<pmc>, ...)
// contain confidential Foundation business or PMC-private discussions. Even
// if a user has an authenticated session cookie that grants access, we block
// these lists at the MCP layer so an LLM cannot accidentally ingest them.
//
// Patterns:
//   "prefix@"         — matches any list whose local part equals `prefix`
//                       (e.g. "private@" matches private@iceberg.apache.org
//                       AND private@apache.org)
//   "@domain"         — matches any list in that domain
//   "prefix@domain"   — exact match
//
// The defaults cover ASF Foundation-level private lists plus the universal
// PMC-private patterns. Override or replace via the PONYMAIL_RESTRICTED_LISTS
// env var (comma-separated). Use PONYMAIL_RESTRICTED_LISTS="none" to disable
// all restrictions.

const DEFAULT_RESTRICTED = [
  // Universal PMC-private and security patterns (match across all domains)
  "private@",
  "security@",
  // ASF Foundation-level private lists
  "board@apache.org",
  "members@apache.org",
  "operations@apache.org",
  "trademarks@apache.org",
  "fundraising@apache.org",
  "executive-officers@apache.org",
  "president@apache.org",
  "chairman@apache.org",
  "secretary@apache.org",
  "treasurer@apache.org",
];

function parseRestrictedLists() {
  const raw = process.env.PONYMAIL_RESTRICTED_LISTS;
  if (raw === undefined) return DEFAULT_RESTRICTED;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "none") return [];
  return trimmed
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

const RESTRICTED = parseRestrictedLists();

function matchPattern(pattern, list, domain) {
  if (pattern.endsWith("@")) {
    return list === pattern.slice(0, -1);
  }
  if (pattern.startsWith("@")) {
    return domain === pattern.slice(1);
  }
  const at = pattern.indexOf("@");
  if (at < 0) return false;
  return list === pattern.slice(0, at) && domain === pattern.slice(at + 1);
}

// Returns the matching pattern string if (list, domain) is restricted, else null.
export function restrictionFor(list, domain) {
  if (!list || !domain) return null;
  const l = String(list).toLowerCase();
  const d = String(domain).toLowerCase();
  for (const pattern of RESTRICTED) {
    if (matchPattern(pattern, l, d)) return pattern;
  }
  return null;
}

// Accepts "list@domain" (as used by the mbox endpoint) and returns the pattern
// match or null.
export function restrictionForAddress(address) {
  if (!address || typeof address !== "string") return null;
  const at = address.indexOf("@");
  if (at < 0) return null;
  return restrictionFor(address.slice(0, at), address.slice(at + 1));
}

export function restrictionError(list, domain, pattern) {
  return (
    `Access to ${list}@${domain} is blocked by this MCP server ` +
    `(matches restricted pattern "${pattern}"). ` +
    `These lists contain confidential Foundation or PMC-private content. ` +
    `Adjust via the PONYMAIL_RESTRICTED_LISTS env var if you are authorized ` +
    `to access this list and understand the implications.`
  );
}

export function isRestricted(list, domain) {
  return restrictionFor(list, domain) !== null;
}

export function listRestrictions() {
  return [...RESTRICTED];
}
