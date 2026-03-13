#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["httpx"]
# ///

import httpx
import sys
from datetime import datetime, timedelta
from collections import defaultdict

def get_date_range():
    today = datetime.now()
    last_month_start = (today.replace(day=1) - timedelta(days=1)).replace(day=1)
    last_month_end = today.replace(day=1) - timedelta(days=1)
    return last_month_start, last_month_end

def find_committers():
    people_data = httpx.get("https://projects.apache.org/json/foundation/people.json").json()
    ldap_data = httpx.get("https://whimsy.apache.org/public/public_ldap_people.json").json()
    
    last_month_start, last_month_end = get_date_range()
    new_committers = defaultdict(list)
    
    for person_id, person_info in people_data.items():
        if person_id not in ldap_data["people"]:
            continue
        
        created = datetime.strptime(ldap_data["people"][person_id]["createTimestamp"], "%Y%m%d%H%M%SZ")
        
        if last_month_start <= created <= last_month_end:
            for group in person_info.get("groups", []):
                if not group.endswith("-pmc") and group not in ["apldap", "incubator"]:
                    new_committers[group].append({
                        "name": person_info.get("name", person_id),
                        "id": person_id,
                        "date": created.strftime("%Y-%m-%d")
                    })
    
    if new_committers:
        total = sum(len(c) for c in new_committers.values())
        print(f"In {last_month_start.strftime('%B, %Y')}, {len(new_committers)} projects added a total of {total} new committers\n")
        for project in sorted(new_committers.keys()):
            print(f"{project.upper()}:")
            for committer in new_committers[project]:
                print(f"  - {committer['name']} ({committer['id']}) on {committer['date']}")
            print()
    else:
        print(f"No new committers added in {last_month_start.strftime('%B %Y')}")

def find_pmc():
    committee_data = httpx.get("https://whimsy.apache.org/public/committee-info.json").json()
    committees_data = httpx.get("https://projects.apache.org/json/foundation/committees.json").json()
    
    last_month_start, last_month_end = get_date_range()
    reporting_month = last_month_start.strftime("%Y-%m")
    new_pmc_members = defaultdict(list)
    new_projects = set()
    
    # Identify projects established in the reporting month
    for committee in committees_data:
        if committee.get("established") == reporting_month:
            new_projects.add(committee.get("id", "").lower())
    
    for project_id, project_info in committee_data.get("committees", {}).items():
        if not project_info.get("pmc"):
            continue
        
        for member_id, member_info in project_info.get("roster", {}).items():
            date_str = member_info.get("date")
            if not date_str:
                continue
            
            added = datetime.strptime(date_str, "%Y-%m-%d")
            
            if last_month_start <= added <= last_month_end:
                new_pmc_members[project_id].append({
                    "name": member_info.get("name", member_id),
                    "id": member_id,
                    "date": date_str
                })
    
    if new_pmc_members:
        total = sum(len(m) for m in new_pmc_members.values())
        new_project_members = sum(len(m) for p, m in new_pmc_members.items() if p in new_projects)
        
        summary = f"In {last_month_start.strftime('%B, %Y')}, {len(new_pmc_members)} projects added a total of {total} new PMC members"
        if new_project_members > 0:
            summary += f". {new_project_members} of those are part of newly-established projects"
        print(summary + "\n")
        
        for project in sorted(new_pmc_members.keys()):
            project_label = f"{project.upper()}"
            if project in new_projects:
                project_label += " 🎉 (New Project)"
            print(f"{project_label}:")
            for member in new_pmc_members[project]:
                print(f"  - {member['name']} ({member['id']}) on {member['date']}")
            print()
    else:
        print(f"No new PMC members added in {last_month_start.strftime('%B %Y')}")

def find_releases():
    releases_data = httpx.get("https://projects.apache.org/json/foundation/releases.json").json()
    
    last_month_start, last_month_end = get_date_range()
    project_releases = defaultdict(list)
    
    for project_id, releases in releases_data.items():
        for release_name, release_date_str in releases.items():
            release_date = datetime.strptime(release_date_str, "%Y-%m-%d")
            
            if last_month_start <= release_date <= last_month_end:
                project_releases[project_id].append({
                    "name": release_name,
                    "date": release_date_str
                })
    
    if project_releases:
        total = sum(len(r) for r in project_releases.values())
        print(f"In {last_month_start.strftime('%B, %Y')}, {len(project_releases)} projects made {total} releases\n")
        for project in sorted(project_releases.keys()):
            print(f"{project.upper()}:")
            for release in project_releases[project]:
                print(f"  - {release['name']} on {release['date']}")
            print()
    else:
        print(f"No releases made in {last_month_start.strftime('%B %Y')}")

if __name__ == "__main__":
    args = sys.argv[1:]
    
    if "-h" in args or "--help" in args:
        print("Usage: find_activity.py [OPTIONS]")
        print("\nOptions:")
        print("  committers    Show new committers added last month")
        print("  pmc           Show new PMC members added last month")
        print("  releases      Show releases made last month")
        print("  all           Show all reports (default)")
        print("  -h, --help    Show this help message")
        print("\nExamples:")
        print("  find_activity.py")
        print("  find_activity.py committers")
        print("  find_activity.py pmc releases")
        sys.exit(0)
    
    if not args or "all" in args:
        find_committers()
        print("\n" + "="*80 + "\n")
        find_pmc()
        print("\n" + "="*80 + "\n")
        find_releases()
    else:
        if "committers" in args:
            find_committers()
        if "pmc" in args:
            find_pmc()
        if "releases" in args:
            find_releases()
