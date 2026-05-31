#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const BASE_URL = "https://projects.apache.org/json";

// ---------------------------------------------------------------------------
// Data cache — fetched on first use, refreshed every 6 hours
// ---------------------------------------------------------------------------

const cache = {};
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

const DATA_SOURCES = {
  committees:   `${BASE_URL}/foundation/committees.json`,
  people:       `${BASE_URL}/foundation/people.json`,
  people_name:  `${BASE_URL}/foundation/people_name.json`,
  releases:     `${BASE_URL}/foundation/releases.json`,
  groups:       `${BASE_URL}/foundation/groups.json`,
  podlings:     `${BASE_URL}/foundation/podlings.json`,
  repositories: `${BASE_URL}/foundation/repositories.json`,
};

async function getData(key) {
  const now = Date.now();
  if (cache[key] && (now - cache[key].ts) < CACHE_TTL) {
    return cache[key].data;
  }
  const url = DATA_SOURCES[key];
  if (!url) throw new Error(`Unknown data source: ${key}`);

  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${key}: HTTP ${resp.status}`);
  }
  const data = await resp.json();
  cache[key] = { data, ts: now };
  return data;
}

// Warm all caches
async function warmCache() {
  const results = {};
  for (const key of Object.keys(DATA_SOURCES)) {
    try {
      results[key] = await getData(key);
    } catch (e) {
      // Non-fatal — tool will retry on demand
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeSearchText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactSearchText(text) {
  return normalizeSearchText(text).replace(/\s+/g, "");
}

function rankedMatch(text, query) {
  if (!query) return 0;

  const normalizedText = normalizeSearchText(text);
  const normalizedQuery = normalizeSearchText(query);
  const compactText = compactSearchText(text);
  const compactQuery = compactSearchText(query);

  const variants = [
    [normalizedText, normalizedQuery],
    [compactText, compactQuery],
  ];

  let best = Infinity;
  for (const [candidate, search] of variants) {
    if (!search) continue;
    const tokens = candidate.split(" ").filter(Boolean);
    if (candidate === search) best = Math.min(best, 0);
    else if (tokens.includes(search)) best = Math.min(best, 0);
    else if (candidate.startsWith(search)) best = Math.min(best, 1);
    else if (tokens.some((token) => token.startsWith(search))) {
      best = Math.min(best, 1);
    } else if (candidate.includes(search)) best = Math.min(best, 2);
  }

  return best;
}

function bestSearchRank(fields, query) {
  return fields.reduce((best, field, index) => {
    const rank = rankedMatch(field, query);
    return Math.min(best, Number.isFinite(rank) ? rank * 10 + index : Infinity);
  }, Infinity);
}

function truncateList(items, max = 50) {
  if (items.length <= max) return { items, truncated: false };
  return { items: items.slice(0, max), truncated: true, total: items.length };
}

function makeResponse(text, structuredContent) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

function makeTextResponse(text) {
  return {
    content: [{ type: "text", text }],
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "apache-projects",
  version: "1.0.0",
});

// --- Tool: list_committees --------------------------------------------------
server.tool(
  "list_committees",
  "List Apache project committees (PMCs). Optionally filter by name or keyword. " +
    "Returns committee ID, name, short description, chair, and established date.",
  {
    query: z.string().optional().describe(
      "Search query to filter by name, description, or charter text"
    ),
    limit: z.number().optional().describe("Max results to return (default 50)"),
  },
  async ({ query, limit }) => {
    const committees = await getData("committees");
    const max = limit || 50;

    let results = committees;
    if (query) {
      results = committees
        .map((c) => ({
          committee: c,
          rank: bestSearchRank(
            [c.name || "", c.id || "", c.shortdesc || "", c.charter || ""],
            query
          ),
        }))
        .filter(({ rank }) => Number.isFinite(rank))
        .sort((a, b) =>
          a.rank - b.rank ||
          (a.committee.name || "").localeCompare(b.committee.name || "")
        )
        .map(({ committee }) => committee);
    }

    const { items, truncated, total } = truncateList(results, max);
    const lines = [];
    if (query) {
      lines.push(`## Committees matching "${query}" (${results.length} found)`);
    } else {
      lines.push(`## Apache Committees (${committees.length} total)`);
    }
    lines.push("");

    for (const c of items) {
      lines.push(
        `- **${c.name}** (${c.id}) — ${c.shortdesc || "no description"}`
      );
      lines.push(`  Chair: ${c.chair} | Est: ${c.established} | ${c.homepage || ""}`);
    }

    if (truncated) {
      lines.push(`\n... showing ${max} of ${total} results. Use a query to narrow down.`);
    }

    return makeResponse(lines.join("\n"), {
      query: query || null,
      count: results.length,
      shown: items.length,
      truncated: !!truncated,
      committees: items.map((c) => ({
        id: c.id,
        name: c.name,
        shortdesc: c.shortdesc || null,
        chair: c.chair || null,
        established: c.established || null,
        homepage: c.homepage || null,
      })),
    });
  }
);

