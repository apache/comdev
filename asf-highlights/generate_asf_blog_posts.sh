#!/bin/bash
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

# generate_asf_blog_posts.sh
#
# Generates the 4 monthly ASF community blog posts:
#   1. PMC members elected last month
#   2. Committers elected last month
#   3. Releases made last month
#   4. Project birthdays for the new month
#
# Usage:
#   ./generate_asf_blog_posts.sh              # normal run (uses current date)
#   ./generate_asf_blog_posts.sh --dry-run    # show what would happen
#   ./generate_asf_blog_posts.sh --month YYYY-MM   # backfill a specific month
#
# Designed to be run on the 1st of the month (or shortly after).
#
# Backfill note: with --month, the 3 activity posts (pmc, committers,
# releases) are generated for that calendar month. Project birthdays are
# anniversary-based on the CURRENT month, so they are skipped on a backfill.

ASF_HIGHLIGHTS_DIR="$HOME/devel/apache/comdev/comdev/asf-highlights"
BLOG_DIR="$HOME/devel/apache/comdev/comdev-site/source/blog"
AUTHOR="Rich Bowen"

set -euo pipefail

DRY_RUN=false
TARGET_MONTH=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --month)
            TARGET_MONTH="${2:-}"
            if [[ ! "$TARGET_MONTH" =~ ^[0-9]{4}-[0-9]{2}$ ]]; then
                echo "Error: --month requires a YYYY-MM argument" >&2
                exit 1
            fi
            shift 2
            ;;
        *)
            echo "Error: unknown argument '$1'" >&2
            echo "Usage: $0 [--dry-run] [--month YYYY-MM]" >&2
            exit 1
            ;;
    esac
done

# --- Date calculations (macOS date) ---
BACKFILL=false
if [[ -n "$TARGET_MONTH" ]]; then
    BACKFILL=true
    # The reporting ("last") month IS the target month in backfill mode.
    LAST_MONTH_YEAR="${TARGET_MONTH%-*}"
    LAST_MONTH_NUM="${TARGET_MONTH#*-}"
    LAST_MONTH_NAME=$(date -j -f "%Y-%m-%d" "${TARGET_MONTH}-01" +%B)
    # "This" month = month after the target (publication date is its 1st).
    THIS_MONTH_NUM=$(date -j -v+1m -f "%Y-%m-%d" "${TARGET_MONTH}-01" +%m)
    THIS_MONTH_YEAR=$(date -j -v+1m -f "%Y-%m-%d" "${TARGET_MONTH}-01" +%Y)
    THIS_MONTH_NAME=$(date -j -v+1m -f "%Y-%m-%d" "${TARGET_MONTH}-01" +%B)
else
    LAST_MONTH_NUM=$(date -v-1m +%m)
    LAST_MONTH_YEAR=$(date -v-1m +%Y)
    LAST_MONTH_NAME=$(date -v-1m +%B)

    THIS_MONTH_NUM=$(date +%m)
    THIS_MONTH_YEAR=$(date +%Y)
    THIS_MONTH_NAME=$(date +%B)
fi

# Publication date: 1st of "this" month (month after the reporting month)
PUB_DATE="${THIS_MONTH_YEAR}-${THIS_MONTH_NUM}-01"

# File prefixes
LAST_PREFIX="${LAST_MONTH_YEAR}_${LAST_MONTH_NUM}"
THIS_PREFIX="${THIS_MONTH_YEAR}_${THIS_MONTH_NUM}"

echo "=== ASF Monthly Blog Post Generator ==="
echo "Reporting on: ${LAST_MONTH_NAME} ${LAST_MONTH_YEAR}"
if $BACKFILL; then
    echo "Mode: BACKFILL (activity posts only; birthdays skipped)"
else
    echo "Birthdays for: ${THIS_MONTH_NAME} ${THIS_MONTH_YEAR}"
fi
echo "Publication date: ${PUB_DATE}"
if $DRY_RUN; then
    echo "Mode: DRY RUN (no files will be written)"
fi
echo ""

if $DRY_RUN; then
    echo "Would generate:"
    echo "  ${BLOG_DIR}/${LAST_PREFIX}_pmc_members.md"
    echo "    title: New PMC members, ${LAST_MONTH_NAME} ${LAST_MONTH_YEAR}"
    echo "    date: ${PUB_DATE}"
    echo ""
    echo "  ${BLOG_DIR}/${LAST_PREFIX}_committers.md"
    echo "    title: New Committers, ${LAST_MONTH_NAME} ${LAST_MONTH_YEAR}"
    echo "    date: ${PUB_DATE}"
    echo ""
    echo "  ${BLOG_DIR}/${LAST_PREFIX}_releases.md"
    echo "    title: ASF Releases, ${LAST_MONTH_NAME} ${LAST_MONTH_YEAR}"
    echo "    date: ${PUB_DATE}"
    echo ""
    if $BACKFILL; then
        echo "  (birthdays skipped in backfill mode)"
        echo ""
    else
        echo "  ${BLOG_DIR}/${THIS_PREFIX}_birthdays.md"
        echo "    title: ASF Project Birthdays, ${THIS_MONTH_NAME} ${THIS_MONTH_YEAR}"
        echo "    date: ${PUB_DATE}"
        echo ""
    fi
    echo "=== Dry run complete ==="
    exit 0
