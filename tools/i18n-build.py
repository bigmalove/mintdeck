#!/usr/bin/env python3
"""po/*.po → 运行期用的两样东西：

  1. mintdeck@bigmalove/lib/core/i18nData.js —— 画布文字（St/cairo 自绘的部分）查的词典，
     由 applet.js 注入进 lib/core/i18n.js。换语言立刻生效，不用重启 shell；
  2. po/build/<locale>/LC_MESSAGES/mintdeck@bigmalove.mo —— gettext 用的二进制，
     给 xlet-settings（设置窗口）和 Cinnamon 的小程序列表翻译用。工具的 install.sh 会把它
     拷到 ~/.local/share/locale/，Cinnamon 的 domain 就是 uuid（appletManager.js:617）。

用法：
  python3 tools/i18n-build.py            # 生成 i18nData.js + .mo
  python3 tools/i18n-build.py --init     # 从 pot 新建还没翻译的 po（msgstr 留空）
  python3 tools/i18n-build.py --mo       # 只编 .mo
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PO_DIR = os.path.join(ROOT, 'po')
REVISION_DATE = '2026-10-29 13:20+0800'
POT = os.path.join(PO_DIR, 'mintdeck@bigmalove.pot')
JS_OUT = os.path.join(ROOT, 'mintdeck@bigmalove', 'lib', 'core', 'i18nData.js')
MO_ROOT = os.path.join(PO_DIR, 'build')
DOMAIN = 'mintdeck@bigmalove'

# 有词典的语言。zh_CN 是 msgid 本身，不需要 po。
LOCALES = {
    'en': {'name': 'English', 'plural': 'nplurals=2; plural=(n != 1);'},
    'ja': {'name': '日本語', 'plural': 'nplurals=1; plural=0;'},
    'zh_TW': {'name': '繁體中文', 'plural': 'nplurals=1; plural=0;'},
}

_PO_ESCAPES = {'n': '\n', 't': '\t', 'r': '\r', '"': '"', '\\': '\\'}


def unescape(raw):
    out = []
    i = 0
    while i < len(raw):
        ch = raw[i]
        if ch != '\\' or i + 1 >= len(raw):
            out.append(ch)
            i += 1
            continue
        out.append(_PO_ESCAPES.get(raw[i + 1], raw[i + 1]))
        i += 2
    return ''.join(out)


def escape(text):
    return text.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\t', '\\t')


# ---------------------------------------------------------------- po 解析

class Entry:
    def __init__(self):
        self.msgid = None
        self.plural = None
        self.msgstr = ''
        self.msgstrs = {}
        self.refs = []
        self.fuzzy = False
        self.obsolete = False


def parse_po(path):
    entries = []
    cur = Entry()
    field = None          # 'msgid' | 'msgid_plural' | 'msgstr' | 'msgstr[N]'
    index = None
    started = False

    def flush():
        nonlocal cur, started
        if started and cur.msgid is not None and not cur.obsolete:
            entries.append(cur)
        cur = Entry()
        started = False

    with open(path, encoding='utf-8') as fh:
        lines = fh.read().splitlines()

    for line in lines:
        stripped = line.strip()
        if not stripped:
            flush()
            field = None
            index = None
            continue
        if stripped.startswith('#~'):
            # 废弃条目：整块跳过
            cur.obsolete = True
            continue
        if stripped.startswith('#'):
            if stripped.startswith('#,') and 'fuzzy' in stripped:
                cur.fuzzy = True
            elif stripped.startswith('#:'):
                cur.refs.extend(stripped[2:].split())
            continue
        if stripped.startswith('msgctxt'):
            started = True
            field = 'msgctxt'
            continue
        m = re.match(r'^(msgid_plural|msgid|msgstr(?:\[(\d+)\])?)\s+"(.*)"$', stripped)
        if m:
            kind = m.group(1)
            started = True
            if kind == 'msgid':
                cur.msgid = unescape(m.group(3))
                field = 'msgid'
            elif kind == 'msgid_plural':
                cur.plural = unescape(m.group(3))
                field = 'msgid_plural'
            else:
                index = int(m.group(2)) if m.group(2) is not None else None
                if index is None:
                    cur.msgstr = unescape(m.group(3))
                    field = 'msgstr'
                else:
                    cur.msgstrs[index] = unescape(m.group(3))
                    field = 'msgstr'
            continue
        if stripped.startswith('"') and stripped.endswith('"'):
            text = unescape(stripped[1:-1])
            if field == 'msgid':
                cur.msgid += text
            elif field == 'msgid_plural':
                cur.plural = (cur.plural or '') + text
            elif field == 'msgstr':
                if index is None:
                    cur.msgstr += text
                else:
                    cur.msgstrs[index] = cur.msgstrs.get(index, '') + text
            continue
    flush()
    return [e for e in entries if e.msgid]


def parsed_catalog(path):
    """msgid -> msgstr（str）或 [msgstr0, msgstr1]；未翻译/模糊的条目丢掉（回退到中文）。"""
    out = {}
    for e in parse_po(path):
        if not e.msgid or e.fuzzy:
            continue
        if e.plural is not None:
            if 0 not in e.msgstrs or not e.msgstrs[0]:
                continue
            out[e.msgid] = [e.msgstrs.get(0, ''), e.msgstrs.get(1, e.msgstrs.get(0, ''))]
        else:
            if not e.msgstr:
                continue
            out[e.msgid] = e.msgstr
    return out


# ---------------------------------------------------------------- 生成

def js_catalog():
    catalogs = {}
    for locale in sorted(LOCALES):
        path = os.path.join(PO_DIR, locale + '.po')
        catalogs[locale] = parsed_catalog(path) if os.path.exists(path) else {}

    lines = [
        '// lib/core/i18nData.js —— 由 tools/i18n-build.py 从 po/*.po 生成，不要手改。',
        '//',
        '// 键是 msgid（简体中文原文），值是译文；复数条目的值是两个元素的数组 [单数, 复数]。',
        '// 未翻译的条目在这里没有键 —— i18n.js 会回退到 msgid，也就是中文，不会显示空串。',
        "'use strict';",
        '',
        "var SOURCE_LOCALE = 'zh_CN';",
        '',
        'var CATALOG = {',
    ]
    for locale in sorted(catalogs):
        lines.append('  %s: {' % js_key(locale))
        for msgid, value in catalogs[locale].items():
            lines.append('    %s: %s,' % (js_key(msgid), js_value(value)))
        lines.append('  }' + (',' if locale != sorted(catalogs)[-1] else ''))
    lines.append('};')
    lines.append('')
    lines.append("if (typeof module !== 'undefined') module.exports = { CATALOG: CATALOG, SOURCE_LOCALE: SOURCE_LOCALE };")
    lines.append('')
    return '\n'.join(lines)


def js_key(text):
    # JSON 字符串转义对 JS 完全够用（双引号、反斜杠、控制字符）
    import json
    return json.dumps(text, ensure_ascii=False)


def js_value(value):
    import json
    if isinstance(value, list):
        return '[' + ', '.join(js_key(v) for v in value) + ']'
    return js_key(value)


def init_po():
    if not os.path.exists(POT):
        sys.exit('缺少 %s，先跑 tools/i18n-extract.py' % os.path.relpath(POT, ROOT))
    src = parse_po(POT)
    for locale in sorted(LOCALES):
        path = os.path.join(PO_DIR, locale + '.po')
        if os.path.exists(path):
            continue
        head = [
            '# %s 翻译（%s）。msgid 是简体中文原文，msgstr 填这门语言。' % (LOCALES[locale]['name'], locale),
            '# 由 tools/i18n-build.py --init 生成；改完跑 tools/i18n-build.py 生成 .mo 与 i18nData.js。',
            'msgid ""',
            'msgstr ""',
            '"Project-Id-Version: mintdeck@bigmalove\\n"',
            '"PO-Revision-Date: %s\\n"' % REVISION_DATE,
            '"Last-Translator: bigmalove <125801848+bigmalove@users.noreply.github.com>\\n"',
            '"Language-Team: MintDeck translators\\n"',
            '"Language: %s\\n"' % locale,
            '"MIME-Version: 1.0\\n"',
            '"Content-Type: text/plain; charset=UTF-8\\n"',
            '"Content-Transfer-Encoding: 8bit\\n"',
            '"Plural-Forms: %s\\n"' % LOCALES[locale]['plural'],
            '',
        ]
        for e in src:
            if not e.msgid:
                continue
            for ref in e.refs:
                head.append('#: %s' % ref)
            head.append('msgid "%s"' % escape(e.msgid))
            if e.plural is not None:
                head.append('msgid_plural "%s"' % escape(e.plural))
                head.append('msgstr[0] ""')
                head.append('msgstr[1] ""')
            else:
                head.append('msgstr ""')
            head.append('')
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write('\n'.join(head))
        print('created %s' % os.path.relpath(path, ROOT))


def compile_mo():
    if not subprocess.run(['which', 'msgfmt'], capture_output=True).returncode == 0:
        print('! 找不到 msgfmt（gettext 未装），跳过 .mo；设置窗口的文案会保持中文', file=sys.stderr)
        return
    ok = True
    for locale in sorted(LOCALES):
        po = os.path.join(PO_DIR, locale + '.po')
        if not os.path.exists(po):
            continue
        out = os.path.join(MO_ROOT, locale, 'LC_MESSAGES', DOMAIN + '.mo')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        res = subprocess.run(['msgfmt', '-o', out, po], capture_output=True, text=True)
        if res.returncode != 0:
            ok = False
            print('msgfmt 失败 %s:\n%s' % (po, res.stderr), file=sys.stderr)
        else:
            print('mo  %s → %s' % (os.path.relpath(po, ROOT), os.path.relpath(out, ROOT)))
    if not ok:
        sys.exit(1)


def report():
    total = len(parse_po(POT)) if os.path.exists(POT) else 0
    for locale in sorted(LOCALES):
        po = os.path.join(PO_DIR, locale + '.po')
        if not os.path.exists(po):
            continue
        done = len(parsed_catalog(po))
        print('%-6s %3d/%-3d 已翻译' % (locale, done, total))
        if done < total:
            missing = [e.msgid for e in parse_po(po) if e.msgid and e.msgid not in parsed_catalog(po)]
            for msgid in missing[:10]:
                print('     未翻译: %s' % msgid)


def main():
    args = sys.argv[1:]
    if '--init' in args:
        init_po()
    if '--mo' in args:
        compile_mo()
        report()
        return
    if '--init' in args:
        return
    if not os.path.exists(POT):
        sys.exit('缺少 %s，先跑 tools/i18n-extract.py' % os.path.relpath(POT, ROOT))
    with open(JS_OUT, 'w', encoding='utf-8') as fh:
        fh.write(js_catalog())
    print('js  %s' % os.path.relpath(JS_OUT, ROOT))
    compile_mo()
    report()


if __name__ == '__main__':
    main()