// --- Tool: get_committee ----------------------------------------------------
server.tool(
  "get_committee",
  "Get detailed info about a specific Apache committee/PMC, including full " +
    "roster with member names and dates, chair, charter, and homepage.",
  {
    id: z.string().describe(
      "Committee ID (e.g. 'iceberg', 'httpd', 'spark')"
    ),
  },
  async ({ id }) => {
    const committees = await getData("committees");
    const c = committees.find(
      (x) => x.id === id.toLowerCase() || x.group === id.toLowerCase()
    );

    if (!c) {
      return makeTextResponse(`Committee "${id}" not found.`);
    }

    const lines = [];
    lines.push(`# ${c.name}`);
    lines.push(`ID: ${c.id}`);
    lines.push(`Chair: ${c.chair}`);
    lines.push(`Established: ${c.established}`);
    lines.push(`Homepage: ${c.homepage || "N/A"}`);
    lines.push(`Reporting cycle: ${c.reporting || "N/A"}`);
    lines.push(`Short description: ${c.shortdesc || "N/A"}`);
    lines.push("");
    lines.push("## Charter");
    lines.push(c.charter || "No charter available.");
    lines.push("");

    let roster = [];
    if (c.roster) {
      const members = Object.entries(c.roster);
      members.sort((a, b) => a[1].name.localeCompare(b[1].name));
      roster = members.map(([uid, info]) => ({
        id: uid,
        name: info.name || uid,
        joined: info.date || null,
      }));

      lines.push(`## PMC Roster (${members.length} members)`);
      for (const member of roster) {
        lines.push(`- ${member.name} (${member.id}) — joined ${member.joined || "unknown"}`);
      }
    }

    return makeResponse(lines.join("\n"), {
      id: c.id,
      name: c.name,
      group: c.group || null,
      chair: c.chair || null,
      established: c.established || null,
      homepage: c.homepage || null,
      reporting: c.reporting || null,
      shortdesc: c.shortdesc || null,
      charter: c.charter || null,
      roster,
    });
  }
);

// --- Tool: search_people ----------------------------------------------------
server.tool(
  "search_people",
  "Search for ASF committers/members by Apache ID or name. Returns matching " +
    "people with their full name, groups, and member status.",
  {
    query: z.string().describe(
      "Apache ID or name (partial match supported)"
    ),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ query, limit }) => {
    const people = await getData("people");
    const names = await getData("people_name");
    const max = limit || 20;
    const matches = [];
    for (const [uid, info] of Object.entries(people)) {
      const name = names[uid] || info.name || "";
      const rank = bestSearchRank([uid, name], query);
      if (Number.isFinite(rank)) {
        matches.push({ ...info, uid, name, rank });
      }
    }
    matches.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

    const { items, truncated, total } = truncateList(matches, max);
    const lines = [];
    lines.push(`## People matching "${query}" (${matches.length} found)`);
    lines.push("");

    for (const p of items) {
      const memberStr = p.member ? " [ASF Member]" : "";
      lines.push(`- **${p.name}** (${p.uid})${memberStr}`);
      lines.push(`  Groups: ${(p.groups || []).join(", ")}`);
    }

    if (truncated) {
      lines.push(`\n... showing ${max} of ${total} results.`);
    }

    return makeResponse(lines.join("\n"), {
      query,
      count: matches.length,
      shown: items.length,
      truncated: !!truncated,
      people: items.map((p) => ({
        id: p.uid,
        name: p.name,
        member: !!p.member,
        groups: p.groups || [],
      })),
    });
  }
);