fi

# Helper: prepend frontmatter to a body file and write to blog dir
write_blog_post() {
    local title="$1"
    local date="$2"
    local output_file="$3"
    local body_file="$4"

    {
        echo "---"
        echo "title: ${title}"
        echo "date: ${date}"
        echo "blog_post: true"
        echo "published_by: ${AUTHOR}"
        echo 'tags: ["blog"]'
        echo "---"
        echo ""
        cat "$body_file"
    } > "$output_file"

    echo "  ✓ $(basename "$output_file")"
}

cd "$ASF_HIGHLIGHTS_DIR"

# asf_activity.py --markdown writes to activity_YYYY_MM_DD.md in CWD.
# In backfill mode it writes activity_YYYY_MM_01.md for the target month.
# We run each subcommand, read that file, prepend frontmatter, clean up.
MONTH_ARG=()
if $BACKFILL; then
    ACTIVITY_OUT="activity_${LAST_MONTH_YEAR}_${LAST_MONTH_NUM}_01.md"
    MONTH_ARG=(--month "$TARGET_MONTH")
else
    ACTIVITY_OUT="activity_$(date +%Y_%m_%d).md"
fi

# --- 1. PMC Members ---
echo "→ PMC members..."
rm -f "$ACTIVITY_OUT"
uv run asf_activity.py pmc --markdown "${MONTH_ARG[@]+"${MONTH_ARG[@]}"}"
if [ -f "$ACTIVITY_OUT" ]; then
    write_blog_post \
        "New PMC members, ${LAST_MONTH_NAME} ${LAST_MONTH_YEAR}" \
        "$PUB_DATE" \
        "${BLOG_DIR}/${LAST_PREFIX}_pmc_members.md" \
        "$ACTIVITY_OUT"
    rm -f "$ACTIVITY_OUT"
else
    echo "  ⚠ No output from asf_activity.py pmc"
fi

# --- 2. Committers ---
echo "→ Committers..."
rm -f "$ACTIVITY_OUT"
uv run asf_activity.py committers --markdown "${MONTH_ARG[@]+"${MONTH_ARG[@]}"}"
if [ -f "$ACTIVITY_OUT" ]; then
    write_blog_post \
        "New Committers, ${LAST_MONTH_NAME} ${LAST_MONTH_YEAR}" \
        "$PUB_DATE" \
        "${BLOG_DIR}/${LAST_PREFIX}_committers.md" \
        "$ACTIVITY_OUT"
    rm -f "$ACTIVITY_OUT"
else
    echo "  ⚠ No output from asf_activity.py committers"
fi

# --- 3. Releases ---
echo "→ Releases..."
rm -f "$ACTIVITY_OUT"
uv run asf_activity.py releases --markdown "${MONTH_ARG[@]+"${MONTH_ARG[@]}"}"
if [ -f "$ACTIVITY_OUT" ]; then
    write_blog_post \
        "ASF Releases, ${LAST_MONTH_NAME} ${LAST_MONTH_YEAR}" \
        "$PUB_DATE" \
        "${BLOG_DIR}/${LAST_PREFIX}_releases.md" \
        "$ACTIVITY_OUT"
    rm -f "$ACTIVITY_OUT"
else
    echo "  ⚠ No output from asf_activity.py releases"
fi

# --- 4. Project Birthdays ---
if $BACKFILL; then
    echo "→ Birthdays... (skipped in backfill mode — anniversary-based on current month)"
else
    echo "→ Birthdays..."
    uv run project_birthdays.py
    BDAY_MD_FILE=$(ls -t birthdays/apache_birthdays_*.md 2>/dev/null | head -1)
    if [ -n "$BDAY_MD_FILE" ]; then
        # Strip the H1 title line — frontmatter title replaces it
        BDAY_TEMP=$(mktemp)
        sed '1{/^# /d;}' "$BDAY_MD_FILE" > "$BDAY_TEMP"
        write_blog_post \
            "ASF Project Birthdays, ${THIS_MONTH_NAME} ${THIS_MONTH_YEAR}" \
            "$PUB_DATE" \
            "${BLOG_DIR}/${THIS_PREFIX}_birthdays.md" \
            "$BDAY_TEMP"
        rm -f "$BDAY_TEMP"
    else
        echo "  ⚠ project_birthdays.py produced no output"
    fi
fi

echo ""
echo "=== Done! Blog posts written to ${BLOG_DIR}/ ==="
echo "  ${LAST_PREFIX}_pmc_members.md"
echo "  ${LAST_PREFIX}_committers.md"
echo "  ${LAST_PREFIX}_releases.md"
if ! $BACKFILL; then
    echo "  ${THIS_PREFIX}_birthdays.md"
fi
