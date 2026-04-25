// Mailing list access restrictions.
//
// By default, this server blocks ALL private mailing lists — including
// project-private (PMC) lists, security lists, and Foundation-private lists —
// to prevent an LLM from accidentally ingesting confidential content.
//
// Two layers of defense:
//   1. Pattern blocks (PONYMAIL_RESTRICTED_LISTS) — applied before fetching.
//      Catches well-known private list names like "private@", "security@",
//      board@apache.org, etc.
//   2. Response-level private flag — applied after fetching. PonyMail tags
//      private lists/messages with `private: true`; we block these even if
//      they don't match a known pattern (e.g. unusually-named PMC lists).
//
// Opt-in via PONYMAIL_ALLOWED_LISTS (comma-separated patterns). A list on
// the allowlist bypasses both layers. Use this for lists you are explicitly
// authorized to access.
//
// Pattern forms (used in both env vars):
//   "prefix@"         — matches any list whose local part equals `prefix`
//                       (e.g. "private@" matches private@iceberg.apache.org
//                       AND private@apache.org)
//   "@domain"         — matches any list in that domain
//   "prefix@domain"   — exact match

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

function parsePatternList(raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === "" || trimmed.toLowerCase() === "none") return [];
  return trimmed
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function parseRestrictedLists() {
  const parsed = parsePatternList(process.env.PONYMAIL_RESTRICTED_LISTS);
  return parsed === null ? DEFAULT_RESTRICTED : parsed;
}

function parseAllowedLists() {
  const parsed = parsePatternList(process.env.PONYMAIL_ALLOWED_LISTS);
  return parsed === null ? [] : parsed;
}

// Captured at module load. Changing PONYMAIL_RESTRICTED_LISTS or
// PONYMAIL_ALLOWED_LISTS at runtime has no effect — restart the MCP server.
const RESTRICTED = parseRestrictedLists();
const ALLOWED = parseAllowedLists();

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

// Returns the matching allow pattern if (list, domain) is explicitly opted in,
// else null. Allow-listing bypasses both pattern and private-flag blocks.
export function allowedFor(list, domain) {
  if (!list || !domain) return null;
  const l = String(list).toLowerCase();
  const d = String(domain).toLowerCase();
  for (const pattern of ALLOWED) {
    if (matchPattern(pattern, l, d)) return pattern;
  }
  return null;
}

// Returns the matching restricted pattern if (list, domain) should be blocked
// pre-fetch, else null. Returns null when the list is on the allowlist.
export function restrictionFor(list, domain) {
  if (!list || !domain) return null;
  if (allowedFor(list, domain)) return null;
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

function isTruthyPrivate(flag) {
  if (flag === true || flag === 1) return true;
  if (typeof flag === "string") {
    return ["true", "1", "yes"].includes(flag.toLowerCase());
  }
  return false;
}

// Should the response be blocked because PonyMail marked it private?
// Pass the value of the `private` field from a PonyMail API response.
// Allow-listed lists bypass this check.
export function isPrivateBlocked(list, domain, privateFlag) {
  if (!isTruthyPrivate(privateFlag)) return false;
  if (list && domain && allowedFor(list, domain)) return false;
  return true;
}

export function restrictionError(list, domain, pattern) {
  return (
    `Access to ${list}@${domain} is blocked by this MCP server ` +
    `(matches restricted pattern "${pattern}"). ` +
    `These lists contain confidential Foundation or PMC-private content. ` +
    `If you are authorized to access this list, opt in by adding it to ` +
    `PONYMAIL_ALLOWED_LISTS (e.g. "${list}@${domain}").`
  );
}

export function privateError(list, domain) {
  const addr = list && domain ? `${list}@${domain}` : "this list";
  return (
    `Access to ${addr} is blocked: PonyMail marks it as private. ` +
    `By default, all private mailing lists are restricted to prevent ` +
    `accidental ingestion of confidential content. If you are authorized, ` +
    `opt in by adding "${addr}" (or a matching pattern) to ` +
    `PONYMAIL_ALLOWED_LISTS.`
  );
}

export function isRestricted(list, domain) {
  return restrictionFor(list, domain) !== null;
}

export function listRestrictions() {
  return [...RESTRICTED];
}

export function listAllowed() {
  return [...ALLOWED];
}