// --- Tool: get_person -------------------------------------------------------
server.tool(
  "get_person",
  "Get full details about an ASF person by their Apache ID. Includes name, " +
    "group memberships (committer and PMC groups), and ASF member status.",
  {
    id: z.string().describe("Apache ID (e.g. 'rbowen', 'jmclean')"),
  },
  async ({ id }) => {
    const people = await getData("people");
    const names = await getData("people_name");
    const uid = id.toLowerCase();
    const person = people[uid];

    if (!person) {
      return makeTextResponse(`Person "${id}" not found.`);
    }

    const name = names[uid] || person.name || uid;
    const groups = person.groups || [];
    const pmcGroups = groups.filter((g) => g.endsWith("-pmc"));
    const committerGroups = groups.filter((g) => !g.endsWith("-pmc"));
    const pmcs = pmcGroups.map((g) => g.replace("-pmc", ""));

    const lines = [];
    lines.push(`# ${name} (${uid})`);
    lines.push(`ASF Member: ${person.member ? "Yes" : "No"}`);
    lines.push("");
    lines.push(`## Committer Groups (${committerGroups.length})`);
    lines.push(committerGroups.join(", ") || "None");
    lines.push("");
    lines.push(`## PMC Memberships (${pmcGroups.length})`);
    lines.push(pmcs.join(", ") || "None");

    return makeResponse(lines.join("\n"), {
      id: uid,
      name,
      member: !!person.member,
      groups,
      committerGroups,
      pmcGroups,
      pmcs,
    });
  }
);

// --- Tool: list_podlings ----------------------------------------------------
server.tool(
  "list_podlings",
  "List current Apache Incubator podlings with their description, start date, " +
    "and homepage.",
  {
    query: z.string().optional().describe("Filter by name or description"),
  },
  async ({ query }) => {
    const podlings = await getData("podlings");

    let entries = Object.entries(podlings);
    if (query) {
      entries = entries
        .map(([id, p]) => ({
          entry: [id, p],
          rank: bestSearchRank([p.name || "", id, p.description || ""], query),
        }))
        .filter(({ rank }) => Number.isFinite(rank))
        .sort((a, b) =>
          a.rank - b.rank ||
          (a.entry[1].name || "").localeCompare(b.entry[1].name || "")
        )
        .map(({ entry }) => entry);
    }

    const lines = [];
    lines.push(`## Apache Podlings (${entries.length})`);
    lines.push("");

    for (const [id, p] of entries) {
      lines.push(`- **${p.name}** (${id})`);
      lines.push(`  Started: ${p.started || "unknown"} | Homepage: ${p.homepage || "N/A"}`);
      const desc = (p.description || "").replace(/\s+/g, " ").trim();
      if (desc) lines.push(`  ${desc}`);
    }

    return makeResponse(lines.join("\n"), {
      count: entries.length,
      podlings: entries.map(([id, p]) => ({
        id,
        name: p.name || id,
        started: p.started || null,
        homepage: p.homepage || null,
        description: (p.description || "").replace(/\s+/g, " ").trim() || null,
      })),
    });
  }
);

