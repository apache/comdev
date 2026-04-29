#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.8"
# dependencies = [
#     "requests",
# ]
# ///
"""
Apache Project Birthday Tracker - A script to generate monthly summaries of Apache project birthdays
"""

import os
import sys
import json
import logging
import requests
from datetime import datetime, timedelta
from pathlib import Path
from collections import defaultdict

# Configuration
CONFIG = {
    "committees_url": "https://projects.apache.org/json/foundation/committees.json",
    "output_dir": "birthdays",
    "current_month": datetime.now().month,  # Default to current month
    "current_year": datetime.now().year     # Default to current year
}

def ensure_output_dir():
    """Create the output directory if it doesn't exist"""
    output_path = Path(CONFIG["output_dir"])
    output_path.mkdir(parents=True, exist_ok=True)
    return output_path

# Configure logging (after ensuring output directory exists)
ensure_output_dir()
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(Path(CONFIG["output_dir"]) / "project_birthdays.log"),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger("apache_birthdays_tracker")

def fetch_json_data(url):
    """Fetch JSON data from a URL"""
    logger.info(f"Fetching data from {url}")
    try:
        response = requests.get(url, timeout=30)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        logger.error(f"Error fetching data from {url}: {e}")
        return None

def get_month_name(month_number):
    """Convert month number to month name"""
    return datetime(2000, month_number, 1).strftime('%B')

def get_projects_with_birthdays(committees_data, month):
    """
    Find projects with birthdays in the specified month
    Returns a dictionary with years as keys and lists of projects as values
    """
    birthday_projects = defaultdict(list)
    
    for committee in committees_data:
        # Skip if no established date
        if "established" not in committee:
            continue
            
        established = committee.get("established", "")
        if not established or "-" not in established:
            continue
            
        try:
            est_year, est_month = established.split("-")
            est_month = int(est_month)
            est_year = int(est_year)
            
            # Check if the project's birthday is in the target month
            if est_month == month:
                project_name = committee.get("name", "Unknown Project")
                project_id = committee.get("id", "")
                homepage = committee.get("homepage", "")
                description = committee.get("charter", "No description available")
                
                # Add project to the appropriate year group
                birthday_projects[est_year].append({
                    "name": project_name,
                    "id": project_id,
                    "established": established,
                    "homepage": homepage,
                    "description": description,
                    "age": CONFIG["current_year"] - est_year
                })
        except (ValueError, IndexError):
            # Skip entries with invalid date format
            continue
    
    return birthday_projects

def generate_birthday_summary(birthday_projects, month):
    """Generate a markdown summary of projects with birthdays in the specified month"""
    if not birthday_projects:
        return f"# Apache Project Birthdays - {get_month_name(month)} {CONFIG['current_year']}\n\nNo Apache projects were established in {get_month_name(month)}.\n"
    
    month_name = get_month_name(month)
    summary = f"# Apache Project Birthdays - {month_name} {CONFIG['current_year']}\n\n"
    summary += f"The following Apache projects are celebrating their birthdays in {month_name}.\n\n"
    
    # Sort years in descending order (newest first)
    sorted_years = sorted(birthday_projects.keys(), reverse=True)
    
    for year in sorted_years:
        projects = birthday_projects[year]
        # Sort projects within each year by name
        projects.sort(key=lambda x: x["name"])
        
        for project in projects:
            age = project["age"]
            age_suffix = "year" if age == 1 else "years"
            
            summary += f"## {project['name']} ({age} {age_suffix})\n\n"
            summary += f"**Established:** {project['established']}\n\n"
            summary += f"**Description:** {project['description']}\n\n"
            summary += f"**Project Homepage:** {project['homepage']}\n\n"
            summary += "---\n\n"
    
    return summary

def save_content(content, output_dir, month):
    """Save the generated summary to a file"""
    if not content:
        return
    
    month_name = get_month_name(month).lower()
    year = CONFIG["current_year"]
    filename = f"apache_birthdays_{year}_{month:02d}_{month_name}.md"
    filepath = output_dir / filename
    
    try:
        with open(filepath, 'w') as f:
            f.write(content)
        logger.info(f"Birthday summary saved to {filepath}")
        return filepath
    except Exception as e:
        logger.error(f"Error saving summary to {filepath}: {e}")
        return None

def main():
    """Main function to fetch Apache project birthdays and generate a monthly summary"""
    logger.info("Starting Apache project birthdays fetch")
    output_dir = Path(CONFIG["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Get the current month or use the one specified in CONFIG
    month = CONFIG["current_month"]
    month_name = get_month_name(month)
    
    # Fetch committees data
    committees_data = fetch_json_data(CONFIG["committees_url"])
    
    if not committees_data:
        logger.error("Failed to fetch committees data")
        return
    
    # Get projects with birthdays in the current month
    birthday_projects = get_projects_with_birthdays(committees_data, month)
    
    # Generate and save birthday summary
    summary = generate_birthday_summary(birthday_projects, month)
    filepath = save_content(summary, output_dir, month)
    
    # Count total projects
    total_projects = sum(len(projects) for projects in birthday_projects.values())
    
    # Log completion
    logger.info(f"Found {total_projects} projects with birthdays in {month_name}")
    logger.info("Apache project birthdays fetch completed")
    
    # Print path to the generated file
    if filepath:
        print(f"Birthday summary saved to: {filepath}")

if __name__ == "__main__":
    main()
