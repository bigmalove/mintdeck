#!/usr/bin/env python3
"""从源码里抽出所有界面文案，写成 po/mintdeck@local.pot。

为什么自己写而不是 xgettext：
  · 文案分布在三类文件里 —— JS（_(...) 与 n_(...) 调用）、settings-schema.json（description /
    title / tooltip / units / 选项标签）、metadata.json（小程序列表里的名字与简介）。
    xgettext 只认 JS，另外两类要单独抽出来再合并，反而更难维护。
  · 约定的 msgid 就是简体中文原文，不需要额外的 key 表。

用法：python3 tools/i18n-extract.py
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APPLET = os.path.join(ROOT, 'mintdeck@local')
POT = os.path.join(ROOT, 'po', 'mintdeck@local.pot')

# 这两个文件是工具链产物/查表实现，里面的中文字符串不是文案
SKIP_FILES = {
    os.path.join('lib', 'core', 'i18n.js'),
    os.path.join('lib', 'core', 'i18nData.js'),
}

# JS 字符串里的转义：源码里只可能出现 \\ \' \" \n \t，够用
_ESCAPES = {'n': '\n', 't': '\t', 'r': '\r', '\\': '\\', '"': '"', "'": "'"}


def js_unescape(raw):
    out = []
    i = 0
    while i < len(raw):
        ch = raw[i]
        if ch != '\\' or i + 1 >= len(raw):
            out.append(ch)
            i += 1
            continue
        nxt = raw[i + 1]
        out.append(_ESCAPES.get(nxt, nxt))
        i += 2
    return ''.join(out)


# _( '...' ) / _( "..." )；n_( '单数', '复数', n )；同样匹配 I18n.tn(...) 的简写 tn(...)
_T_CALL = re.compile(r"(?<![A-Za-z0-9_$.])(_)\s*\(\s*(['\"])((?:\\.|(?!\2).)*)\2", re.S)
_N_CALL = re.compile(
    r"(?<![A-Za-z0-9_$.])(n_|tn)\s*\(\s*(['\"])((?:\\.|(?!\2).)*)\2\s*,\s*(['\"])((?:\\.|(?!\4).)*)\4",
    re.S,
)


class Catalog:
    """msgid -> 记录。plural 为 None 表示单数条目。"""

    def __init__(self):
        self.entries = {}
        self.order = []

    def add(self, msgid, plural, ref):
        if not msgid:
            return
        key = (msgid, plural)
        if key in self.entries:
            refs = self.entries[key]['refs']
            if ref and len(refs) < 3 and ref not in refs:
                refs.append(ref)
            return
        self.entries[key] = {'msgid': msgid, 'plural': plural, 'refs': [ref] if ref else []}
        self.order.append(key)


def add_js(catalog, path):
    rel = os.path.relpath(path, ROOT)
    with open(path, encoding='utf-8') as fh:
        src = fh.read()
    for m in _N_CALL.finditer(src):
        line = src.count('\n', 0, m.start()) + 1
        catalog.add(js_unescape(m.group(3)), js_unescape(m.group(5)), '%s:%d' % (rel, line))
    for m in _T_CALL.finditer(src):
        line = src.count('\n', 0, m.start()) + 1
        catalog.add(js_unescape(m.group(3)), None, '%s:%d' % (rel, line))


def add_json_strings(catalog, path, rel):
    """settings-schema.json / metadata.json：值本身就是文案（不是 key-value 里的 key）。"""
    with open(path, encoding='utf-8') as fh:
        data = json.load(fh)

    def walk(node, key=None):
        if isinstance(node, dict):
            for k, v in node.items():
                if key == 'options' and isinstance(v, str):
                    # 选项标签是 key（"刘海": "notch"），这里拿到的是 k
                    catalog.add(k, None, rel)
                    continue
                if k in ('description', 'title', 'tooltip', 'units', 'name', 'description') and isinstance(v, str):
                    catalog.add(v, None, rel)
                walk(v, k)
        elif isinstance(node, list):
            for v in node:
                walk(v, key)

    if rel.endswith('metadata.json'):
        for k in ('name', 'description'):
            if isinstance(data.get(k), str):
                catalog.add(data[k], None, rel)
        return
    walk(data)


def pot_escape(text):
    return text.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\t', '\\t')


def write_pot(catalog):
    lines = [
        '# MintDeck 界面文案。由 tools/i18n-extract.py 生成，不要手改；改源码后重新生成。',
        'msgid ""',
        'msgstr ""',
        '"Project-Id-Version: mintdeck@local\\n"',
        '"Report-Msgid-Bugs-To: \\n"',
        '"MIME-Version: 1.0\\n"',
        '"Content-Type: text/plain; charset=UTF-8\\n"',
        '"Content-Transfer-Encoding: 8bit\\n"',
        '"X-Source-Language: zh_CN\\n"',
        '',
    ]
    for key in catalog.order:
        e = catalog.entries[key]
        for ref in e['refs']:
            lines.append('#: %s' % ref)
        lines.append('msgid "%s"' % pot_escape(e['msgid']))
        if e['plural'] is not None:
            lines.append('msgid_plural "%s"' % pot_escape(e['plural']))
            lines.append('msgstr[0] ""')
            lines.append('msgstr[1] ""')
        else:
            lines.append('msgstr ""')
        lines.append('')
    return '\n'.join(lines)


def main():
    catalog = Catalog()
    for base, dirs, files in os.walk(APPLET):
        dirs[:] = sorted(d for d in dirs if d not in ('.git', 'node_modules'))
        for name in sorted(files):
            if not name.endswith('.js'):
                continue
            path = os.path.join(base, name)
            if os.path.relpath(path, APPLET) in SKIP_FILES:
                continue
            add_js(catalog, path)

    add_json_strings(catalog, os.path.join(APPLET, 'settings-schema.json'), 'settings-schema.json')
    add_json_strings(catalog, os.path.join(APPLET, 'metadata.json'), 'metadata.json')

    os.makedirs(os.path.dirname(POT), exist_ok=True)
    with open(POT, 'w', encoding='utf-8') as fh:
        fh.write(write_pot(catalog))

    print('pot: %s (%d 条)' % (os.path.relpath(POT, ROOT), len(catalog.order)))
    if len(sys.argv) > 1 and sys.argv[1] == '--list':
        for key in catalog.order:
            e = catalog.entries[key]
            print('  %-40s %s' % (e['msgid'], ('plural: ' + e['plural']) if e['plural'] else ''))


if __name__ == '__main__':
    main()
