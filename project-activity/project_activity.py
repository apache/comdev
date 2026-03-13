#!/usr/bin/env -S uv run --script
# /// script
# dependencies = [
#   "requests",
# ]
# ///

import argparse
import os
import sys
import subprocess
import mailbox
import email
import requests
from datetime import datetime, timedelta
from collections import defaultdict
from pathlib import Path

DATA_DIR = Path(__file__).parent / "DATA"
COMMON_LISTS = ["dev", "user", "users", "commits", "issues", "reviews"]


def check_list_exists(project, list_name):
    """Check if an Apache mailing list exists."""
    domain = f"{project}.apache.org"
    date = datetime.now().strftime("%Y-%m")
    url = f"https://lists.apache.org/api/mbox.lua?list={list_name}@{domain}&date={date}"
    try:
        r = requests.get(url, timeout=10)
        if r.status_code == 200 and len(r.content) > 100:
            return True
    except requests.RequestException:
        pass
    # Try a few months back
    for i in range(1, 12):
        d = datetime.now() - timedelta(days=30 * i)
        url = f"https://lists.apache.org/api/mbox.lua?list={list_name}@{domain}&date={d.strftime('%Y-%m')}"
        try:
            r = requests.get(url, timeout=10)
            if r.status_code == 200 and len(r.content) > 100:
                return True
        except requests.RequestException:
            continue
    return False


def fetch_mbox(project, list_name, year_month):
    """Fetch an mbox file for a given list and month. Returns path or None."""
    domain = f"{project}.apache.org"
    dest_dir = DATA_DIR / "mbox" / project / list_name
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{year_month}.mbox"

    now = datetime.now()
    ym_parts = year_month.split("-")
    target_year, target_month = int(ym_parts[0]), int(ym_parts[1])

    # Determine if we should skip fetching
    if dest.exists():
        is_current_month = (target_year == now.year and target_month == now.month)
        if is_current_month:
            pass  # Always refetch current month
        else:
            # For past months, check if file was fetched after end of that month
            end_of_month = datetime(target_year, target_month + 1, 1) if target_month < 12 else datetime(target_year + 1, 1, 1)
            file_mtime = datetime.fromtimestamp(dest.stat().st_mtime)
            if file_mtime > end_of_month:
                return dest  # Already complete

    url = f"https://lists.apache.org/api/mbox.lua?list={list_name}@{domain}&date={year_month}"
    try:
        r = requests.get(url, timeout=60)
        if r.status_code == 200 and len(r.content) > 100:
            dest.write_bytes(r.content)
            return dest
    except requests.RequestException as e:
        print(f"  Warning: Failed to fetch {list_name}/{year_month}: {e}")
    return None


def fetch_mailing_lists(project, months):
    """Discover lists and fetch mbox archives."""
    print("Checking mailing lists...")
    active_lists = []
    for ln in COMMON_LISTS:
        if check_list_exists(project, ln):
            print(f"  Found list: {ln}")
            active_lists.append(ln)

    if not active_lists:
        print("  No mailing lists found.")
        return active_lists

    now = datetime.now()
    month_list = []
    for i in range(months + 1):
        d = now - timedelta(days=30 * i)
        month_list.append(d.strftime("%Y-%m"))

    for ln in active_lists:
        print(f"  Fetching archives for {ln}...")
        for ym in month_list:
            result = fetch_mbox(project, ln, ym)
            if result:
                print(f"    {ym}: OK")
            else:
                print(f"    {ym}: no data")

    return active_lists


def discover_repos(project):
    """Discover GitHub repos for apache/{project} and apache/{project}-*."""
    repos = []
    # Check main repo
    try:
        r = requests.get(f"https://api.github.com/repos/apache/{project}", timeout=10)
        if r.status_code == 200:
            repos.append(r.json()["name"])
    except requests.RequestException:
        pass

    # Search for project-* repos
    try:
        url = f"https://api.github.com/search/repositories?q=org:apache+{project}-+in:name&per_page=100"
        r = requests.get(url, timeout=10)
        if r.status_code == 200:
            for repo in r.json().get("items", []):
                name = repo["name"]
                if name.startswith(f"{project}-") and name not in repos:
                    repos.append(name)
    except requests.RequestException:
        pass

    return repos


def fetch_repos(project, repos):
    """Clone or update repos with metadata only."""
    repo_dir = DATA_DIR / "REPOSITORIES" / project
    repo_dir.mkdir(parents=True, exist_ok=True)

    for repo_name in repos:
        path = repo_dir / repo_name
        git_url = f"https://github.com/apache/{repo_name}.git"
        if path.exists():
            print(f"  Updating {repo_name}...")
            try:
                subprocess.run(["git", "pull"], cwd=path, capture_output=True, check=True)
            except subprocess.CalledProcessError as e:
                print(f"    Warning: pull failed for {repo_name}: {e}")
        else:
            print(f"  Cloning {repo_name} (metadata only)...")
            try:
                subprocess.run(
                    ["git", "clone", "--filter=blob:none", "--no-checkout", git_url, str(path)],
                    capture_output=True, check=True,
                )
            except subprocess.CalledProcessError as e:
                print(f"    Warning: clone failed for {repo_name}: {e}")


