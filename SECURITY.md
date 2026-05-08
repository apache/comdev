# Security Policy

## Supported Versions

Only the latest `main` branch is supported. Please ensure you are running the
latest revision of any tool from this repository before reporting
vulnerabilities.

## Reporting a Vulnerability

Please **do not** open public GitHub issues for security vulnerabilities.

Two channels exist for this repository:

1. **The ASF Security Team** at [security@apache.org](mailto:security@apache.org)
   ([process](https://www.apache.org/security/)) — preferred for any
   vulnerability that could affect ASF infrastructure or projects in production.
2. **GitHub private vulnerability reporting** for this repository
   (["Security" tab → "Report a vulnerability"](https://github.com/apache/comdev/security/advisories/new))
   — appropriate for issues isolated to the tooling here (e.g. the
   `mcp/ponymail-mcp` server, the activity / highlights scripts).

When in doubt, prefer security@apache.org.

We aim to acknowledge reports within **5 business days** and provide a fix
or remediation plan within **30 days** for confirmed issues.

## Scope

In scope:

- Authentication handling in tools shipped from this repository (e.g. session
  cookie storage and OAuth helper flow in `mcp/ponymail-mcp`).
- Input validation on inputs passed to external services (PonyMail API,
  GitHub API, etc.) by tools in this repository.
- Supply-chain issues in dependencies or GitHub Actions used by this repo.

Out of scope:

- Vulnerabilities in upstream Apache services (PonyMail, GitBox, etc.) —
  please report those to the
  [ASF Security Team](https://www.apache.org/security/).
- Vulnerabilities in third-party services these tools query.

## Disclosure

We follow coordinated disclosure. Once a fix is released, we will publish a
GitHub Security Advisory crediting the reporter (unless anonymity is
requested). For issues coordinated through security@apache.org, the ASF
disclosure process applies.