// --- Tool: get_releases -----------------------------------------------------
server.tool(
  "get_releases",
  "Get release history for an Apache project. Returns release names and dates.",
  {
    project: z.string().describe(
      "Project ID (e.g. 'iceberg', 'spark', 'httpd')"
    ),
  },
  async ({ project }) => {
    const releases = await getData("releases");
    const key = project.toLowerCase();
    const projectReleases = releases[key];

    if (!projectReleases) {
      // Try fuzzy match
      const matches = Object.keys(releases).filter((k) => k.includes(key));
      if (matches.length > 0) {
        return makeResponse(
          `Project "${project}" not found. Did you mean: ${matches.join(", ")}?`,
          {
            project: key,
            count: 0,
            releases: [],
            suggestions: matches,
          }
        );
      }
      return makeTextResponse(`No releases found for "${project}".`);
    }

    const entries = Object.entries(projectReleases);
    // Sort by date descending
    entries.sort((a, b) => {
      const dateA = typeof a[1] === "string" ? a[1] : a[1].date || "";
      const dateB = typeof b[1] === "string" ? b[1] : b[1].date || "";
      return dateB.localeCompare(dateA);
    });

    const lines = [];
    lines.push(`## Releases for ${project} (${entries.length} total)`);
    lines.push("");

    for (const [name, info] of entries) {
      const date = typeof info === "string" ? info : info.date || "unknown";
      lines.push(`- **${name}** — ${date}`);
    }

    return makeResponse(lines.join("\n"), {
      project: key,
      count: entries.length,
      releases: entries.map(([name, info]) => ({
        name,
        date: typeof info === "string" ? info : info.date || null,
      })),
    });
  }
);

// --- Tool: get_group_members ------------------------------------------------
server.tool(
  "get_group_members",
  "List members of an ASF LDAP group (committer or PMC group). " +
    "Use '{project}' for committers, '{project}-pmc' for PMC members.",
  {
    group: z.string().describe(
      "Group name, e.g. 'iceberg' (committers) or 'iceberg-pmc' (PMC members)"
    ),
  },
  async ({ group }) => {
    const groups = await getData("groups");
    const names = await getData("people_name");
    const key = group.toLowerCase();

    const members = groups[key];
    if (!members) {
      // Try to suggest
      const matches = Object.keys(groups).filter((k) => k.includes(key));
      if (matches.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `Group "${group}" not found. Similar groups: ${matches.slice(0, 10).join(", ")}`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: `Group "${group}" not found.` }],
      };
    }

    const lines = [];
    lines.push(`## Group: ${key} (${members.length} members)`);
    lines.push("");

    const enriched = members.map((uid) => ({
      uid,
      name: names[uid] || uid,
    }));
    enriched.sort((a, b) => a.name.localeCompare(b.name));

    for (const m of enriched) {
      lines.push(`- ${m.name} (${m.uid})`);
    }

    return makeResponse(lines.join("\n"), {
      group: key,
      count: enriched.length,
      members: enriched.map((m) => ({
        id: m.uid,
        name: m.name,
      })),
    });
  }
);

// --- Tool: get_repositories -------------------------------------------------
server.tool(
  "get_repositories",
  "Find source code repositories for an Apache project. " +
    "Returns matching repo names and URLs.",
  {
    project: z.string().describe(
      "Project name or keyword to search repos (e.g. 'iceberg', 'kafka')"
    ),
  },
  async ({ project }) => {
    const repos = await getData("repositories");

    const matches = Object.entries(repos)
      .map(([name, url]) => ({
        entry: [name, url],
        rank: rankedMatch(name, project),
      }))
      .filter(({ rank }) => Number.isFinite(rank))
      .sort((a, b) => a.rank - b.rank || a.entry[0].localeCompare(b.entry[0]))
      .map(({ entry }) => entry);

    if (matches.length === 0) {
      return {
        content: [
          { type: "text", text: `No repositories found matching "${project}".` },
        ],
      };
    }

    const lines = [];
    lines.push(`## Repositories matching "${project}" (${matches.length})`);
    lines.push("");

    for (const [name, url] of matches) {
      lines.push(`- **${name}**: ${url}`);
    }

    return makeResponse(lines.join("\n"), {
      project: project,
      count: matches.length,
      repositories: matches.map(([name, url]) => ({
        name,
        url,
      })),
    });
  }
);

