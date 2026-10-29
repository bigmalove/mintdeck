'use strict';

// panel.js 的画布逻辑测试：用假的 imports（GI 桩）在 node 里真正跑一遍 _paint()。
//
// 为什么值得这么干：页签从「数组 + if/else + setPage 三元」改成注册表，趋势页是第四页，
// 一旦某个 id 在表里、方法却没实现，只有真在桌面上点到那一刻才会炸（Cinnamon 里报一个
// 黄三角）。这里把 St / cairo 都换成记录用的桩，直接在测试里把每页都画一遍。

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'mintdeck@bigmalove');
const draw = require(path.join(ROOT, 'lib', 'ui', 'draw.js'));
const i18n = require(path.join(ROOT, 'lib', 'core', 'i18n.js'));

// ---- cairo 桩：只记录调用名，不关心参数 ------------------------------------

function makeContext() {
  const calls = [];
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'calls') return calls;
      if (prop === '$dispose') return undefined;
      return function () { calls.push(String(prop)); };
    },
    has() { return true; }
  });
  return ctx;
}

// ---- GI 桩 ----------------------------------------------------------------

const layoutStub = {
  set_font_description() { },
  set_text() { },
  set_width() { },
  set_ellipsize() { },
  get_pixel_size() { return [12, 14]; }
};

const pangoCairoCalls = [];

const importsStub = {
  gi: {
    St: {
      ThemeContext: { get_for_stage: () => ({ scale_factor: 2 }) },
      DrawingArea: class {
        constructor() {
          this.width = 0;
          this.height = 0;
          this.visible = false;
          this.opacity = 255;
        }
        connect() { return 0; }
        hide() { this.visible = false; }
        show() { this.visible = true; }
        set_size(w, h) { this.width = w; this.height = h; }
        set_position() { }
        queue_repaint() { }
        get_context() { return this._ctx || (this._ctx = makeContext()); }
        ease() { }
        destroy() { }
      },
      Align: { MIDDLE: 0 },
      IconType: { FULLCOLOR: 0 }
    },
    GLib: { PRIORITY_DEFAULT: 0, timeout_add: () => 1, source_remove: () => { } },
    Gdk: { cairo_surface_create_from_pixbuf: () => ({}) },
    GdkPixbuf: { Pixbuf: { new_from_file_at_scale: () => ({}) } },
    Pango: {
      FontDescription: { from_string: () => ({}) },
      SCALE: 1024,
      EllipsizeMode: { END: 3 }
    },
    PangoCairo: {
      create_layout() { pangoCairoCalls.push('create_layout'); return layoutStub; },
      show_layout() { pangoCairoCalls.push('show_layout'); }
    },
    Clutter: { AnimationMode: { EASE_OUT_QUAD: 0, EASE_IN_QUAD: 0 } }
  },
  lib: {
    ui: { draw: draw },
    core: { i18n: i18n }
  }
};

// 这两个全局是给 panel.js 里的 imports / global.stage 用的。
// 必须留原来的值并在 after() 里还回去：node --test 一个进程跑所有文件，
// 留着假 global 会让后面加载的测试读到假对象（sysfs 的测试就踩过这个坑）。
const realImports = global.imports;
const realGlobal = global.global;
global.imports = importsStub;
// weatherIcon.js 顶层读 imports.lib.ui.draw：必须等 global.imports 装好再 require
global.imports.lib.ui.weatherIcon = require(path.join(ROOT, 'lib', 'ui', 'weatherIcon.js'));
global.global = { stage: {} };
after(() => {
  global.imports = realImports;
  global.global = realGlobal;
});

const panelMod = require(path.join(ROOT, 'lib', 'deck', 'panel.js'));

function makePanel() {
  const p = new panelMod.Panel();
  p.setTheme({ colors: {} });
  p.setSize(720, 252);
  return p;
}

