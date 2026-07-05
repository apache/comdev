# PonyMail MCP Server

An MCP (Model Context Protocol) server that provides access to the [Apache PonyMail](https://ponymail.apache.org/) mailing list archive API.

## Tools

| Tool | Description |
|------|-------------|
| `list_lists` | Get an overview of all available mailing lists and message counts |
| `search_list` | Search/browse a mailing list with filters (date, sender, subject, body, query) |
| `get_email` | Fetch a specific email by ID with full body and attachments |
| `get_thread` | Fetch a complete email thread (full tree + flat message list). Supports `find_parent` to navigate to thread root from any reply. |
| `get_source` | Fetch the raw RFC 2822 source of an email (original headers, MIME structure, encoded body) |
| `get_mbox` | Download mbox-formatted archive data for bulk export |
| `login` | Authenticate via ASF OAuth to access private mailing lists |
| `logout` | Clear cached credentials (session cookie and API token) |
| `auth_status` | Check current authentication status |
| `create_token` | Mint a long-term API token for programmatic access (requires an interactive `login` first) |
| `list_tokens` | List your API tokens (metadata only) |
| `revoke_token` | Revoke an API token by id |
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
| `PONYMAIL_API_SUFFIX` | `.json` | API endpoint suffix and method selector. `.json` (default) = POST with JSON body (native Foal). `.lua` = GET with query params (legacy compat for older deployments). |
| `PONYMAIL_SESSION_COOKIE` | *(none)* | Manual session cookie override (skips OAuth flow) |
| `PONYMAIL_API_TOKEN` | *(none)* | Long-term `pmt_…` API token sent as `Authorization: Bearer`. Preferred over the cookie; does not expire on the ~20h cookie schedule. |
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

Public lists work without authentication. For private/restricted lists you can
authenticate with **either** a session cookie **or** a long-term API token — both
are optional and only needed for private lists. If a token is configured it is
used in preference to the cookie.

### Long-term API tokens (recommended for automation)

PonyMail Foal supports personal API tokens (`pmt_…`) sent as an
`Authorization: Bearer` header. Unlike the session cookie, a token does **not**
expire on the ~20-hour cookie schedule, so it survives across sessions — ideal
for scripts and long-running MCP setups. A token grants the same access as the
account that created it. This requires a PonyMail server with API-token support
enabled (`tokens.enabled`).

Two ways to get one:

- **Mint it from this MCP (`create_token`).** First `login` interactively (the
  server only lets an interactive cookie session manage tokens — a token cannot
  mint more tokens). Then call `create_token` with an optional `description`,
  `scopes` (see below), and `lifetime_days` (`0` = never expires; omit for the
  server default, typically 30 days). The raw secret is shown **once** and
  cached to `~/.ponymail-mcp/token.json`, after which it is used automatically.
  List and revoke with `list_tokens` / `revoke_token`.
- **From the PonyMail web UI** (user menu → **API Tokens**), then hand it to the
  MCP via the `PONYMAIL_API_TOKEN` env var:
  ```
  PONYMAIL_API_TOKEN="pmt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  ```
  The env var wins over any cached token file.

**Scopes.** A token's access is the *intersection* of the owner's account
permissions and the scopes it was granted — a scope can only restrict access,
never widen it. `create_token` accepts a `scopes` list (default `["read"]`):

| Scope | Grants |
|-------|--------|
| `read` | Search/browse, fetch emails/threads/sources, download mbox, read preferences |
| `write` | Send email (compose) |
| `admin` | Administrative operations — hide/delete/edit (only effective for admin accounts) |

This MCP only issues **read** requests, so a `read` token covers everything it
does; grant `write`/`admin` only if the token will be handed to another client
that sends or manages mail. A request made with a token that lacks the required
scope gets a `403` from the server, which the MCP surfaces as a clear scope error.

**A scope is a *wish*, not a stored grant — permissions are re-evaluated live.**
The server does **not** freeze the owner's permissions into the token at
creation time. On every request it recomputes the effective access as the
intersection of the token's scope with the owner's **current** account
permissions *at that moment*. The scope is therefore a ceiling ("I wish to be
able to do X") that is only honoured while the account still holds those
permissions. Consequences:

- If the owner **loses** a permission (e.g. is removed from a private list or a
  moderator/admin role), every existing token instantly loses that access on
  the next request — no matter what scope it was minted with. There is nothing
  to expire or evict: a token is not a cached snapshot of permissions.
- If the owner **gains** a permission after the token was created, a token whose
  scope already covers it starts working for the new resource automatically —
  again, without re-issuing the token.
- Revoking a token (`revoke_token`) is still the way to kill a *specific*
  credential; changing what the *account* can do is handled entirely by the
  live intersection above.

**Enabling this is a per-instance, Infra-involved decision.** API-token support
is **disabled by default** (`tokens.enabled`), so it is off unless a deployment
opts in. Individual PonyMail instances (e.g. `mail.apache.org`) may choose not
to enable it at all, or to enable it with constraints such as a maximum token
lifetime — all of this is server-side configuration. Enabling it on an ASF
instance therefore needs to be coordinated with Infra.

Token management (`create_token` / `list_tokens` / `revoke_token`) always uses
the interactive cookie session, never a token. `logout` forgets the locally
cached token but does **not** revoke it server-side — use `revoke_token` for that.

### Option 1: `login` tool — paste from DevTools (Default, Recommended)

From your MCP client, call the `login` tool. It opens a local helper page at `http://localhost:39817` with a paste form:

1. On `lists.apache.org` (while logged in), open DevTools (`Cmd+Option+I` / `F12`).
2. Go to the **Network** tab and reload the page.
3. Click on any request (e.g. the document or any `api/` call).
4. In **Headers** → **Request Headers** → find the **Cookie:** line.
5. Copy the `ponymail=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` part and paste it into the form.

The cookie is validated against `/api/preferences.lua` and cached to `~/.ponymail-mcp/session.json`.

### Option 2: Cookie via environment variable

1. Get the cookie as above (DevTools → Network → Request Headers → Cookie).
2. Set the environment variable in your MCP server config:
   ```
   PONYMAIL_SESSION_COOKIE="ponymail=abc123..."
   ```

The env var always wins over the cached session file.

### Option 3 (OPT-IN, ADVANCED): auto-extract from Chrome cookie store

> [!CAUTION]
> **Only enable this if you are running this MCP server under additional isolation (sandboxing, a hardened launcher such as Apache Magpie, or equivalent) and you understand the security tradeoff. Do NOT enable it on a bare install.**
>
> When `PONYMAIL_AUTO_EXTRACT_COOKIE=1` is set, the `login` tool will, before showing the paste form, do **two things that grant the MCP server broad access to your system**:
>
> 1. **Read your local Chrome cookie database** (`~/Library/Application Support/Google/Chrome/<Profile>/Cookies` and the equivalent paths for Chromium-family browsers like Brave, Edge, Vivaldi, Arc, Opera). That file contains session cookies for **every site** you are logged in to in Chrome, not just lists.apache.org. The code only ever queries the single row for `host=lists.apache.org / name=ponymail`, but the OS-level read permission you are granting is "the entire cookie file".
> 2. **Access your macOS Keychain entry "Chrome Safe Storage"** via `/usr/bin/security` to obtain the AES key that decrypts cookie values. macOS will prompt you for keychain approval on first use; once granted, the MCP process can decrypt **any** cookie value in the Chrome DB.
>
> Both capabilities are far broader than this MCP server actually needs. The auto-extract path is a convenience that only makes sense when the MCP process itself is wrapped in a sandbox / security layer that mediates which files and keychain items it can touch. **If you do not have such a layer, leave `PONYMAIL_AUTO_EXTRACT_COOKIE` unset and use the paste flow.**
>
> Note: Firefox and Safari were evaluated and removed. Both browsers' anti-tracking features (Firefox Bounce Tracking Protection 109+; Safari ITP) hold OAuth-derived session cookies in memory only and never persist them to the on-disk cookie store, so there is nothing for an extractor to read.

To enable, add to your MCP server config:

```jsonc
{
  "env": {
    "PONYMAIL_AUTO_EXTRACT_COOKIE": "1"
    // ... other env vars
  }
}
```

When this opt-in is active, the server prints a multi-line warning to stderr at startup so you can see in your MCP client's logs that the elevated mode is on. If the cookie isn't found in Chrome (or decryption fails — for instance Chrome ≥ ~127 may use App-Bound Encryption `v20` which we can't unwrap from Node), the tool falls back to the paste form.

---

Cookie sessions expire after ~20 hours; API tokens do not. Use `auth_status` to
check which credential is active and whether it is valid, and `logout` to clear
the locally cached cookie and token.

## Usage Examples

Once connected, you can ask things like:

- "Search the dev@iceberg.apache.org list for messages about partition spec in the last 30 days"
- "Show me the available mailing lists"
- "Fetch email with ID xyz..."
- "Get the full thread for this email, navigating to the root"
- "Show me the raw source of that email"
- "What restrictions are currently active?"
- "Get the mbox archive for dev@httpd.apache.org for 2024-03"