// --- Tool: search_projects --------------------------------------------------
server.tool(
  "search_projects",
  "Search across all Apache projects (committees + podlings) by keyword. " +
    "Searches names, descriptions, and charters. Returns a unified list.",
  {
    query: z.string().describe("Search keyword"),
    limit: z.number().optional().describe("Max results (default 30)"),
  },
  async ({ query, limit }) => {
    const max = limit || 30;
    const committees = await getData("committees");
    const podlings = await getData("podlings");

    const results = [];

    // Search committees
    for (const c of committees) {
      const rank = bestSearchRank(
        [c.name || "", c.id || "", c.shortdesc || "", c.charter || ""],
        query
      );
      if (Number.isFinite(rank)) {
        results.push({
          type: "TLP",
          id: c.id,
          name: c.name,
          desc: c.shortdesc || "",
          homepage: c.homepage || "",
          rank,
        });
      }
    }

    // Search podlings
    for (const [id, p] of Object.entries(podlings)) {
      const rank = bestSearchRank([p.name || "", id, p.description || ""], query);
      if (Number.isFinite(rank)) {
        results.push({
          type: "Podling",
          id,
          name: p.name,
          desc: (p.description || "").replace(/\s+/g, " ").trim(),
          homepage: p.homepage || "",
          rank,
        });
      }
    }
    results.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

    const { items, truncated, total } = truncateList(results, max);
    const lines = [];
    lines.push(`## Projects matching "${query}" (${results.length} found)`);
    lines.push("");

    for (const r of items) {
      lines.push(`- **${r.name}** (${r.id}) [${r.type}]`);
      if (r.desc) lines.push(`  ${r.desc}`);
      if (r.homepage) lines.push(`  ${r.homepage}`);
    }

    if (truncated) {
      lines.push(`\n... showing ${max} of ${total}.`);
    }

    return makeResponse(lines.join("\n"), {
      query,
      count: results.length,
      shown: items.length,
      truncated: !!truncated,
      projects: items.map((r) => ({
        type: r.type,
        id: r.id,
        name: r.name,
        description: r.desc || null,
        homepage: r.homepage || null,
      })),
    });
  }
);

// --- Tool: project_stats ----------------------------------------------------
server.tool(
  "project_stats",
  "Get summary statistics about the ASF: total committees, podlings, people, " +
    "members, groups, and repositories.",
  {},
  async () => {
    const committees = await getData("committees");
    const podlings = await getData("podlings");
    const people = await getData("people");
    const groups = await getData("groups");
    const repos = await getData("repositories");
    const releases = await getData("releases");

    const memberCount = Object.values(people).filter((p) => p.member).length;
    const pmcGroups = Object.keys(groups).filter((g) => g.endsWith("-pmc")).length;
    const committerGroups = Object.keys(groups).filter((g) => !g.endsWith("-pmc")).length;
    const totalReleases = Object.values(releases).reduce(
      (sum, r) => sum + Object.keys(r).length,
      0
    );

    const lines = [];
    lines.push("# Apache Software Foundation — Summary Statistics");
    lines.push("");
    lines.push(`- **Committees (TLPs):** ${committees.length}`);
    lines.push(`- **Podlings:** ${Object.keys(podlings).length}`);
    lines.push(`- **People (committers):** ${Object.keys(people).length}`);
    lines.push(`- **ASF Members:** ${memberCount}`);
    lines.push(`- **LDAP Groups:** ${Object.keys(groups).length} (${pmcGroups} PMC, ${committerGroups} committer)`);
    lines.push(`- **Repositories:** ${Object.keys(repos).length}`);
    lines.push(`- **Projects with releases:** ${Object.keys(releases).length}`);
    lines.push(`- **Total releases tracked:** ${totalReleases}`);

    return makeResponse(lines.join("\n"), {
      committees: committees.length,
      podlings: Object.keys(podlings).length,
      people: Object.keys(people).length,
      members: memberCount,
      groups: Object.keys(groups).length,
      pmcGroups,
      committerGroups,
      repositories: Object.keys(repos).length,
      projectsWithReleases: Object.keys(releases).length,
      totalReleases,
    });
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Warm cache on startup (non-blocking — tools will fetch on demand if this is slow)
  warmCache().catch(() => {});

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { makeResponse, makeTextResponse };
