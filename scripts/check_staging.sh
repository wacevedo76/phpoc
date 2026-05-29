#!/usr/bin/env bash
# Quick check: list staging entries with active status and titles
# Usage: ./scripts/check_staging.sh [path/to/staging.json]

STAGING="${1:-$HOME/.local/share/phpoc/staging.json}"

if [ ! -f "$STAGING" ]; then
    echo "staging.json not found at: $STAGING"
    exit 1
fi

python3 -c "
import sys, json
d = json.load(open('$STAGING'))
print(f'{len(d)} entries')
for e in d:
    data = e.get('data', {})
    active = data.get('is_active', False)
    title = data.get('title', '?')
    print(f'  [{\"A\" if active else \" \"}] {title}')
"
