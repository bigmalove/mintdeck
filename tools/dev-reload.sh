#!/usr/bin/env bash
# 热重载：改完 applet.js 或 lib/ 之后跑一下，不用重启 Cinnamon。
# 注意：只重载已启用的实例；新增文件（如没被 import 过的新模块）也一并生效。
set -euo pipefail
UUID="${1:-mintdeck@local}"
gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon \
  --method org.Cinnamon.ReloadXlet "$UUID" "APPLET" >/dev/null
echo "reloaded $UUID"
