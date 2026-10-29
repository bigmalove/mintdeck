// tests/i18n.test.js
// 多语言这条线的回归：
//   · locale 归一与回退（zh_TW.UTF-8 → zh_TW、de_DE → 中文、未知 msgid → 原文）
//   · 占位符（%s / %d / %%）、复数（en 分单复数，ja/zh 不分）
//   · 译文完整性：源码里出现的每个 msgid 在每门语言里都有译文，占位符数量一致
//   · 没有裸中文：deck 层与 applet.js 里的中文字符串必须都包在 _() / tn() 里
//   · i18nData.js 与 po 同步（改了 po 忘了跑 tools/i18n-build.py 会被这条抓住）
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APPLET = path.join(ROOT, 'mintdeck@local');
const I18n = require(path.join(APPLET, 'lib', 'core', 'i18n.js'));
const Data = require(path.join(APPLET, 'lib', 'core', 'i18nData.js'));

// 每次 setLocale 都动全局状态，test 之间互不影响：统一在 beforeEach 里重置
const CATALOG = Data.CATALOG;
test.beforeEach(() => {
  I18n.setCatalog(CATALOG);
  I18n.setLocale('zh_CN');
});

// ---------------------------------------------------------------- locale

test('normalize：编码后缀、连字符、大小写、繁简', () => {
  assert.equal(I18n.normalize('zh_CN.UTF-8'), 'zh_CN');
  assert.equal(I18n.normalize('zh-tw'), 'zh_TW');
  assert.equal(I18n.normalize('zh-Hant-HK'), 'zh_TW');
  assert.equal(I18n.normalize('zh_Hans_SG'), 'zh_CN');
  assert.equal(I18n.normalize('ja_JP@calendar'), 'ja_JP');
  assert.equal(I18n.normalize('EN'), 'en');
  assert.equal(I18n.normalize(''), '');
  assert.equal(I18n.normalize('C'), '');          // 「没有 locale」，不是一门语言
  assert.equal(I18n.normalize('POSIX'), '');
});

test('pickLocale：按 GLib.get_language_names() 的顺序取第一个有词典的', () => {
  assert.equal(I18n.pickLocale(['zh_TW.UTF-8', 'zh_TW', 'zh', 'C']), 'zh_TW');
  assert.equal(I18n.pickLocale(['ja_JP.UTF-8', 'ja', 'C']), 'ja');
  assert.equal(I18n.pickLocale(['en_GB.UTF-8', 'en', 'C']), 'en');
  // 没词典的语言统一回落简体中文（msgid 本身）
  assert.equal(I18n.pickLocale(['de_DE.UTF-8', 'de', 'C']), 'zh_CN');
  assert.equal(I18n.pickLocale([]), 'zh_CN');
});

test('setLocale / 回退链：选定 → 基语言 → 中文', () => {
  I18n.setLocale('en');
  assert.equal(I18n.getLocale(), 'en');
  assert.equal(I18n.t('设置…'), 'Settings…');

  // de_AT 没有词典，基语言 de 也没有 → 回落中文原文
  I18n.setLocale('de_AT');
  assert.equal(I18n.t('设置…'), '设置…');

  // 词典里没有的 msgid 永远原样返回，不会出现空串
  assert.equal(I18n.t('不存在的文案'), '不存在的文案');
});

// ---------------------------------------------------------------- 格式化

test('format：%s / %d / %% 与缺参数', () => {
  assert.equal(I18n.format('%s 个会话', ['12']), '12 个会话');
  assert.equal(I18n.format('%d%%', [42.6]), '43%');
  assert.equal(I18n.format('100%%'), '100%');
  // 参数比占位符少：剩下的占位符保持原样，不抛异常
  assert.equal(I18n.format('%s/%s', ['a']), 'a/%s');
  assert.equal(I18n.format(null), '');
});

test('t()：占位符按顺序代入', () => {
  I18n.setLocale('en');
  assert.equal(I18n.t('%s 个会话 · 累计 %s 积分', 16, '1.2k'), '16 sessions · 1.2k credits total');
  assert.equal(I18n.t('读取失败：%s', 'EACCES'), 'Read failed: EACCES');
});

// ---------------------------------------------------------------- 复数

test('tn()：en 分单复数，ja / zh 不分', () => {
  I18n.setLocale('en');
  assert.equal(I18n.tn('%s 天前', '%s 天前', 1), '1 day ago');
  assert.equal(I18n.tn('%s 天前', '%s 天前', 3), '3 days ago');
  assert.equal(I18n.tn('%s 个月前', '%s 个月前', 2), '2 months ago');

  I18n.setLocale('ja');
  assert.equal(I18n.tn('%s 天前', '%s 天前', 1), '1 日前');
  assert.equal(I18n.tn('%s 天前', '%s 天前', 7), '7 日前');                       // 日语不分单复数
  assert.equal(I18n.pluralIndex(1, 'ja'), 0);
  assert.equal(I18n.pluralIndex(9, 'zh_TW'), 0);
  assert.equal(I18n.pluralIndex(1, 'en'), 0);
  assert.equal(I18n.pluralIndex(0, 'en'), 1);
});

