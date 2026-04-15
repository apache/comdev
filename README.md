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

## Usage Examples

Once connected, you can ask things like:

- "Search the dev@iceberg.apache.org list for messages about partition spec in the last 30 days"
- "Show me the available mailing lists"
- "Fetch email with ID xyz..."
- "Get the mbox archive for dev@httpd.apache.org for 2024-03"
