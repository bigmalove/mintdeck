#!/usr/bin/env bash
# 把 mintdeck@bigmalove 加进面板（idempotent）。已有就什么都不做。
# 会先备份当前的 enabled-applets，便于 tools/uninstall.sh 回滚。
set -euo pipefail
UUID="mintdeck@bigmalove"
CUR="$(gsettings get org.cinnamon enabled-applets)"
if printf '%s' "$CUR" | grep -q "$UUID"; then
    echo "already enabled"
    exit 0
fi
printf '%s\n' "$CUR" > "$HOME/.config/mintdeck-enabled-applets.bak" 2>/dev/null || true
NEW="$(python3 - "$CUR" "$UUID" <<'PY'
import ast, sys
cur, uuid = sys.argv[1], sys.argv[2]
items = ast.literal_eval(cur)
# 放在右侧系统托盘区域后面，order 用当前最大值 +1
mx = 0
for it in items:
    parts = it.split(':')
    try: mx = max(mx, int(parts[4]))
    except Exception: pass
items.append(f"panel1:right:22:{uuid}:{mx + 1}")
print("[" + ", ".join("'%s'" % i for i in items) + "]")
PY
)"
gsettings set org.cinnamon enabled-applets "$NEW"
echo "enabled: $UUID (backup: ~/.config/mintdeck-enabled-applets.bak)"
