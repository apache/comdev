# Apache Project Activity Reporter

Generates activity reports for Apache Software Foundation projects by
fetching mailing list archives and git repository metadata.

## Requirements

- [uv](https://github.com/astral-sh/uv) (dependencies are managed inline via the script header)
- git

## Usage

```
./project_activity.py -p <project> [-m <months>]
```

| Flag | Description | Default |
|------|-------------|---------|
| `-p`, `--project` | ASF project name (e.g., `iceberg`, `httpd`) | required |
| `-m`, `--months` | Number of months of history | 3 |
| `-h`, `--help` | Show help | |

### Example

```
./project_activity.py -p iceberg -m 6
```

## What it does

1. **Mailing lists** — Checks for common Apache list names (`dev`, `user`, `users`, `commits`, `issues`, `reviews`), then fetches mbox archives for the time period. Already-fetched past months are skipped if complete; the current month is always refetched.

2. **Git repositories** — Discovers `apache/{project}` and `apache/{project}-*` repos on GitHub. Clones metadata-only (no file content). Existing clones are updated with `git pull`.

3. **Report** — Generates a Markdown report with the top 5 most active threads per mailing list and commit counts per repository. Lists and repos with no activity are omitted.

## Directory structure

```
project-activity/
├── project_activity.py          # Main script
├── README.md
├── DATA/
│   ├── mbox/
│   │   └── <project>/
│   │       └── <list>/          # e.g., dev/, issues/
│   │           └── YYYY-MM.mbox # Monthly mbox archives
│   └── REPOSITORIES/
│       └── <project>/
│           └── <repo>/          # Metadata-only git clones
└── REPORTS/
    └── <project>/
        └── YYYY-MM-DD.md        # Datestamped activity reports
```