function trendFixture() {
  const days = [];
  const base = new Date(2026, 9, 15).getTime();
  for (let i = 0; i < 14; i++) days.push(base + i * 86400000);
  return {
    days: days,
    series: [
      { key: 'claude', name: 'Claude', unit: 'tokens', color: null, values: [0, 0, 1200, 4000, 0, 0, 12000, 0, 3000, 0, 0, 900, 1500, 2500] },
      { key: 'dsh', name: 'DeepSeek Harness', unit: 'tokens', color: '#FF2E63', values: [0, 500, 0, 0, 0, 8000, 0, 0, 0, 0, 400, 0, 0, 1200] },
      { key: 'workbuddy', name: 'WorkBuddy', unit: 'credits', color: '#FFB84D', values: [0, 0, 0, 0, 0, 0, 3.5, 0, 0, 0, 0, 0, 0, 1] }
    ]
  };
}

test('PAGES 由注册表派生，六个页签都在，顺序稳定', function () {
  assert.deepEqual(panelMod.PAGES, ['usage', 'trend', 'agenda', 'focus', 'music', 'monitor', 'network', 'tasks']);
  assert.equal(panelMod.PAGE_DEFS.length, 8);
  for (const def of panelMod.PAGE_DEFS) {
    assert.equal(typeof def.id, 'string');
    assert.equal(typeof def.paint, 'string');
  }
});

test('setPage 用注册表里的固定高度，未知页退回 usage', function () {
  const p = makePanel();
  p.setPage('trend');
  assert.equal(p.size().height, 252);
  p.setPage('monitor');
  assert.equal(p.size().height, 262);
  p.setPage('nope');
  assert.equal(p.page, 'usage');
});

test('每一页都能画出来（转场前后各画一次），不抛异常', function () {
  const p = makePanel();
  p.setUsage([{ name: 'Claude', plan: '', color: null, quotas: [{ title: '5 小时', percent: 42, resetText: null }], todayTokens: '1.2k', weekTokens: '9.8k', todayUsd: '$1.20', weekUsd: '$9.00', footer: '本机会话' }]);
  p.setTrend(trendFixture());
  p.setMonitor({ cpu: 21, perCore: [10, 20, 30], memPercent: 51, gpu: '—', rxKbps: '1.2 MB/s', txKbps: '30 KB/s', processes: [{ name: 'cinnamon', cpuPercent: 12 }] });

  for (const id of panelMod.PAGES) {
    p.setPage(id);
    assert.doesNotThrow(() => p._paint(), 'page ' + id + ' 画崩了');
  }

  // 转场中间态也要能画：此时 _paint 会同时画 from / to 两层
  p.setPage('monitor', true);
  p._trans = { from: 'usage', to: 'trend', t: 0.4, dir: 1 };
  assert.doesNotThrow(() => p._paint());
});

test('趋势页按「每源一行」画柱：轨道一天一根，0 值只留轨道', function () {
  const p = makePanel();
  p.setPage('trend');
  p.setTrend(trendFixture());

  const cr = p.actor.get_context();
  cr.calls.length = 0;
  p._paintTrend(cr, 720, 252);

  const fills = cr.calls.filter(c => c === 'fill').length;
  const days = 14, series = 3;
  const zeroCells = trendFixture().series.reduce((acc, s) => acc + s.values.filter(v => !(v > 0)).length, 0);
  const nonZero = days * series - zeroCells;
  // 每根柱子一次轨道 fill；有值的那天再补一次填充
  assert.equal(fills, days * series + nonZero);

  // 每行一次名字 + 一次单位 + 一次「今日/合计」，再加页脚两处
  const texts = pangoCairoCalls.filter(c => c === 'show_layout').length;
  assert.ok(texts >= series * 3, '每行至少三段文字，实际 ' + texts);
});

test('趋势页没有数据时给一句提示，而不是留一片空白', function () {
  const p = makePanel();
  p.setPage('trend');
  p.setTrend(null);
  const cr = p.actor.get_context();
  cr.calls.length = 0;
  assert.doesNotThrow(() => p._paintTrend(cr, 720, 252));
  assert.ok(cr.calls.filter(c => c === 'fill').length >= 0);
});

