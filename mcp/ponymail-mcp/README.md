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

## Setup

```bash
cd /Users/rcbowen/devel/ponymail-mcp
npm install
```

## Configure in Amazon Quick

1. Open **Settings → Capabilities → MCP Servers**
2. Click **Add MCP / Skill** → **Local (stdio)**
3. Fill in:
   - **Name**: `ponymail`
   - **Command**: `node`
   - **Args**: `/Users/rcbowen/devel/ponymail-mcp/index.js`
4. Click **Save**

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PONYMAIL_BASE_URL` | `https://lists.apache.org` | Base URL of the PonyMail instance |
| `PONYMAIL_SESSION_COOKIE` | *(none)* | Manual session cookie override (skips OAuth flow) |

## Authentication (Private Lists)

Public lists work without authentication. For private/restricted lists, you have two options:

### Option 1: Automated OAuth (Recommended)

Use the `login` tool from within Amazon Quick. It will:

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
