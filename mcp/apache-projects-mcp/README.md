# apache-projects-mcp

An MCP server for querying Apache Software Foundation project data from [`projects.apache.org/json`](https://projects.apache.org/json/).

This server provides a simple way for MCP clients to explore ASF committees, people, podlings, releases, LDAP groups, and repositories using data published by the ASF.

## Features

The server currently provides tools to:

- list and search Apache project committees  
- get detailed committee information  
- search for ASF committers and members  
- get details about a specific person by Apache ID  
- list current Incubator podlings  
- get release history for a project  
- list members of an ASF LDAP group  
- find source code repositories for a project  
- search across Apache top-level projects and podlings  
- return ASF-wide summary statistics  

## Data sources

All data is fetched from `https://projects.apache.org/json/foundation/` and cached in memory for 6 hours.

| File | Description |
|------|-------------|
| committees.json | Top-level project committees, including roster, chair, charter, and homepage |
| people.json | ASF committers and member status |
| people_name.json | Apache ID to full name mapping |
| groups.json | LDAP groups, including committer and PMC memberships |
| podlings.json | Current Apache Incubator podlings |
| releases.json | Project release history |
| repositories.json | Source code repository URLs |

## Available tools

| Tool | Description |
|------|-------------|
| list_committees | Browse or search project committees by name or keyword |
| get_committee | Get full PMC details, including roster, charter, and homepage |
| search_people | Search for ASF committers and members by Apache ID or name |
| get_person | Get details for a specific ASF person, including groups and PMC memberships |
| list_podlings | List current incubating projects |
| get_releases | Get release history for a project |
| get_group_members | List members of an ASF LDAP group |
| get_repositories | Find repositories for a project |
| search_projects | Search across top-level projects and podlings |
| project_stats | Return ASF-wide summary statistics |

## Requirements

- Node.js 18 or later  
- An MCP-compatible client  

## Installation

Clone the repository and install dependencies:

```
git clone https://github.com/rbowen/apache-projects-mcp.git
cd apache-projects-mcp
npm install
```

## Running the server

Run the server over stdio:

```
npm start
```

You can also run it directly:

```
node index.js
```

## Example MCP client configuration

Example stdio configuration:

```
{
  "command": "node",
  "args": ["/Users/yourname/apache-projects-mcp/index.js"]
}
```

Adjust the path to match your local checkout.

## Example questions

Once configured in an MCP client, you can ask things like:

- “List projects related to data or storage”  
- “Show me the PMC roster for Iceberg”  
- “Find ASF committers named Justin”  
- “What releases has Apache Spark had recently?”  
- “Which repositories match Kafka?”  
- “Search Apache projects related to security”  

## Notes and limitations

- Data comes from `projects.apache.org/json`, not directly from Git repositories, mailing lists, or podling status reports.  
- Podling data is limited to the current contents of `podlings.json`.  
- Data is cached for 6 hours in memory, so updates on the source side may not appear immediately.  