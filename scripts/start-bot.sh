#!/bin/zsh
set -euo pipefail

PROJECT_DIR="/Users/devaccount1/Documents/Cursor/clickup-bot"
cd "$PROJECT_DIR"

exec "/Users/devaccount1/.nvm/versions/node/v22.22.2/bin/node" "$PROJECT_DIR/src/index.js"
