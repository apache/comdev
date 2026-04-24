#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadSession, performLogin, clearSession } from "./auth.js";
import {
  restrictionFor,
  restrictionForAddress,
  restrictionError,
  listRestrictions,
} from "./restrictions.js";

const BASE_URL = process.env.PONYMAIL_BASE_URL || "https://lists.apache.org";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiFetch(path, params = {}) {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }

  // Build headers — include session cookie if available
  const headers = { Accept: "application/json" };

  // Priority: env var > cached session file
  const envCookie = process.env.PONYMAIL_SESSION_COOKIE;
  const sessionCookie = envCookie || loadSession();
  if (sessionCookie) {
    headers.Cookie = sessionCookie;
  }

  const resp = await fetch(url.toString(), { headers });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`PonyMail API error ${resp.status}: ${body}`);
  }

  const contentType = resp.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return await resp.json();
  }
  // mbox endpoint returns text
  return await resp.text();
}

function truncate(text, max = 4000) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + `\n... [truncated, ${text.length - max} more chars]`;
}

// Extract (list, domain) from a PonyMail email record. PonyMail returns
// `list` as "list@domain" and `list_raw` as "<list.domain>". We try both.
function extractListDomain(record) {
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

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "ponymail",
  version: "1.0.0",
});

// --- Tool: list_lists -------------------------------------------------------
server.tool(
  "list_lists",
  "Get an overview of available mailing lists and their message counts. " +
    "Returns domain → list → count mappings.",
  {},
  async () => {
    const data = await apiFetch("/api/preferences.lua");
    const lists = data.lists || {};
    const descriptions = data.descriptions || {};

    const lines = [];
    for (const [domain, domainLists] of Object.entries(lists)) {
      lines.push(`## ${domain}`);
      for (const [listName, count] of Object.entries(domainLists)) {
        const desc = descriptions[`${listName}@${domain}`] || "";
        const restricted = restrictionFor(listName, domain);
        const marker = restricted ? " [RESTRICTED — blocked by server policy]" : "";
        lines.push(`  - ${listName}: ${count} messages${desc ? " — " + desc : ""}${marker}`);
      }
    }

    return {
      content: [{ type: "text", text: lines.join("\n") || "No lists found." }],
    };
  }
);

