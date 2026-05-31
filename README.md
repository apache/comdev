# ASF Comdev tools

ASF Community Development (ComDev) project partners with other groups across the ASF to provide resources, tools, programs, and advice in order to attract, retain, educate, and grow key communities around the Apache Software Foundation, in support of sustainability producing software for the public good.

Other repositories:

* [comdev-site](https://github.com/apache/comdev-site)
* [comdev-working-groups](https://github.com/apache/comdev-working-groups)
* [comdev-projects](https://github.com/apache/comdev-projects)
* [comdev-events-site](https://github.com/apache/comdev-events-site)
* [comdev-reporter](https://github.com/apache/comdev-reporter)

Contents of this repository:

* [`asf-highlights`](asf-highlights) — scripts for finding foundation-wide activity, such as project birthdays and ASF-wide activity summaries (self-contained `uv` Python scripts).
* [`project-activity`](project-activity) — script for generating project-specific activity reports (self-contained `uv` Python script).
* [`mcp`](mcp) — Model Context Protocol (MCP) servers that expose ASF data to MCP-compatible AI clients:
  * [`mcp/ponymail-mcp`](mcp/ponymail-mcp) — MCP server for accessing Apache PonyMail mailing list archives.
  * [`mcp/apache-projects-mcp`](mcp/apache-projects-mcp) — MCP server for querying Apache project data from [projects.apache.org](https://projects.apache.org/).
* [`scripts`](scripts) — repository tooling (the dependency license-allowlist check and shared git hooks).

See [`AGENTS.md`](AGENTS.md) for development setup, how to run the pre-push checks, and contribution conventions (including the ASF attribution policy).
