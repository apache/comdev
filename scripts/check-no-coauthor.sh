#!/usr/bin/env bash
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

# commit-msg hook: reject "Co-authored-by:" trailers.
#
# ASF policy: do not attribute commits to AI tools as co-authors. Agent-assisted
# commits must instead carry a "Generated-by:" trailer naming the agent + version
# (see AGENTS.md). $1 is the path to the commit message file.

set -euo pipefail

msg_file="$1"

if grep -iqE '^[[:space:]]*Co-authored-by:' "$msg_file"; then
  echo "ERROR: 'Co-authored-by:' trailers are not allowed in this repository." >&2
  echo "" >&2
  echo "Per ASF policy, attribute agent-assisted commits with a 'Generated-by:'" >&2
  echo "trailer naming the agent and version instead, e.g.:" >&2
  echo "" >&2
  echo "    Generated-by: Claude Code 2.1.158 (Claude Opus 4.8)" >&2
  echo "" >&2
  exit 1
fi