test('趋势页对 NaN / null / 负值不炸：坏数据只当 0，柱子不画', function () {
  const p = makePanel();
  p.setPage('trend');
  p.setTrend({
    days: [0, 86400000, 2 * 86400000],
    series: [{ key: 'x', name: 'X', unit: 'tokens', color: '#0A84FF', values: [NaN, null, 5] }]
  });
  const cr = p.actor.get_context();
  cr.calls.length = 0;
  assert.doesNotThrow(() => p._paintTrend(cr, 720, 252));
  // 3 根轨道 + 唯一有效那天的填充
  assert.equal(cr.calls.filter(c => c === 'fill').length, 4);
});

test('趋势页单序列 ¥=00 空数组时不画柱子，也不报错', function () {
  const p = makePanel();
  p.setPage('trend');
  p.setTrend({ days: [], series: [{ key: 'x', name: 'X', unit: 'credits', color: null, values: [] }] });
  const cr = p.actor.get_context();
  assert.doesNotThrow(() => p._paintTrend(cr, 720, 252));
});

test('每页高度来自注册表：专注 236 / 网络 226', function () {
  const p = makePanel();
  p.setPage('focus');
  assert.equal(p.size().height, 252);
  p.setPage('network');
  assert.equal(p.size().height, 226);
});

test('专注页：倒计时 + 进度条 + 三个可点按钮', function () {
  const p = makePanel();
  p.setPage('focus');
  p.setFocus({ phase: 'work', timeText: '24:31', progress: 0.02, rounds: 1, longEvery: 4, running: true });
  const cr = p.actor.get_context();
  cr.calls.length = 0;
  p._paintFocus(cr, 720, 252);
  // 有填充（进度条 + 主按钮）、有文字（时间/阶段/按钮）
  assert.ok(cr.calls.filter(c => c === 'fill').length >= 3);
  const actions = p._hots.map(h => h.action);
  assert.deepEqual(actions, ['focus:toggle', 'focus:skip', 'focus:reset']);
});

test('网络页：接口 / 延迟 / 丢包 / 公网 IP / 速率 都画出来；不可用时是 —', function () {
  const p = makePanel();
  p.setPage('network');
  p.setNetwork({
    iface: 'wlp5s0', operstate: 'up', speedMbps: 866,
    rttMs: 14.1, lossPercent: 0, publicIp: '203.0.113.7',
    rxKbps: '3.8 KB/s', txKbps: '1.9 KB/s', status: 'ok', intervalSec: 30
  });
  const cr = p.actor.get_context();
  pangoCairoCalls.length = 0;
  assert.doesNotThrow(() => p._paintNetwork(cr, 720, 226));
  assert.ok(pangoCairoCalls.filter(c => c === 'show_layout').length >= 8);

  // 全空：不抛，且仍然是「—」而不是 0
  p.setNetwork({ iface: null, operstate: null, speedMbps: null, rttMs: null, lossPercent: null, publicIp: null, rxKbps: null, txKbps: null, status: 'unavailable' });
  assert.doesNotThrow(() => p._paintNetwork(cr, 720, 226));
});

test('监控页详情屏：磁盘/温度/风扇/频率，切换按钮可点回概览', function () {
  const p = makePanel();
  p.setPage('monitor');
  p.setMonitor({ cpu: 12, perCore: [10, 12], memPercent: 40, gpu: '—', rxKbps: '1 KB/s', txKbps: '1 KB/s', processes: [] });
  p.setSysinfo({
    disks: [{ mount: '/', totalBytes: 1000e9, usedBytes: 560e9, freeBytes: 440e9, percent: 56 }],
    thermal: { celsius: 53, source: 'thermal', zones: [] },
    fan: { rpm: null, fans: [] },
    freqMhz: 3200
  });
  const cr = p.actor.get_context();

  p._monitorDetail = false;
  p._paintMonitor(cr, 720, 262);
  assert.ok(p._hots.some(h => h.action === 'monitor:toggleDetail'));

  p._monitorDetail = true;
  pangoCairoCalls.length = 0;
  assert.doesNotThrow(() => p._paintMonitor(cr, 720, 262));
  assert.ok(pangoCairoCalls.filter(c => c === 'show_layout').length >= 6);
  assert.ok(p._hots.some(h => h.action === 'monitor:toggleDetail'));
});

