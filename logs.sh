#!/usr/bin/env bash
# logs.sh — tail/follow logs for one or all services.
#
#   ./logs.sh                # last 200 lines from every service
#   ./logs.sh app             # last 200 lines from just the app
#   ./logs.sh app -f          # follow the app's logs live
#   ./logs.sh -f              # follow every service live
set -euo pipefail

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$_SCRIPT_DIR/_common.sh"
cd "$APP_DIR"

SERVICE=""
FOLLOW=""
for arg in "$@"; do
  if [[ "$arg" == "-f" || "$arg" == "--follow" ]]; then
    FOLLOW="-f"
  else
    SERVICE="$arg"
  fi
done

# shellcheck disable=SC2086
$COMPOSE logs --tail=200 $FOLLOW ${SERVICE:+"$SERVICE"}
