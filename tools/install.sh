#!/usr/bin/env bash
# MintDeck 安装脚本：把 applet 放进 Cinnamon 的用户目录，并装好字体。
# 用法：tools/install.sh          软链（开发用，改代码立即生效，配合 tools/dev-reload.sh）
#       tools/install.sh --copy   复制（发布/打包用）
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/mintdeck@bigmalove"
DEST="$HOME/.local/share/cinnamon/applets/mintdeck@bigmalove"
MODE="${1:-link}"

mkdir -p "$(dirname "$DEST")"
if [ "$MODE" = "--copy" ]; then
    rm -rf "$DEST"
    cp -a "$SRC" "$DEST"
    echo "copied → $DEST"
else
    rm -rf "$DEST"
    ln -s "$SRC" "$DEST"
    echo "linked → $DEST"
fi

# 字体：时钟的 4 种样式依赖它们
FONTDIR="$HOME/.local/share/fonts/mintdeck"
mkdir -p "$FONTDIR"
cp -f "$SRC/fonts/"*.ttf "$FONTDIR/" 2>/dev/null || true
fc-cache -f "$FONTDIR" >/dev/null 2>&1 || true
echo "fonts  → $FONTDIR"

# 翻译：po/*.po → .mo，装到 gettext 找得到的地方。
# Cinnamon 给每个 applet 绑的 domain 就是 uuid（appletManager.js:617），
# 所以设置窗口（xlet-settings）和小程序列表里的名字/描述都读这个目录。
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCDIR="$HOME/.local/share/locale"
if python3 "$ROOT/tools/i18n-build.py" --mo >/dev/null 2>&1; then
    for mo in "$ROOT/po/build"/*/LC_MESSAGES/mintdeck@bigmalove.mo; do
        [ -f "$mo" ] || continue
        lang="$(basename "$(dirname "$(dirname "$mo")")")"
        mkdir -p "$LOCDIR/$lang/LC_MESSAGES"
        cp -f "$mo" "$LOCDIR/$lang/LC_MESSAGES/mintdeck@bigmalove.mo"
        echo "i18n   → $LOCDIR/$lang/LC_MESSAGES/mintdeck@bigmalove.mo"
    done
else
    echo "i18n   → 跳过（缺 msgfmt 或 python3；设置窗口会保持中文，悬浮岛仍可切换语言）"
fi

cat <<'TIP'

下一步（二选一）：
  · 图形界面：系统设置 → 小程序 → 添加 → MintDeck
  · 命令行：tools/enable.sh     （切换 org.cinnamon enabled-applets，稍后会重排面板）

面板上出现图标后，屏幕顶部就会出现灵动岛；鼠标移上去展开。
卸载：tools/uninstall.sh
TIP
