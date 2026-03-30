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
- `-h`, `--help` — Show help

Multiple options can be combined, e.g. `uv run asf_activity.py committers pmc --markdown`.

## project_birthdays.py

Generates a Markdown summary of Apache projects celebrating their establishment anniversary in the current month. Output (summary and log file) is written to the `birthdays/` directory.

```
./project_birthdays.py
```
