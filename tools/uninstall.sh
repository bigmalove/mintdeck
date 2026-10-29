#!/usr/bin/env bash
# 卸载：从面板移除 + 删除软链/目录 + 恢复 enabled-applets 备份
set -euo pipefail
UUID="mintdeck@local"
CUR="$(gsettings get org.cinnamon enabled-applets)"
NEW="$(python3 - "$CUR" "$UUID" <<'PY'
import ast, sys
cur, uuid = sys.argv[1], sys.argv[2]
items = [i for i in ast.literal_eval(cur) if uuid not in i]
print("[" + ", ".join("'%s'" % i for i in items) + "]")
PY
)"
gsettings set org.cinnamon enabled-applets "$NEW" || true
rm -rf "$HOME/.local/share/cinnamon/applets/$UUID"

# 翻译：连 .mo 一起清掉，否则换 locale 时还会读到残留的旧译文
for mo in "$HOME/.local/share/locale"/*/LC_MESSAGES/"$UUID".mo; do
    [ -f "$mo" ] || continue
    rm -f "$mo"
done

echo "removed $UUID"
