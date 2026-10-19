# ASF Highlights

Scripts for generating monthly summaries of Apache Software Foundation activity. Both scripts use [uv](https://docs.astral.sh/uv/) for dependency management and can be run directly.

## asf_activity.py

Reports on ASF activity from the previous month: new committers, new PMC members, and software releases.

```
./asf_activity.py [OPTIONS]
```

Options:
- `committers` — New committers added last month
- `pmc` — New PMC members added last month
- `releases` — Releases made last month
- `all` — All of the above (default)
- `-m`, `--markdown` — Save output to a timestamped Markdown file (`activity_YYYY_MM_DD.md`)
- `--month YYYY-MM` — Report on a specific calendar month instead of last month (for backfilling missed months). With `--markdown`, the output file is named `activity_YYYY_MM_01.md` for the target month.
- `-h`, `--help` — Show help

Multiple options can be combined, e.g. `uv run asf_activity.py committers pmc --markdown`.

Backfill example — regenerate a past month you missed:

```
uv run asf_activity.py all --markdown --month 2026-09
```

Without `--month`, behavior is unchanged: the report always covers the month *before* today, so it is normally run on the 1st of the month to report on the month that just ended.

## project_birthdays.py

Generates a Markdown summary of Apache projects celebrating their establishment anniversary in the current month. Output (summary and log file) is written to the `birthdays/` directory.

```
./project_birthdays.py
```

## generate_asf_blog_posts.sh

Generates the monthly ASF community blog posts (PMC members, committers, releases, and — for a normal run — project birthdays), writing them with front matter into the comdev-site blog directory.

```
./generate_asf_blog_posts.sh              # normal run — reports on last month
./generate_asf_blog_posts.sh --dry-run    # show what would be generated, write nothing
./generate_asf_blog_posts.sh --month YYYY-MM   # backfill a specific month you missed
```

Designed to be run on the 1st of the month (or shortly after) to report on the month that just ended.

**Backfill mode (`--month`)**: generates the three activity posts (PMC members, committers, releases) for the specified calendar month, with a publication date of the 1st of the following month. Project birthdays are anniversary-based on the *current* month, so they are **skipped** on a backfill. `--dry-run` and `--month` can be combined.
