# Next Committer Candidates — AI Prompt

Use this prompt (or adapt it) with your MCP-capable AI assistant to generate
a "Next Committer Candidates" report for your Apache project.

## Prerequisites

Your AI tool must have access to two MCP servers:

1. **ponymail-mcp** — provides `search_list`, `get_email`, `get_thread`, `get_mbox`
2. **apache-projects-mcp** — provides `get_committee`, `get_group_members`, `get_person`, `search_people`, `get_releases`, `get_repositories`

Additionally, the AI tool needs the ability to fetch URLs (for GitHub API access).

## The Prompt

Copy and paste the following into your AI assistant, replacing `{PROJECT}` with
your Apache project ID (e.g., `iceberg`, `spark`, `tinkerpop`):

---

```
You are an Apache committer pipeline analyst. Generate a "Next Committer
Candidates" report for Apache {PROJECT} using ONLY public data.

## Data Sources — PUBLIC ONLY

This report uses ONLY publicly available data:
- Apache PonyMail (public mailing list archives)
- GitHub public API (contributor stats, merged PRs)
- Apache Projects LDAP (public committee/committer rosters, release history)

Do NOT include any internal company data, proprietary information, or
vendor/employer affiliations. Focus exclusively on open source contributions.

## Step 1: Get current committers, PMC, and recent promotions (DO THIS FIRST)

- Use get_committee("{PROJECT}") — this returns the full PMC roster WITH join
  dates. Record join dates to identify recent promotions (last 12 months).
- Use get_group_members("{PROJECT}") for committers.
- Use get_group_members("{PROJECT}-pmc") for PMC members.
- Store these lists. Every person you encounter MUST be checked against them
  before being placed in a section.

## Step 2: Get release history (PMC candidate signal)

- Use get_releases("{PROJECT}") to get recent releases.
- Note release managers — managing a release is strong evidence for PMC
  readiness.

## Step 3: Find all repositories for the project

- Use get_repositories("{PROJECT}") to discover all repos (some projects have
  multiple: main, website, docs, language-specific implementations).
- Get GitHub contributor stats from ALL relevant repos.

## Step 4: Scan mailing list activity (last 2 years)

- Use search_list to scan dev@{PROJECT}.apache.org.
- Scan at least 8 representative months (every 3 months) with quick=true to
  get participant statistics.
- For the top 10 non-committers by message count, do targeted from: searches
  for accurate counts.
- Use get_thread for promising candidates to assess depth of design
  engagement (leading discussions vs. single replies).
- PUBLIC lists only.

## Step 5: Get GitHub contributors

- Fetch https://api.github.com/repos/apache/{REPO}/contributors?per_page=100
  for EACH repository found in Step 3.
- Filter out bots (names ending in [bot], or well-known bot accounts like
  dependabot, renovate, etc.).
- Merge contributor counts across repos for the same person.

## Step 6: Cross-reference with ASF LDAP

- Use search_people for prominent contributors to check if they have ASF
  accounts and committership on OTHER projects.
- Use get_person for anyone with an ASF ID to see their full group
  memberships (reveals cross-project committership, ASF Member status).

## Step 7: Classify and write the report

CRITICAL classification rules (based on Step 1 data):

- If a person is ALREADY a committer on this project AND already on the
  PMC → exclude entirely (they are done)
- If a person is ALREADY a committer on this project but NOT on the PMC
  → PMC Candidate section
- If a person is NOT a committer on this project → Committer Candidate
  section
- If a person was recently promoted (from get_committee join dates, within
  last 12 months) → Recent Promotions section

PMC Candidate evidence to look for:
- Release management (from Step 2)
- Leading design discussions on dev@ (not just participating)
- Mentoring new contributors
- Community building (organizing events, writing docs)
- Cross-project ASF involvement

## Report Format

Use this structure:

# Apache {PROJECT} — Next Committer Candidates Report

**Report Date:** {today's date}
**Project:** Apache {PROJECT}
**Current Committers:** {count} | **PMC Members:** {count}
**Chair:** {name} ({apache_id})

---

## Recent Promotions (Last 12 Months)

{People who recently became committers or PMC members, with dates}

---

## Committer Candidates

People who are NOT currently committers on this project but show strong
contribution patterns.

### Tier 1 — Strong Candidates (Ready for Discussion)

| # | Name | GitHub | Contributions | Evidence |
|---|------|--------|---------------|----------|

### Tier 2 — Growing Contributors

| # | Name | GitHub | Contributions | Evidence |
|---|------|--------|---------------|----------|

---

## PMC Candidates

People who ARE already committers on this project but not yet on the PMC,
and show PMC-level activity (release management, design leadership,
mentoring, community building).

| # | Name | Apache ID | Evidence |
|---|------|-----------|----------|

---

## Pipeline Health Assessment

{Status emoji and summary of overall pipeline health}

## Rules

- NEVER list someone as a "Committer Candidate" if they are already a
  committer. Double-check against Step 1 data.
- NEVER list someone as a "PMC Candidate" if they are already on the PMC.
- Do NOT mention company/vendor affiliations. These reports are intended
  for public publication. Focus on a person's open source contributions
  (mailing list activity, code contributions, release management, design
  engagement), not their employer.
- ALL data from public sources. No internal or proprietary information.
- Be honest — if fewer candidates exist, say so. Empty sections are fine.
```

---

## Customization

You can adapt this prompt to your needs:

- **Change the time window** — adjust "last 2 years" and "last 12 months"
  to match your project's cadence.
- **Add additional repos** — if your project has repos outside the `apache/`
  GitHub org (e.g., a mirror, or a separate ecosystem project), add them to
  Step 5.
- **Scan user@ list too** — for projects where contributors start by helping
  users, add `user@{PROJECT}.apache.org` to the mailing list scan.
- **Adjust tier criteria** — define what "Tier 1" vs "Tier 2" means for your
  project's culture (some projects weight code heavily, others value community
  participation equally).

## Running on a Schedule

If your AI tool supports scheduled/recurring tasks, you can run this monthly
or quarterly. The report is most useful when tracked over time — you can see
candidates moving up through the tiers.

## Sharing Results

While these reports use only publicly available data sources, the output
concerns **project governance decisions** — specifically, who may or may not
be elected to committer or PMC membership. These decisions are the
responsibility of the PMC, and public discussion of individual candidates
can be harmful to the community.

**These reports should be treated as confidential guidance for the PMC.**
Discuss them on your project's **private@ mailing list only** — this is
where committer/PMC elections happen per ASF policy. Do not post to dev@,
public wikis, or other public channels.