// --- Tool: search_list ------------------------------------------------------
server.tool(
  "search_list",
  "Search or browse a mailing list. Returns email summaries, participant stats, " +
    "and thread structure. Use the list prefix (e.g. 'dev') and domain " +
    "(e.g. 'iceberg.apache.org'). Supports date ranges, search queries, and " +
    "header filters.",
  {
    list: z.string().describe("List prefix, e.g. 'dev', 'user', 'general'. Use '*' for all lists in a domain."),
    domain: z.string().describe("List domain, e.g. 'iceberg.apache.org', 'httpd.apache.org'"),
    query: z.string().optional().describe("Search query (supports wildcards and negation with -)"),
    timespan: z
      .string()
      .optional()
      .describe(
        "Timespan filter: 'yyyy-mm' for a month, 'lte=Nd' for last N days, " +
          "'gte=Nd' for older than N days, 'dfr=yyyy-mm-dd dto=yyyy-mm-dd' for range"
      ),
    from: z.string().optional().describe("Filter by From: header address"),
    subject: z.string().optional().describe("Filter by Subject: header"),
    body: z.string().optional().describe("Filter by body text"),
    quick: z.boolean().optional().describe("If true, return statistics only (faster)"),
    emails_only: z.boolean().optional().describe("If true, return email summaries only (skip thread_struct, participants, word cloud)"),
  },
  async ({ list, domain, query, timespan, from, subject, body, quick, emails_only }) => {
    const restricted = restrictionFor(list, domain);
    if (restricted) {
      return {
        content: [{ type: "text", text: restrictionError(list, domain, restricted) }],
        isError: true,
      };
    }

    const params = {
      list,
      domain,
      q: query,
      d: timespan,
      header_from: from,
      header_subject: subject,
      header_body: body,
    };
    if (quick) params.quick = "";
    if (emails_only) params.emailsOnly = "";

    const data = await apiFetch("/api/stats.lua", params);

    // Build a readable summary
    const lines = [];
    lines.push(`# ${data.list || list + "@" + domain}`);
    lines.push(`Hits: ${data.hits ?? "N/A"} | Threads: ${data.no_threads ?? "N/A"}`);
    if (data.firstYear) lines.push(`Archive range: ${data.firstYear} – ${data.lastYear}`);
    lines.push("");

    // Participants
    if (data.participants && Object.keys(data.participants).length > 0) {
      lines.push("## Top Participants");
      const parts = Array.isArray(data.participants)
        ? data.participants
        : Object.values(data.participants);
      for (const p of parts.slice(0, 15)) {
        lines.push(`  - ${p.name} (${p.email}): ${p.count} messages`);
      }
      lines.push("");
    }

    // Emails
    if (data.emails) {
      lines.push("## Emails");
      const emails = Array.isArray(data.emails)
        ? data.emails
        : Object.values(data.emails);
      for (const e of emails.slice(0, 30)) {
        const date = e.date || new Date((e.epoch || 0) * 1000).toISOString().slice(0, 10);
        lines.push(`- **${e.subject}**`);
        lines.push(`  From: ${e.from} | Date: ${date} | ID: ${e.id || e.mid}`);
      }
      lines.push("");
      if (emails.length > 30) {
        lines.push(`... and ${emails.length - 30} more emails`);
      }
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }
);

// --- Tool: get_email --------------------------------------------------------
server.tool(
  "get_email",
  "Fetch a specific email by its ID or Message-ID header. Returns full body, " +
    "headers, and attachment info.",
  {
    id: z.string().describe("The email ID (mid) or Message-ID header value"),
  },
  async ({ id }) => {
    const data = await apiFetch("/api/email.lua", { id });

    const { list, domain } = extractListDomain(data);
    const restricted = list && domain ? restrictionFor(list, domain) : null;
    if (restricted) {
      return {
        content: [{ type: "text", text: restrictionError(list, domain, restricted) }],
        isError: true,
      };
    }

    const lines = [];
    lines.push(`# ${data.subject || "(no subject)"}`);
    lines.push(`From: ${data.from}`);
    lines.push(`Date: ${data.date} (epoch: ${data.epoch})`);
    lines.push(`List: ${data.list || data.list_raw}`);
    lines.push(`Message-ID: ${data["message-id"]}`);
    lines.push(`Thread ID: ${data.tid}`);
    if (data["in-reply-to"]) lines.push(`In-Reply-To: ${data["in-reply-to"]}`);
    if (data.references) lines.push(`References: ${data.references}`);
    lines.push(`Private: ${data.private}`);
    lines.push("");
    lines.push("## Body");
    lines.push(truncate(data.body, 8000));

    if (data.attachments && Object.keys(data.attachments).length > 0) {
      lines.push("");
      lines.push("## Attachments");
      for (const [hash, att] of Object.entries(data.attachments)) {
        lines.push(`  - ${att.filename || hash} (${att.content_type}, ${att.size} bytes)`);
      }
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }
);

// --- Tool: get_thread -------------------------------------------------------
server.tool(
  "get_thread",
  "Fetch all emails in a thread. Provide the thread ID (tid) from a search result " +
    "or email. Returns the thread as a flat list of email summaries.",
  {
    id: z.string().describe("The thread ID (tid)"),
    list: z.string().describe("List prefix, e.g. 'dev', 'user'"),
    domain: z.string().describe("List domain, e.g. 'iceberg.apache.org'"),
  },
  async ({ id, list, domain }) => {
    const restrictedUp = restrictionFor(list, domain);
    if (restrictedUp) {
      return {
        content: [{ type: "text", text: restrictionError(list, domain, restrictedUp) }],
        isError: true,
      };
    }

    // Use stats endpoint scoped to a very wide range and filter by tid
    // PonyMail doesn't have a dedicated thread endpoint, but we can fetch
    // the root email which contains thread_struct, then fetch each child.
    const root = await apiFetch("/api/email.lua", { id });

    // Defence-in-depth: if the returned email belongs to a restricted list
    // (e.g. caller passed a mismatched list/domain), block anyway.
    const { list: rList, domain: rDomain } = extractListDomain(root);
    const restrictedAfter = rList && rDomain ? restrictionFor(rList, rDomain) : null;
    if (restrictedAfter) {
      return {
        content: [{ type: "text", text: restrictionError(rList, rDomain, restrictedAfter) }],
        isError: true,
      };
    }

    const lines = [];
    lines.push(`# Thread: ${root.subject || "(no subject)"}`);
    lines.push(`Root From: ${root.from} | Date: ${root.date}`);
    lines.push(`List: ${root.list || root.list_raw}`);
    lines.push("");
    lines.push("## Root Message");
    lines.push(truncate(root.body, 4000));

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }
);

// --- Tool: get_mbox ---------------------------------------------------------
server.tool(
  "get_mbox",
  "Download mbox-formatted archive data for a list and time range. " +
    "Useful for bulk export or offline analysis.",
  {
    list: z.string().describe("Full list address, e.g. 'dev@iceberg.apache.org'"),
    date: z.string().describe("Month in yyyy-mm format, e.g. '2024-06'"),
    from: z.string().optional().describe("Filter by sender email"),
    subject: z.string().optional().describe("Filter by subject words"),
  },
  async ({ list, date, from: fromAddr, subject }) => {
    const restricted = restrictionForAddress(list);
    if (restricted) {
      const at = list.indexOf("@");
      const lp = at >= 0 ? list.slice(0, at) : list;
      const dp = at >= 0 ? list.slice(at + 1) : "";
      return {
        content: [{ type: "text", text: restrictionError(lp, dp, restricted) }],
        isError: true,
      };
    }

    const params = {
      list,
      date,
      header_from: fromAddr,
      header_subject: subject,
    };

    const data = await apiFetch("/api/mbox.lua", params);
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);

    return {
      content: [{ type: "text", text: truncate(text, 10000) }],
    };
  }
);

// --- Tool: login ------------------------------------------------------------
server.tool(
  "login",
  "Authenticate with Apache's OAuth system to access private mailing lists. " +
    "Opens a browser window for ASF LDAP login, then caches the session cookie. " +
    "Only needed for private/restricted lists — public lists work without auth.",
  {},
  async () => {
    try {
      const cookie = await performLogin(BASE_URL);
      return {
        content: [
          {
            type: "text",
            text: "✅ Successfully authenticated! Session cookie cached.\n\n" +
              "You can now access private mailing lists. Session expires after ~20 hours.\n" +
              "Use `auth_status` to check, `logout` to clear.",
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `❌ Login failed: ${err.message}\n\nTry again, or set PONYMAIL_SESSION_COOKIE env var manually.`,
          },
        ],
      };
    }
  }
);

// --- Tool: logout -----------------------------------------------------------
server.tool(
  "logout",
  "Clear the cached PonyMail session cookie. After logout, only public lists " +
    "will be accessible.",
  {},
  async () => {
    clearSession();
    return {
      content: [
        { type: "text", text: "Session cleared. Only public lists are accessible now." },
      ],
    };
  }
);

// --- Tool: auth_status ------------------------------------------------------
server.tool(
  "auth_status",
  "Check current authentication status. Shows whether a session cookie is " +
    "cached and if it's still valid.",
  {},
  async () => {
    const envCookie = process.env.PONYMAIL_SESSION_COOKIE;
    const sessionCookie = envCookie || loadSession();

    if (!sessionCookie) {
      return {
        content: [
          {
            type: "text",
            text: "❌ Not authenticated. No session cookie found.\n\n" +
              "Use `login` to authenticate, or set PONYMAIL_SESSION_COOKIE env var.",
          },
        ],
      };
    }

    // Validate the cookie
    try {
      const url = new URL("/api/preferences.lua", BASE_URL);
      const resp = await fetch(url.toString(), {
        headers: { Accept: "application/json", Cookie: sessionCookie },
      });
      const data = await resp.json();

      if (data.login && data.login.credentials) {
        const creds = data.login.credentials;
        return {
          content: [
            {
              type: "text",
              text: `✅ Authenticated as: ${creds.fullname || "Unknown"} (${creds.email || "N/A"})\n\n` +
                `Source: ${envCookie ? "environment variable" : "cached session file"}\n` +
                "Session is valid.",
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: "⚠️ Session cookie found but no login credentials returned.\n" +
                "The session may have expired. Use `login` to re-authenticate.",
            },
          ],
        };
      }
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `⚠️ Could not validate session: ${err.message}\n` +
              "Use `login` to re-authenticate.",
          },
        ],
      };
    }
  }
);

// --- Tool: list_restrictions ------------------------------------------------
server.tool(
  "list_restrictions",
  "Show the mailing list patterns this server refuses to access. " +
    "Patterns can be 'prefix@' (matches across all domains), '@domain' (all " +
    "lists in a domain), or exact 'prefix@domain'. Configured via the " +
    "PONYMAIL_RESTRICTED_LISTS env var.",
  {},
  async () => {
    const patterns = listRestrictions();
    const lines = [];
    if (patterns.length === 0) {
      lines.push("No restrictions configured. All lists accessible (subject to auth).");
    } else {
      lines.push("## Restricted list patterns");
      for (const p of patterns) lines.push(`  - ${p}`);
      lines.push("");
      lines.push(
        "Override with PONYMAIL_RESTRICTED_LISTS (comma-separated). " +
          'Set to "none" to disable all restrictions.'
      );
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
