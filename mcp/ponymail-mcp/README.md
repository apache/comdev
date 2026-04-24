# PonyMail MCP Server

An MCP (Model Context Protocol) server that provides access to the [Apache PonyMail](https://ponymail.apache.org/) mailing list archive API. Public lists only.

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

## Usage Examples

Once connected, you can ask things like:

- "Search the dev@iceberg.apache.org list for messages about partition spec in the last 30 days"
- "Show me the available mailing lists"
- "Fetch email with ID xyz..."
- "Get the mbox archive for dev@httpd.apache.org for 2024-03"