// ---------------------------------------------------------------- 译文完整性

// 与 tools/i18n-extract.py 等价的抽取（测试里不依赖 python）：
// _( '...' ) / _( "..." ) / tn( '单数', '复数', n )
const RE_T = /(?<![A-Za-z0-9_$.])_\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
const RE_TN = /(?<![A-Za-z0-9_$.])tn\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*,\s*(['"])((?:\\.|(?!\3).)*)\3/g;

function jsString(raw) {
  return raw.replace(/\\(.)/g, (m, c) => ({ n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" }[c] || c));
}

function collectMsgids() {
  const msgids = new Map();          // msgid -> 出处
  const files = [path.join(APPLET, 'applet.js')];
  const deckDir = path.join(APPLET, 'lib', 'deck');
  for (const name of fs.readdirSync(deckDir).sort()) {
    if (name.endsWith('.js')) files.push(path.join(deckDir, name));
  }
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    for (const m of src.matchAll(RE_TN)) {
      msgids.set(jsString(m[2]), rel);
      msgids.set(jsString(m[4]), rel);
    }
    for (const m of src.matchAll(RE_T)) msgids.set(jsString(m[2]), rel);
  }

  // 设置项：description / title / tooltip / units 的值 + options 的标签（键）
  const schema = JSON.parse(fs.readFileSync(path.join(APPLET, 'settings-schema.json'), 'utf8'));
  (function walk(node, key) {
    if (Array.isArray(node)) return node.forEach(v => walk(v, key));
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (key === 'options' && typeof v === 'string') msgids.set(k, 'settings-schema.json');
      else if (['description', 'title', 'tooltip', 'units'].includes(k) && typeof v === 'string') {
        msgids.set(v, 'settings-schema.json');
      }
      walk(v, k);
    }
  })(schema, null);

  // 小程序列表里的名字与简介（ExtensionCore / xlet-settings 也是拿 uuid 当 domain 翻译的）
  const meta = JSON.parse(fs.readFileSync(path.join(APPLET, 'metadata.json'), 'utf8'));
  for (const k of ['name', 'description']) if (typeof meta[k] === 'string') msgids.set(meta[k], 'metadata.json');

  return msgids;
}

const TRANSLATED_LOCALES = ['en', 'zh_TW', 'ja'];

test('每门语言都翻全了源码里的 msgid', () => {
  const msgids = collectMsgids();
  assert.ok(msgids.size > 90, '抽出来的 msgid 太少，抽取规则可能坏了：' + msgids.size);

  for (const locale of TRANSLATED_LOCALES) {
    const cat = CATALOG[locale];
    assert.ok(cat, '缺少 ' + locale + ' 词典（po/' + locale + '.po 没有编译进来）');
    const missing = [...msgids.keys()].filter(id => !Object.prototype.hasOwnProperty.call(cat, id));
    assert.deepEqual(missing, [], locale + ' 漏译：' + missing.slice(0, 5).join(' / '));
  }
});

test('译文与原文的占位符数量一致', () => {
  const msgids = collectMsgids();
  const count = (s) => (String(s).match(/%(s|d)/g) || []).length;

  for (const locale of TRANSLATED_LOCALES) {
    const cat = CATALOG[locale];
    for (const id of msgids.keys()) {
      const value = cat ? cat[id] : undefined;
      if (value === undefined) continue;          // 上一条测试负责报漏译
      const forms = Array.isArray(value) ? value : [value];
      for (const form of forms) {
        assert.equal(count(form), count(id),
          locale + ' 的占位符对不上：' + JSON.stringify(id) + ' → ' + JSON.stringify(form));
      }
    }
  }
});

// 品牌名、主题名、语言自称、以及本来就是英文的 'used' / '%' 不翻译
const IDENTITY = new Set([
  'MintDeck', 'One Dark Pro', 'GitHub Dark', 'GitHub Light', 'Dracula', 'Night Owl',
  'English', '繁體中文', '日本語', '简体中文', 'used', '%',
]);

test('英文没有「译文等于原文」的漏译', () => {
  // 只对英文做这条严格判断：繁體中文与日语里有大量与中文同形的词（今日 / 小 / 大 / 上下文 / 尺寸），
  // 用「是否相等」判不出来，那两门语言由下面的抽查表 + 占位符测试守。
  const msgids = collectMsgids();
  const cat = CATALOG.en || {};
  for (const id of msgids.keys()) {
    if (IDENTITY.has(id)) continue;
    const value = cat[id];
    if (value === undefined || Array.isArray(value)) continue;
    assert.notEqual(value, id, 'en 里这条还是中文：' + id);
  }
});

// 抽查几组「一定会变」的核心文案：改错语言（比如把简体直接当繁体）会被抓住
const SPOT_CHECKS = {
  'zh_TW': {
    '设置…': '設定…',
    '读取失败': '讀取失敗',
    '界面语言': '介面語言',
    '系统监控': '系統監控',
    '在面板上显示图标（隐藏后右键悬浮岛可进入设置）':
      '在面板上顯示圖示（隱藏後在懸浮島上按右鍵可進入設定）',
  },
  'ja': {
    '设置…': '設定…',
    '读取失败': '読み込み失敗',
    '音乐': '音楽',
    '界面语言': '表示言語',
    '未登录 · 仅本机用量': '未ログイン · ローカル使用量のみ',
  },
};

test('zh_TW / ja 抽查：核心文案是真译过的', () => {
  for (const [locale, table] of Object.entries(SPOT_CHECKS)) {
    for (const [id, expected] of Object.entries(table)) {
      assert.equal(CATALOG[locale][id], expected, locale + ' 的这条译文变了：' + id);
    }
  }
});

// ---------------------------------------------------------------- 同步与裸中文

// 只认本仓库会用到的那点语法：msgid / msgid_plural / msgstr / msgstr[n]，多行续写
function parsePo(text) {
  const out = new Map();
  let cur = null, field = null, index = null;
  const unesc = (s) => s.replace(/\\(.)/g, (m, c) => ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }[c] || c));

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) { if (cur && cur.msgid) out.set(cur.msgid, cur); cur = null; field = null; index = null; continue; }
    if (line.startsWith('#')) continue;
    const m = line.match(/^(msgid_plural|msgid|msgstr(?:\[(\d+)\])?)\s+"(.*)"$/);
    if (m) {
      if (!cur) cur = { msgid: '', plural: null, msgstr: '', msgstrs: {} };
      if (m[1] === 'msgid') { cur.msgid = unesc(m[3]); field = 'msgid'; }
      else if (m[1] === 'msgid_plural') { cur.plural = unesc(m[3]); field = 'plural'; }
      else { index = m[2] === undefined ? null : Number(m[2]); field = 'msgstr'; if (index === null) cur.msgstr = unesc(m[3]); else cur.msgstrs[index] = unesc(m[3]); }
      continue;
    }
    if (cur && field && line.startsWith('"')) {
      const val = unesc(line.slice(1, -1));
      if (field === 'msgid') cur.msgid += val;
      else if (field === 'plural') cur.plural = (cur.plural || '') + val;
      else if (index === null) cur.msgstr += val;
      else cur.msgstrs[index] = (cur.msgstrs[index] || '') + val;
    }
  }
  if (cur && cur.msgid) out.set(cur.msgid, cur);
  return out;
}

