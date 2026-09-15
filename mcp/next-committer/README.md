# Next Committer Candidates

An AI-powered tool for Apache project PMCs to identify potential committer
and PMC candidates by analyzing public contribution data.

## What This Does

Given an Apache project name, this tool generates a structured report
identifying:

1. **Committer Candidates** — people who are not yet committers but show
   strong contribution patterns (code, mailing list engagement, design
   discussions)
2. **PMC Candidates** — existing committers who are not yet on the PMC but
   demonstrate PMC-level activity (release management, design leadership,
   mentoring)
3. **Recent Promotions** — people promoted in the last 12 months, as
   pipeline health evidence

The report uses **only publicly available data** — Apache PonyMail archives,
GitHub public API, and Apache Projects LDAP. No internal or proprietary data
is used. No vendor/employer affiliations are mentioned.

## How It Works

This is not a standalone program. It is a **prompt** designed to be used with
any AI assistant that supports the [Model Context Protocol
(MCP)](https://modelcontextprotocol.io/). The AI tool does the actual
analysis — the prompt provides the methodology.

The analysis follows these steps:

1. Fetch the current committer and PMC roster from Apache LDAP (with join
   dates for recent promotions)
2. Fetch release history to identify release managers
3. Discover all source repositories for the project
4. Scan the dev@ mailing list archives (last 2 years) for active
   non-committers
5. Fetch GitHub contributor statistics across all project repos
6. Cross-reference contributors against ASF LDAP for existing affiliations
7. Classify everyone into the correct section and write the report

## Prerequisites

### Required MCP Servers

This tool depends on two MCP servers that provide access to Apache
infrastructure data:

#### 1. ponymail-mcp

Provides access to Apache PonyMail mailing list archives.

- **Repository**: https://github.com/rbowen/ponymail-mcp
- **Tools used**: `search_list`, `get_email`, `get_thread`
- **Install**:
  ```bash
  git clone https://github.com/rbowen/ponymail-mcp.git
  cd ponymail-mcp
  npm install
  ```
- **Run**: `node index.js` (stdio MCP server)
- **Requirements**: Node.js 20+

#### 2. apache-projects-mcp

Provides access to Apache project metadata (committees, people, groups,
releases, repositories).

- **Repository**: https://github.com/rbowen/apache-projects-mcp
- **Tools used**: `get_committee`, `get_group_members`, `get_person`,
  `search_people`, `get_releases`, `get_repositories`
- **Install**:
  ```bash
  git clone https://github.com/rbowen/apache-projects-mcp.git
  cd apache-projects-mcp
  npm install
  ```
- **Run**: `node index.js` (stdio MCP server)
- **Requirements**: Node.js 20+

### Required Capabilities

Your AI tool must also be able to:

- **Fetch URLs** — to access the GitHub public API
  (`https://api.github.com/repos/apache/...`). Most AI tools provide this
  natively (e.g., a `url_fetch` or `web_request` tool). No authentication
  is required for the GitHub endpoints used, though a personal access token
  increases rate limits.

### Optional: GitHub Personal Access Token

The GitHub API allows 60 requests/hour without authentication, or 5,000/hour
with a token. For projects with many repositories or large contributor lists,
a token is recommended:

1. Go to https://github.com/settings/tokens
2. Generate a token with no special scopes (public repo access is the default)
3. Pass it in the `Authorization: Bearer {token}` header on GitHub API calls
4. Tell your AI tool to use this header (how to do this varies by tool)

## Usage

### One-Time Report

1. Start your AI tool with both MCP servers connected
2. Paste the contents of `PROMPT.md` into the conversation
3. Replace `{PROJECT}` with your project ID (e.g., `iceberg`, `spark`,
   `tinkerpop`)
4. The AI will execute the steps and produce a markdown report

### Batch Run (Multiple Projects)

You can modify the prompt to loop over multiple projects. Replace the
`{PROJECT}` placeholder with a list and add instructions to iterate:

```
Analyze the following projects, writing a separate report for each:
- projectA
- projectB
- projectC
```

### Scheduled Reports

If your AI tool supports scheduled/recurring tasks, you can run this monthly
or quarterly. Tracking reports over time shows candidates moving through the
pipeline.

## Output

The report is a self-contained Markdown document with this structure:

```
# Apache {Project} — Next Committer Candidates Report

Report metadata (date, committer count, PMC count, chair)

## Recent Promotions (Last 12 Months)
## Committer Candidates
  ### Tier 1 — Strong Candidates
  ### Tier 2 — Growing Contributors
## PMC Candidates
## Pipeline Health Assessment
```

### Pipeline Health Indicators

- 🟢 **Healthy** — Multiple strong candidates, active pipeline
- 🟡 **Moderate** — Some candidates but thin in places
- 🔴 **Concern** — Very few candidates, development concentrated among
  existing committers

## Sharing Reports

While these reports use only publicly available data sources, the output
concerns **project governance decisions** — specifically, who may or may not
be elected to committer or PMC membership. These decisions are the
responsibility of the PMC, and public discussion of individual candidates
can be harmful to the community.

**These reports should be treated as confidential guidance for the PMC.**

Suggested venue for discussion:

- **Your project's private@ mailing list ONLY** — this is where PMC
  membership and committer elections are discussed per ASF policy.

Do not post these reports to dev@, public wikis, or other public channels.
The PMC uses them as a discussion aid, not as a public ranking or scorecard.

## Limitations

- **GitHub-only code analysis** — projects using only Gitbox or SVN will
  have limited code contribution data from the GitHub API. The mailing
  list analysis still works.
- **Bot filtering is heuristic** — some bots may slip through, or
  legitimate contributors with bot-like names may be excluded. Review the
  output.
- **No private list access** — the ponymail-mcp server blocks private
  lists by default (and this is the correct behavior for this use case).
  Candidates are identified from public activity only.
- **Point-in-time snapshot** — the report reflects current data. Run
  periodically for trend analysis.
- **AI judgment calls** — tier placement and pipeline health assessment
  involve AI judgment. The PMC should use these as discussion starters,
  not definitive rankings.

## Contributing

This tool is part of the Apache Community Development (ComDev) project.

- **Mailing list**: dev@community.apache.org
- **Issues**: https://github.com/apache/comdev/issues
- **Improvements welcome** — especially around the classification
  methodology and report format.

## License

Licensed under the Apache License, Version 2.0.
