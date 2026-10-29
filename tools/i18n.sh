#!/usr/bin/env bash
# 多语言工具链入口。细节见 docs/I18N.md。
#
#   tools/i18n.sh extract   源码 → po/mintdeck@bigmalove.pot（改完文案先跑这个）
#   tools/i18n.sh update    extract + msgmerge 把新条目并进 po/*.po（旧的译文保留）
#   tools/i18n.sh init      从 pot 新建还没有的 po 文件（msgstr 留空）
#   tools/i18n.sh build     extract + 生成 lib/core/i18nData.js 与 po/build/**/*.mo
#   tools/i18n.sh mo        只重编 .mo
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POT="po/mintdeck@bigmalove.pot"
CMD="${1:-build}"

case "$CMD" in
    extract)
        python3 tools/i18n-extract.py
        ;;
    init)
        python3 tools/i18n-extract.py
        python3 tools/i18n-build.py --init
        ;;
    update)
        python3 tools/i18n-extract.py
        for po in po/*.po; do
            msgmerge --update --backup=none --quiet "$po" "$POT"
            echo "merged  → $po"
        done
        python3 tools/i18n-build.py
        ;;
    build)
        python3 tools/i18n-extract.py
        python3 tools/i18n-build.py
        ;;
    mo)
        python3 tools/i18n-build.py --mo
        ;;
    *)
        sed -n '2,10p' "$0"
        exit 2
        ;;
esac