def analyze_mbox_threads(project, list_name, months):
    """Analyze mbox files and return top threads."""
    now = datetime.now()
    threads = defaultdict(int)  # subject -> message count

    for i in range(months + 1):
        d = now - timedelta(days=30 * i)
        ym = d.strftime("%Y-%m")
        path = DATA_DIR / "mbox" / project / list_name / f"{ym}.mbox"
        if not path.exists():
            continue
        try:
            mbox = mailbox.mbox(str(path))
            for msg in mbox:
                raw_subject = msg.get("Subject", "(no subject)")
                # Decode MIME-encoded headers
                decoded_parts = email.header.decode_header(raw_subject)
                subject = ""
                for part, charset in decoded_parts:
                    if isinstance(part, bytes):
                        subject += part.decode(charset or "utf-8", errors="replace")
                    else:
                        subject += part
                # Collapse folded header whitespace and sanitize for markdown tables
                subject = " ".join(subject.split())
                subject = subject.replace("|", "\\|")
                # Normalize: strip Re:/Fwd: prefixes
                s = subject
                while True:
                    lower = s.lower().lstrip()
                    if lower.startswith("re:") or lower.startswith("fwd:"):
                        s = s.lstrip()[s.lstrip().index(":") + 1:].lstrip()
                    elif lower.startswith("[") and "]" in lower:
                        s = s[s.index("]") + 1:].lstrip()
                    else:
                        break
                threads[s.strip()] += 1
        except Exception:
            continue

    # Sort by count, top 5
    top = sorted(threads.items(), key=lambda x: -x[1])[:5]
    total = sum(threads.values())
    return top, total


def analyze_repo_commits(project, repo_name, months):
    """Count commits in the past m months."""
    path = DATA_DIR / "REPOSITORIES" / project / repo_name
    if not path.exists():
        return 0
    since = (datetime.now() - timedelta(days=30 * months)).strftime("%Y-%m-%d")
    try:
        result = subprocess.run(
            ["git", "rev-list", "--count", f"--since={since}", "HEAD"],
            cwd=path, capture_output=True, text=True, check=True,
        )
        return int(result.stdout.strip())
    except (subprocess.CalledProcessError, ValueError):
        return 0


def report(project, active_lists, repos, months):
    """Generate a markdown activity report."""
    today = datetime.now().strftime("%Y-%m-%d")
    report_dir = Path(__file__).parent / "REPORTS" / project
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / f"{today}.md"

    lines = []
    lines.append(f"# Apache {project} — Activity Report")
    lines.append(f"")
    lines.append(f"Generated: {today}  ")
    lines.append(f"Period: {months} months ending {today}")
    lines.append("")

    # Mailing lists
    any_list_activity = False
    list_sections = []
    for ln in active_lists:
        top_threads, total = analyze_mbox_threads(project, ln, months)
        if total == 0:
            continue
        any_list_activity = True
        section = []
        section.append(f"### {ln}@ ({total} messages)")
        section.append("")
        section.append("| Messages | Thread |")
        section.append("|-------:|--------|")
        for subject, count in top_threads:
            section.append(f"| {count} | {subject} |")
        section.append("")
        list_sections.append("\n".join(section))

    if any_list_activity:
        lines.append("## Most active mailing list threads")
        lines.append("")
        lines.append("\n".join(list_sections))
    else:
        lines.append("## Most active mailing list threads")
        lines.append("")
        lines.append("No mailing list activity found.")
        lines.append("")

    # Repos
    any_repo_activity = False
    repo_rows = []
    for repo_name in repos:
        count = analyze_repo_commits(project, repo_name, months)
        if count == 0:
            continue
        any_repo_activity = True
        repo_rows.append(f"| {repo_name} | {count} |")

    lines.append("## Repositories")
    lines.append("")
    if any_repo_activity:
        lines.append("| Repository | Commits |")
        lines.append("|------------|--------:|")
        lines.extend(repo_rows)
    else:
        lines.append("No repository activity found.")
    lines.append("")

    content = "\n".join(lines)
    report_path.write_text(content)
    print(f"\nReport written to {report_path}")
    print(content)


def main():
    parser = argparse.ArgumentParser(description="Apache project activity report")
    parser.add_argument("-p", "--project", required=True, help="ASF project name")
    parser.add_argument("-m", "--months", type=int, default=3, help="Number of months (default: 3)")
    args = parser.parse_args()

    project = args.project.lower()
    months = args.months

    print(f"Project: {project}")
    print(f"Months: {months}\n")

    # 1. Mailing lists
    active_lists = fetch_mailing_lists(project, months)

    # 2. Git repos
    print("\nDiscovering GitHub repositories...")
    repos = discover_repos(project)
    if repos:
        print(f"  Found: {', '.join(repos)}")
        fetch_repos(project, repos)
    else:
        print("  No repositories found.")

    # 3. Report
    report(project, active_lists, repos, months)


if __name__ == "__main__":
    main()