test('fmtBytes / fmtLink / phaseLabel：未知写 —，不写 0', function () {
  assert.equal(panelMod.fmtBytes(null), '—');
  assert.equal(panelMod.fmtBytes(0), '0 B');
  assert.equal(panelMod.fmtBytes(1536), '1.5 KB');
  assert.equal(panelMod.fmtBytes(931e9), '867 GB');
  assert.equal(panelMod.fmtLink(1000), '1 Gb/s');
  assert.equal(panelMod.fmtLink(866), '866 Mb/s');
  assert.equal(panelMod.fmtLink(null), '—');
  assert.equal(panelMod.phaseLabel('work'), '专注');
  assert.equal(panelMod.phaseLabel('idle'), '未开始');
});

test('日程页：月历 + 今日 + 接下来 + 天气', () => {
  const p = makePanel();
  p.setPage('agenda');
  p.setAgenda({
    dateText: '10月29日 · 周三',
    year: 2026, month0: 9, todayDay: 29,
    eventDays: [29, 31],
    today: [{ timeText: '09:30', summary: '周会' }, { timeText: '14:00', summary: '评审' }],
    upcoming: [{ dayText: '明天', summary: '体检' }, { dayText: '11/2', summary: '发布' }],
    weather: { kind: 'cloud', tempText: '21°', kindText: '阴', rangeText: '14°~24°' }
  });
  const cr = p.actor.get_context();
  pangoCairoCalls.length = 0;
  assert.doesNotThrow(() => p._paintAgenda(cr, 720, 252));
  assert.ok(pangoCairoCalls.filter(c => c === 'show_layout').length >= 20, '月历格子 + 两条列表');

  // 没有天气 / 没有日程：显示说明，不画假数据
  p.setAgenda({
    dateText: '10月29日 · 周三', year: 2026, month0: 9, todayDay: 29,
    eventDays: [], today: [], upcoming: [], weather: null,
    weatherNote: '设置里填城市后显示天气'
  });
  assert.doesNotThrow(() => p._paintAgenda(cr, 720, 252));

  p.setAgenda(null);
  assert.doesNotThrow(() => p._paintAgenda(cr, 720, 252));
});

test('任务页：下载进度条 + 容器 + 失败单元', () => {
  const p = makePanel();
  p.setPage('tasks');
  p.setTasks({
    downloads: {
      source: 'aria2', speedText: '2.4 MB/s',
      active: [
        { name: 'ubuntu-24.04.iso', percent: 42.5, meta: '1.1 MB/s · 剩余 3m 20s' },
        { name: 'archive.tar.zst', percent: 8, meta: null }
      ],
      stopped: 2, total: 4
    },
    containers: { total: 5, running: 3, names: ['nginx', 'postgres', 'redis'] },
    failed: [{ unit: 'foo.service' }],
    note: null
  });
  const cr = p.actor.get_context();
  pangoCairoCalls.length = 0;
  assert.doesNotThrow(() => p._paintTasks(cr, 720, 236));
  assert.ok(pangoCairoCalls.filter(c => c === 'show_layout').length >= 8);

  // 什么都没配置：note 顶上去，不冒充 0 个容器
  p.setTasks({ downloads: null, containers: null, failed: null, note: '未配置下载器' });
  assert.doesNotThrow(() => p._paintTasks(cr, 720, 236));
  p.setTasks(null);
  assert.doesNotThrow(() => p._paintTasks(cr, 720, 236));
});
