# PonyMail MCP Server

An MCP (Model Context Protocol) server that provides access to the [Apache PonyMail](https://ponymail.apache.org/) mailing list archive API.

## Tools

| Tool | Description |
|------|-------------|
| `list_lists` | Get an overview of all available mailing lists and message counts |
| `search_list` | Search/browse a mailing list with filters (date, sender, subject, body, query). Supports `mode: "threads"` to list one entry per thread (thread starters with reply counts and continuation hints). |
| `get_email` | Fetch a specific email by ID with full body and attachment metadata (name, type, size, hash) |
| `save_attachments` | Download an email's attachments into a local directory, decrypting and extracting password-protected ZIPs when given the password; returns only names, sizes, types and SHA-256 digests, never the contents. See [Saving attachments](#saving-attachments). |
| `get_thread` | Fetch a complete email thread (full tree + flat message list). Supports `find_parent` to navigate to thread root from any reply. |
| `get_source` | Fetch the raw RFC 2822 source of an email (original headers, MIME structure, encoded body) |
| `get_mbox` | Download mbox-formatted archive data for bulk export |
| `login` | Authenticate via ASF OAuth to access private mailing lists — log in in a temporary browser window and the session is picked up automatically (`method`: `cookie` or `token`) |
| `logout` | Clear the cached session cookie or token (a token is also revoked on the server) |
| `auth_status` | Check current authentication status |
| `list_restrictions` | Show mailing list patterns blocked by server policy |

## Setup

Requires Node.js 22.21+ (22.x line) or 24+; Node 23 lacks the env proxy support.

```bash
cd ponymail-mcp
npm install
```

## Configure in Your MCP Client

Add a local (stdio) MCP server with:

- **Command**: `node`
- **Args**: `/path/to/ponymail-mcp/index.js`

Refer to your MCP client's documentation for how to add a local stdio server.

### Behind a proxy

Node's built-in `fetch` only honors `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`
when `NODE_USE_ENV_PROXY=1` is set at process startup. Set both in the
server's `env` block:

```json
"env": {
  "HTTPS_PROXY": "http://proxy.example.com:3128",
  "NODE_USE_ENV_PROXY": "1"
}
```

The server prints a warning to stderr if a proxy variable is set but Node's
proxy support is off. Only the value `1` enables it; `--use-env-proxy` in
`NODE_OPTIONS` works too.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PONYMAIL_BASE_URL` | `https://lists.apache.org` | Base URL of the PonyMail instance |
| `PONYMAIL_API_SUFFIX` | `.json` | API endpoint suffix and method selector. `.json` (default) = POST with JSON body (native Foal). `.lua` = GET with query params (legacy compat for older deployments). |
| `PONYMAIL_SESSION_COOKIE` | *(none)* | Manual session cookie override (skips OAuth flow) |
| `PONYMAIL_BROWSER` | *(auto-detect)* | Chromium-family browser used by `login` (Chrome, Edge, Brave, Chromium). `none` = always use the paste form. |
| `PONYMAIL_BROWSER_PROFILE` | *(temporary)* | `persistent` keeps the `login` browser profile in `~/.ponymail-mcp/browser-profile` (or give an absolute path) so the browser can save your ASF password between logins; 2FA is still asked every time. See [Keeping the login between sessions](#keeping-the-login-between-sessions-opt-in). |
| `PONYMAIL_AUTH_METHOD` | `cookie` | Default `login` method: `cookie` or `token`. See [Option 4](#option-4-future-browser-approved-session-token). |
| `PONYMAIL_TOKEN` | *(none)* | Manual session token override (`pmt_…`). Takes precedence over `PONYMAIL_SESSION_COOKIE`. |
| `PONYMAIL_RESTRICTED_LISTS` | *(see below)* | Comma-separated patterns to block pre-fetch. Set to `none` to clear pattern blocks. |
| `PONYMAIL_ALLOWED_LISTS` | *(none)* | Comma-separated opt-in patterns. Lists matching these bypass all blocks. |
| `PONYMAIL_ATTACHMENT_DIRS` | *(none — saving disabled)* | Comma-separated absolute directories `save_attachments` may write into (each root, or a directory inside one). See [Saving attachments](#saving-attachments). |

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

Public lists work without authentication. For private/restricted lists:

### Option 1: `login` tool — log in in the browser (Default, Recommended)

From your MCP client, call the `login` tool. It opens the `lists.apache.org`
login page in a **temporary Chrome / Edge / Brave / Chromium window**. Log in
there as usual (ASF OAuth). As soon as PonyMail has logged you in, the MCP
server picks up the session cookie from that window, validates it against
`/api/preferences.lua`, caches it to `~/.ponymail-mcp/session.json` and closes
the window. No DevTools, no copy & paste.

How it works and what it can see:

- The window runs with a **fresh, temporary browser profile** that is deleted
  afterwards. Your everyday browser profile, its cookies and saved passwords
  are never touched — which is also why you have to log in in that window even
  if you are already logged in to `lists.apache.org` in your normal browser.
- The MCP server talks to that window over the DevTools protocol on a private
  pipe (`--remote-debugging-pipe`), not a network port, and only reads the
  `ponymail` cookie for the PonyMail host.
- A redirect straight back to the MCP server isn't possible: ASF OAuth only
  redirects to registered ASF hosts, and the PonyMail cookie is HttpOnly, so
  page scripts and bookmarklets cannot read it.
- `login` waits up to 5 minutes; closing the window cancels the login.

The browser is auto-detected. Set `PONYMAIL_BROWSER` to the path of a
Chromium-family executable to pick one, or to `none` to always use the paste
form below.

#### Keeping the login between sessions (opt-in)

The PonyMail session expires after ~20 hours, after which `login` opens a
fresh window and you log in again. To avoid retyping your password, keep the
browser profile:

```jsonc
"env": { "PONYMAIL_BROWSER_PROFILE": "persistent" }
```

The profile then lives in `~/.ponymail-mcp/browser-profile` (owner-only), or
at an absolute path you give instead of `persistent`. You can let the
browser's password manager save your ASF password there, so the next `login`
fills it in. The profile's cookies are cleared every time the login window
closes, so the ASF OAuth session is not kept: every `login` still asks for
2FA, and once the PonyMail session (~20 hours) has expired nothing in the
profile can log in for you.

What protects it:

- **Encrypted at rest.** A kept profile uses the OS credential store (macOS
  Keychain, Linux keyring) — not the mock store used for throwaway profiles —
  so its cookies and saved passwords are encrypted with a key that only the
  browser can read without an OS prompt.
- **Not handed to the LLM.** The MCP server only returns "logged in as …" to
  the client — never the cookie or the password.
- **Outside the agent sandbox.** Keep `~/.ponymail-mcp/` out of the read
  allowlist of your agent sandbox (it already holds `session.json`), so agent
  shell commands cannot read the profile.

What it does **not** protect against: anything that can run commands outside
a sandbox as your user can start the browser on that profile and have it
fill in the saved password; it still needs your 2FA to log in. Approve
sandbox-bypass requests with that in mind. Delete the directory to forget the
saved password; `logout` clears the cached session cookie.

Only one browser can use the profile at a time — if a window from a previous
`login` is still open, close it before calling `login` again.

### Option 1b: paste from DevTools (fallback)

If no Chromium-family browser is found (or `PONYMAIL_BROWSER=none`), `login`
opens a local helper page at `http://localhost:39817` with a paste form instead:

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
> When `PONYMAIL_AUTO_EXTRACT_COOKIE=1` is set, the `login` tool will, before opening the login window, do **two things that grant the MCP server broad access to your system**:
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

When this opt-in is active, the server prints a multi-line warning to stderr at startup so you can see in your MCP client's logs that the elevated mode is on. If the cookie isn't found in Chrome (or decryption fails — for instance Chrome ≥ ~127 may use App-Bound Encryption `v20` which we can't unwrap from Node), the tool falls back to the browser login window (Option 1).

### Option 4 (FUTURE): browser-approved session token

> [!NOTE]
> **Not available on lists.apache.org yet.** This method needs a PonyMail
> Foal release with short-term session tokens, and the ASF deploying it for
> lists.apache.org with tokens enabled (`tokens.enabled` in `ponymail.yaml`).
> Until then, `login` with `method: "token"` checks the server first and
> reports that it does not support session tokens, without opening a browser.
> Use Option 1 in the meantime.

With `method: "token"` (or `PONYMAIL_AUTH_METHOD=token`), `login` does not
touch cookies at all:

1. The MCP server starts a one-shot listener on a random `127.0.0.1` port
   and opens `https://lists.apache.org/token.html` in your browser.
2. If needed, you log in to PonyMail as usual. The page shows who you are
   logged in as, which client is asking (`ponymail-mcp`) and for how long,
   and asks you to **Approve** or **Deny**.
3. On approval, PonyMail mints a token and hands it back to the local
   listener (a form POST to `127.0.0.1`, checked against a random `state`
   value the MCP generated). The token is validated and cached in
   `~/.ponymail-mcp/session.json` (owner-only permissions).

The token is sent as `Authorization: Bearer pmt_…`. Compared to the cookie:

- **Short-lived** — an hour by default, capped by the server.
- **Read-only** — it cannot send email or use the admin console.
- **Bound to your browser session** — logging out of PonyMail in the browser
  revokes it; `logout` in the MCP revokes just the token, not your browser
  session.
- **Never exposes the session cookie** — nothing is copied out of DevTools
  or the browser's cookie store.

You can also approve a token manually by opening `token.html` without a
`redirect_uri` and set it as `PONYMAIL_TOKEN`.

---

Cookie sessions expire after ~20 hours; session tokens at the time the server
set. Use `auth_status` to check, `logout` to clear.

## Saving attachments

`get_source` and `get_mbox` truncate their output, so an attachment cannot be
recovered from them. `save_attachments` downloads an email's attachments
through PonyMail's attachment endpoint and writes them to disk instead:

- **Saving is off until you choose where.** Set `PONYMAIL_ATTACHMENT_DIRS` to
  the comma-separated absolute directories the server may write into; without
  it the tool refuses every call. Keep the list short, usually one directory,
  and never your home directory, a repository checkout, or a directory
  holding configuration or credentials. The MCP server usually runs outside
  the agent's sandbox, so this list, not the sandbox, is what limits where it
  writes.
- **Make the directory read-only to the agent.** The agent should be able to
  read the saved files but not change anything under the directory: only this
  server writes there. Node has no `openat()`, so the checks below are made
  on paths, and a caller that can rename directories under the root while a
  save runs could race them into writing elsewhere. A directory the caller
  cannot write leaves nothing to race. In Claude Code's sandbox, for example,
  choose a directory the sandbox can read (such as one under `~/.cache/`) and
  add an `Edit(<directory>/**)` rule to `permissions.deny`, which also denies
  sandboxed commands writing to, or renaming, that directory.
- Use a directory under your own home, not a shared one such as `/tmp`. At
  start the server refuses a root that is a symlink, is not owned by you, is
  writable by group or others, or sits below a directory owned by another
  user or writable by group or others (other than a sticky one such as
  `/tmp`). The same ownership and permission rules apply to every component
  of the path as configured, symlinks included, so a directory or link
  someone else planted is never trusted.
- The roots are created (mode `0700`) and pinned when the server starts: their
  canonical path and identity are recorded then, and a root that is later
  replaced, moved, or turned into a symlink makes the tool refuse to save
  until the server restarts.
- `dir` must be an absolute path with no `.` or `..` segments, and must be one
  of those roots or a directory inside one. Symlinks are resolved before the
  check, both before and after the directory is created. After the file is
  created, and before anything is written to it, the server confirms the
  directory is still the one it checked and the file is still the one it
  opened, so a directory swapped for a symlink mid-save normally receives no
  bytes (at most an empty file); these are defence in depth behind the
  read-only directory above, not a replacement for it. A missing `dir` is
  created (mode `0700`); files are created with mode `0600`.
- Filenames come from the sender, so they are reduced to ASCII
  `[A-Za-z0-9._-]` (accents folded, everything else non-ASCII dropped), with no
  path separators, no `..` and no leading dot. A name with nothing usable left
  becomes `attachment-<hash>`, and Windows device names (`CON`, `NUL.txt`,
  `COM1`, ...) get a leading `_`.
- Existing files are never overwritten or written through when they are a symlink: a
  name already present gets a numbered sibling (`repro-1.java`).
- Each download is checked against the size and SHA-256 hash PonyMail
  reports; a mismatch is reported and nothing is written. The body is read
  incrementally and the download is cancelled as soon as it passes the
  reported size, or 50 MB when no size is reported; attachments reported as
  larger than 50 MB are skipped.
- `hashes` (from `get_email`) limits the download to some of the attachments.

### Encrypted attachments

Security reports often send the proof of concept as a password-protected ZIP,
with the password in the message text, so mail filters neither strip nor run
it. Each saved file is checked for its format, and the result says whether it
is a ZIP (encrypted or not), 7z, RAR or PGP message.

- With `password`, ZIP attachments (ZipCrypto or AES) are decrypted and
  extracted into `<name>-extracted/` next to the archive. The password is
  never echoed in the result. A wrong password is reported; the archive
  itself stays saved.
- Extracted files go through the same writer as attachments: the same roots,
  the same filename rules applied to every path component, no overwrites.
  Symlinks and other special entries are skipped, never created. An archive
  whose entry names try to leave the directory (`../`, absolute paths) is not
  extracted at all.
- At most 1000 entries (directories included) are read and 200 MB extracted
  per archive, and an entry is cut off as soon as it inflates past its
  declared size, so a decompression bomb or an archive of countless tiny
  entries does not exhaust the disk or memory. Each entry's CRC-32 is checked,
  so a wrong password never yields a garbage file.
- Names that sanitize to the same path as a directory (`config` and
  `.config/x`) get a numbered name instead of blocking the directory.
- The result lists at most 50 extracted files and 50 skipped entries, with
  names cut to 120 characters, and counts the rest.
- 7z, RAR and PGP files are saved but not decrypted; open those in an
  isolated environment.
- The same list restrictions as `get_email` apply.

The tool result never contains the attachment bytes, so a PoC or archive does
not land in the model's context. Treat the saved files as untrusted input:
inspect them as data, and do not run them outside an isolated environment.

## Usage Examples

Once connected, you can ask things like:

- "Search the dev@iceberg.apache.org list for messages about partition spec in the last 30 days"
- "List the discussion threads started on dev@community.apache.org last month"
  (uses `mode: "threads"`, which overrides `quick`;
  threading only spans the queried timespan,
  so replies to older messages show up as thread starters marked as possible continuations)
- "Show me the available mailing lists"
- "Fetch email with ID xyz..."
- "Get the full thread for this email, navigating to the root"
- "Show me the raw source of that email"
- "Save that email's attachments to ~/.cache/ponymail-attachments/report-1"
  (with `PONYMAIL_ATTACHMENT_DIRS` set to that directory's absolute path)
- "Save the attachments of that report and unpack the ZIP with the password from the message"
- "What restrictions are currently active?"
- "Get the mbox archive for dev@httpd.apache.org for 2024-03"