test('i18nData.js 与 po/*.po 同步（改了 po 要重跑 tools/i18n-build.py）', () => {
  for (const locale of TRANSLATED_LOCALES) {
    const po = parsePo(fs.readFileSync(path.join(ROOT, 'po', locale + '.po'), 'utf8'));
    const cat = CATALOG[locale] || {};
    for (const [msgid, entry] of po) {
      if (!entry.msgstr && !Object.keys(entry.msgstrs).length) continue;    // 未翻译
      assert.ok(Object.prototype.hasOwnProperty.call(cat, msgid),
        locale + '.po 里有 ' + JSON.stringify(msgid) + ' 但 i18nData.js 没有 —— 跑 tools/i18n-build.py');
      const expected = entry.plural ? [entry.msgstrs[0] || '', entry.msgstrs[1] || entry.msgstrs[0] || ''] : entry.msgstr;
      assert.deepEqual(cat[msgid], expected, locale + ' 的译文不是最新：' + msgid);
    }
  }
});

test('deck 层与 applet.js 没有裸中文字符串（必须走 _() / tn()）', () => {
  const files = [path.join(APPLET, 'applet.js')];
  const deckDir = path.join(APPLET, 'lib', 'deck');
  for (const name of fs.readdirSync(deckDir).sort()) {
    if (name.endsWith('.js')) files.push(path.join(deckDir, name));
  }

  const offenders = [];
  for (const file of files) {
    let src = fs.readFileSync(file, 'utf8');
    // 去掉注释（字符串里的 // 不影响判断：这里只找中文字面量，注释里没有引号包围）
    src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    // 去掉 _() / tn() 的字符串实参，剩下的引号里就不该再有中文
    src = src.replace(RE_TN, '__TN__').replace(RE_T, '__T__');
    const re = /(['"])((?:\\.|(?!\1).)*[\u3400-\u9fff\u3000-\u303f\uff00-\uffef](?:\\.|(?!\1).)*)\1/g;
    for (const m of src.matchAll(re)) offenders.push(path.relative(ROOT, file) + ': ' + m[2]);
  }
  assert.deepEqual(offenders, [], '这些中文字符串没包 i18n：\n' + offenders.join('\n'));
});
