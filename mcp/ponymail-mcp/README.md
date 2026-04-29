# PonyMail MCP Server

An MCP (Model Context Protocol) server that provides access to the [Apache PonyMail](https://ponymail.apache.org/) mailing list archive API.

## Tools

| Tool | Description |
|------|-------------|
| `list_lists` | Get an overview of all available mailing lists and message counts |
| `search_list` | Search/browse a mailing list with filters (date, sender, subject, body, query) |
| `get_email` | Fetch a specific email by ID with full body and attachments |
| `get_thread` | Fetch the root message of a thread by thread ID |
| `get_mbox` | Download mbox-formatted archive data for bulk export |
| `login` | Authenticate via ASF OAuth to access private mailing lists |
| `logout` | Clear cached session cookie |
| `auth_status` | Check current authentication status |
| `list_restrictions` | Show mailing list patterns blocked by server policy |

## Setup

```bash
cd ponymail-mcp
npm install
```

## Configure in Your MCP Client

Add a local (stdio) MCP server with:

- **Command**: `node`
- **Args**: `/path/to/ponymail-mcp/index.js`

Refer to your MCP client's documentation for how to add a local stdio server.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PONYMAIL_BASE_URL` | `https://lists.apache.org` | Base URL of the PonyMail instance |
| `PONYMAIL_SESSION_COOKIE` | *(none)* | Manual session cookie override (skips OAuth flow) |
| `PONYMAIL_RESTRICTED_LISTS` | *(see below)* | Comma-separated patterns to block pre-fetch. Set to `none` to clear pattern blocks. |
| `PONYMAIL_ALLOWED_LISTS` | *(none)* | Comma-separated opt-in patterns. Lists matching these bypass all blocks. |

## Restricted Lists

By default, this server blocks **all private mailing lists** — including
project-private (PMC) lists, security lists, and Foundation-private lists —
so an LLM cannot accidentally ingest confidential content.

### Why this matters: PII and ASF policy (interim guidance)

Private ASF mailing lists frequently carry personally identifiable information
(PII) — full names tied to private opinions, contact details, sensitive HR-style
discussions (e.g. PMC membership debates), legal correspondence, and reports of
member or community misconduct. Feeding this content to an LLM — particularly
a hosted/third-party LLM where prompts may be logged, cached, or used to
improve models — is materially different from a human reading the same archive.

The current ASF baseline is set out on the [ASF Mailing Lists page][asf-lists]
("Be sure not to take emails from private discussions or mailing lists into a
public forum or list unless there is agreement by all parties to the
conversation") and the [ASF Privacy Policy][asf-privacy]. Neither yet addresses
LLM use specifically. Until that interim period ends and clearer rules exist,
**the safe default is to block all private lists** at this MCP layer. This
document will be updated as ASF guidance evolves.

[asf-lists]: https://www.apache.org/foundation/mailinglists.html
[asf-privacy]: https://privacy.apache.org/policies/privacy-policy-public.html

A few practical points to keep in mind:

- **You are responsible for compliance.** Whether or not the server blocks a
  list, it remains *your* responsibility, as the operator of the MCP client,
  to ensure you have permission to feed any list content to an LLM under
  current ASF policy and the expectations of the people who wrote those
  emails. The default block is a safety net, not a legal opinion.
- **Hosted vs. local LLMs change the risk.** A local LLM (e.g. running on
  your own machine where prompts never leave your control) carries
  meaningfully less data-handling risk than a hosted model whose provider
  may retain prompts. If you opt in to a private list, prefer an environment
  where you can be confident PII is not shared with anyone outside the
  list's intended audience.
- **Not all "private" lists are equally sensitive.** Lists like
  `security@<project>.apache.org` are private because they coordinate
  vulnerability response, but the content tends to be technical/operational
  ("work-related") rather than personal. They are *likely* — but not
  guaranteed — to attract fewer policy restrictions than lists such as
  `private@<project>.apache.org`, which routinely contain PMC membership
  discussions, candidate evaluations, and other PII-heavy material. Do not
  treat this as a blanket green light: case-by-case judgement is still
  required.
- **Opt-in lists you are *sure* are fine.** Use `PONYMAIL_ALLOWED_LISTS`
  to allow only lists where you have permission, the content is safe to
  process, and your LLM environment matches that risk level.

### How the block works

Two layers of defense:

1. **Pattern blocks** (pre-fetch). Well-known private list names are blocked
   before the API is called. See `PONYMAIL_RESTRICTED_LISTS` below.
2. **Private-flag block** (post-fetch). PonyMail tags private lists and
   messages with `private: true`. Any response carrying that flag is blocked,
   even if the list name doesn't match a known pattern (catches unusually
   named PMC lists). For `get_mbox`, a metadata probe runs first since the
   mbox endpoint returns raw text.

**Default blocked patterns:**

- `private@` — all PMC-private lists (matches `private@` on any domain)
- `security@` — all project security lists
- `board@apache.org`, `members@apache.org`, `operations@apache.org`,
  `trademarks@apache.org`, `fundraising@apache.org`,
  `executive-officers@apache.org`, `president@apache.org`,
  `chairman@apache.org`, `secretary@apache.org`, `treasurer@apache.org`

**Pattern forms** (used in both `PONYMAIL_RESTRICTED_LISTS` and `PONYMAIL_ALLOWED_LISTS`):

| Form | Meaning |
|------|---------|
| `prefix@` | Any list with that local part (e.g. `private@` matches every `private@*`) |
| `@domain` | All lists in that domain |
| `prefix@domain` | Exact match |

Setting `PONYMAIL_RESTRICTED_LISTS` replaces the default patterns entirely.
To preserve a default pattern while adding your own, include it in the value.

### Opting in to private lists

If you are authorized to access a private list, opt in with
`PONYMAIL_ALLOWED_LISTS`. Allow-listed lists bypass **both** the pattern
block and the private-flag block.

The expected first users of this MCP are project committers triaging their
own project's `security@` list — the content is technical/operational
("work-related" CVE coordination) and tends to be lower PII risk than
membership-style `private@` lists, while still requiring authentication.
Opting in to your project's `security@` is typically the simplest starting
point:

```
# Apache Airflow committer triaging their own security list
PONYMAIL_ALLOWED_LISTS="security@airflow.apache.org"

# Apache Arrow committer triaging their own security list
PONYMAIL_ALLOWED_LISTS="security@arrow.apache.org"

# Combine multiple lists (comma-separated)
PONYMAIL_ALLOWED_LISTS="security@airflow.apache.org,security@arrow.apache.org"

# Opt in to every list in a domain you administer
PONYMAIL_ALLOWED_LISTS="@yourproject.apache.org"
```

Only opt in to a list if you are authorized to access it *and* your LLM
environment is appropriate for the content (see "Why this matters" above —
hosted vs. local LLM, prompt logging, etc.).

Use `list_restrictions` from the MCP client to see the active policy and
what is currently allow-listed.

## Authentication (Private Lists)

Public lists work without authentication. For private/restricted lists, you have two options:

### Option 1: OAuth via Login Tool (Recommended)

Use the `login` tool from within your MCP client. It will:

1. Open a local helper page at `http://localhost:39817`
2. The page links to PonyMail's login page — log in with your ASF LDAP credentials
3. After logging in, grab the session cookie (see below) and paste it into the form
4. The server validates the cookie and caches it to `~/.ponymail-mcp/session.json`

**Finding the HttpOnly cookie:** The `ponymail` cookie is `HttpOnly`, so `document.cookie` and the Application tab won't show it. To find it:
1. On `lists.apache.org` (while logged in), open DevTools (`Cmd+Option+I` / `F12`)
2. Go to the **Network** tab and reload the page
3. Click on any request (e.g., the page itself, or any `api/` call)
4. In **Headers** → **Request Headers** → find the **Cookie:** line
5. Copy the `ponymail=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` part
### Option 2: Manual Cookie

1. Log into https://lists.apache.org in your browser
2. Open DevTools → Application → Cookies → copy the session cookie
3. Set the environment variable:
   ```
   PONYMAIL_SESSION_COOKIE="ponymail=abc123..."
   ```
4. Add it to your MCP server config's environment variables

Sessions expire after ~20 hours. Use `auth_status` to check, `logout` to clear.

## Usage Examples

Once connected, you can ask things like:

- "Search the dev@iceberg.apache.org list for messages about partition spec in the last 30 days"
- "Show me the available mailing lists"
- "Fetch email with ID xyz..."
- "Get the mbox archive for dev@httpd.apache.org for 2024-03"
