# AGENTS.md

Guidance for AI coding agents (and humans) working in the `apache/comdev`
repository. Read this before making changes.

## Repository layout

| Path | What it is | Toolchain |
|------|------------|-----------|
| `mcp/ponymail-mcp/` | MCP server for Apache PonyMail archives | Node.js (≥20), npm |
| `mcp/apache-projects-mcp/` | MCP server for `projects.apache.org` data | Node.js (≥20), npm |
| `asf-highlights/` | ASF activity / birthday report scripts | Python via `uv` (PEP-723 inline scripts) |
| `project-activity/` | Project activity report script | Python via `uv` (PEP-723 inline scripts) |
| `scripts/` | Repo tooling (license allowlist check, git hooks) | Node / Bash |
| `.github/` | CI workflows, dependabot, security config | GitHub Actions |

## Attribution policy (ASF requirement — read this)

Commits produced with AI/agent assistance **MUST** be attributed with a
`Generated-by:` trailer that names **the agent and its version** (the agent that
made the change), optionally followed by the model:

```
Generated-by: <agent name> <version> [(model)]
```

Concrete example:

```
Generated-by: Claude Code 2.1.158 (Claude Opus 4.8)
```

**Do NOT add `Co-authored-by:` trailers.** The ASF does not attribute commits to
AI tools as co-authors. This is enforced by a `commit-msg` hook
(`scripts/check-no-coauthor.sh`) that rejects any commit message containing a
`Co-authored-by:` line — install the hooks (below) so the check runs locally.

## One-time setup

Install [`prek`](https://github.com/j178/prek) (a fast, drop-in pre-commit
runner) and wire up the git hooks:

```bash
uv tool install prek          # or: pipx install prek
prek install -t pre-commit -t commit-msg -t pre-push
```

This installs three hook types:
- **pre-commit** — fast checks: license headers, trailing whitespace, YAML/JSON
  validity, workflow + dependabot schema validation.
- **commit-msg** — rejects `Co-authored-by:` trailers (see policy above).
- **pre-push** — the full suite: MCP test suites, dependency license allowlist,
  and `zizmor` GitHub Actions lint.

## Running the checks

Run the fast checks at any time:

```bash
prek run --all-files
```

**Run all pre-push checks before you push** (this is the gate CI enforces):

```bash
prek run --all-files --hook-stage pre-push
```

The pre-push hooks shell out to `npm` and `uvx`, so for them to pass you need
each MCP project installed. Equivalently, run per project:

```bash
cd mcp/ponymail-mcp        # and mcp/apache-projects-mcp
npm ci                     # reproducible install from the committed lock file
npm test                   # unit tests
npm run licenses           # dependency license allowlist check
```

## Conventions

- **License headers.** Every source file (`*.js`, `*.mjs`, `*.py`, `*.sh`,
  `*.html`) must carry the Apache-2.0 header from `.github/license-header.txt`.
  The `insert-license` pre-commit hook adds it automatically; for files with a
  `#!` shebang or a PEP-723 (`# /// script`) block, the header goes *after*
  those lines.
- **Dependency licenses.** New npm dependencies must use an ASF Category-A
  license (see the allowlist in `scripts/check-licenses.mjs`). Vetted exceptions
  go in a per-project `.license-allowlist-exceptions.json`.
- **Lock files are committed.** `package-lock.json` is tracked for reproducible
  installs and license checks — commit it alongside `package.json` changes and
  install with `npm ci`.
- **GitHub Actions** are SHA-pinned (with a `# vX.Y.Z` comment), use top-level
  `permissions: {}` with minimal per-job grants, and set
  `persist-credentials: false` on checkout. `zizmor` enforces this.
- **Python** scripts are self-contained PEP-723 `uv` scripts — run them with
  `uv run <script>.py`; dependencies are declared inline, not in a requirements
  file.

## Security tooling (CI)

CodeQL, OpenSSF Scorecard, `zizmor`, dependency-review, and Dependabot (with
release cooldowns) all run in CI under `.github/workflows/`. Local `prek` hooks
mirror the parts you can run before pushing.
