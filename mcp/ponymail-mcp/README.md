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
| `PONYMAIL_RESTRICTED_LISTS` | *(see below)* | Comma-separated list of list patterns to block. Set to `none` to disable. |

## Restricted Lists

Some mailing lists contain confidential Foundation business or PMC-private
discussions. Even when an authenticated session would grant access, this
server blocks them by default so an LLM cannot accidentally ingest them.

**Default blocked patterns:**

- `private@` — all PMC-private lists (matches `private@` on any domain)
- `security@` — all project security lists
- `board@apache.org`, `members@apache.org`, `operations@apache.org`,
  `trademarks@apache.org`, `fundraising@apache.org`,
  `executive-officers@apache.org`, `president@apache.org`,
  `chairman@apache.org`, `secretary@apache.org`, `treasurer@apache.org`

**Pattern forms** (used in `PONYMAIL_RESTRICTED_LISTS`):

| Form | Meaning |
|------|---------| 
| `prefix@` | Any list with that local part (e.g. `private@` matches every `private@*`) |
| `@domain` | All lists in that domain |
| `prefix@domain` | Exact match |

Setting `PONYMAIL_RESTRICTED_LISTS` replaces the defaults entirely. To
preserve a default pattern while adding your own, include it in the value.
Use `list_restrictions` from the MCP client to see what is currently active.

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
