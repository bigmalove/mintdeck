// tests/island.test.js
// 覆盖"改档位后内容要跟着变"这条回归：island.js 依赖 imports.gi，这里用最小桩把它拉进 node，
// 测构造 / 度量 / 宽度估算，以及天气段的绘制路径（cairo 桩只记录调用名）。
// 以前的 bug 就是表面变大、字体和图标纹丝不动 —— 那组断言在这里锁住。

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const GEO = require('../mintdeck@bigmalove/lib/core/geometry.js');

// ---- GI 桩：只提供 island.js 顶层与构造函数用到的那些，全部无副作用
// 先记下装桩前的状态，装完立即撤（见文件末尾的 require 处）
const hadImports = 'imports' in global;
const hadStage = 'stage' in global;
global.stage = {};
global.imports = {
  gi: {
    St: {
      DrawingArea: class {
        constructor() { this.width = 0; this.height = 0; }
        connect() { return 0; }
        set_position(x, y) { this.x = x; this.y = y; }
        set_size(w, h) { this.width = w; this.height = h; }
        queue_repaint() {}
        destroy() {}
        get_context() { return null; }
      },
      ThemeContext: { get_for_stage: () => ({ scale_factor: 2 }) }
    },
    GLib: { timeout_add: () => 1, PRIORITY_DEFAULT: 0, source_remove() {} },
    Gdk: {},
    GdkPixbuf: {},
    Pango: { FontDescription: { from_string: (s) => s }, SCALE: 1024, EllipsizeMode: { END: 3 } },
    PangoCairo: {
      create_layout() {
        return {
          set_font_description() { },
          set_text() { },
          set_width() { },
          set_ellipsize() { },
          get_pixel_size() { return [30, 12]; },
          get_pixel_extents() { return [{ x: 0, y: 0, width: 30, height: 12 }, { x: 0, y: 0, width: 30, height: 12 }]; }
        };
      },
      show_layout() { }
    }
  },
  lib: {
    // 真实 draw.js 是纯 JS，直接复用，别再造一份假实现
    ui: {
      draw: require(path.join(__dirname, '..', 'mintdeck@bigmalove', 'lib', 'ui', 'draw.js'))
    },
    core: { geometry: GEO }
  }
};

// 桩只在把 island.js 拉进内存时需要；之后立刻撤掉，否则后面 require 的 lib/linux/*
// 会把桩里的 imports.gi 当成真的 GJS 环境（lyrics.js 就要写 imports.gi.versions.Soup）。
// weatherIcon.js 顶层要读 imports.lib.ui.draw，所以必须等 global.imports 装好之后再 require
// （写在对象字面量里的话，require 那一刻 global.imports 还没赋值，会 ReferenceError）。
global.imports.lib.ui.weatherIcon = require(path.join(__dirname, '..', 'mintdeck@bigmalove', 'lib', 'ui', 'weatherIcon.js'));

// tests/index.js 把全部测试 require 进同一个进程，auto-size.test.js 可能已经用它的
// 最小桩加载过 island.js（那份桩没有 weatherIcon、PangoCairo 也没有 create_layout）。
// 这里清掉模块缓存，用本文件的桩重新加载，别吃别人的缓存。
const ISLAND_PATH = require.resolve('../mintdeck@bigmalove/lib/deck/island.js');
delete require.cache[ISLAND_PATH];
const { Island } = require(ISLAND_PATH);
if (!hadImports) delete global.imports;
if (!hadStage) delete global.stage;

// 固定一份内容：标题 + 时钟 + 两个配额环 + 律动条，覆盖所有会缩放的段
function makeIsland() {
  const island = new Island({ style: 'notch', theme: { colors: {} } });
  island.setNowPlaying({ title: '中文标题abc', playing: true });
  island.setClockText('12:34');
  island.setQuotas([{ percent: 50 }, { percent: 80 }]);
  return island;
}

test('档位驱动内容缩放：字体、时钟、封面、环、律动条都跟着变大', () => {
  const island = makeIsland();
  const sizes = ['compact', 'standard', 'large'];
  const metrics = sizes.map(s => island._metrics(GEO.contentScale(s, 'notch')));

  // 字体：11.5 基准 × 0.8125 / 1 / 1.25，按半像素取整
  assert.deepEqual(metrics.map(m => m.fontUi), [9.5, 11.5, 14.5], '正文字号');
  assert.deepEqual(metrics.map(m => m.fontClock), [10, 12, 15], '时钟字号');
  // 封面 20、环 18、律动条 22：都是同一套缩放
  assert.deepEqual(metrics.map(m => m.cover), [16.25, 20, 25], '封面边长');
  assert.deepEqual(metrics.map(m => m.ring), [14.625, 18, 22.5], '配额环直径');
  assert.deepEqual(metrics.map(m => m.eqWidth), [17.875, 22, 27.5], '律动条宽度');
  assert.deepEqual(metrics.map(m => m.gap), [4.875, 6, 7.5], '段间距');
});

test('自动宽度随档位变宽（大档的岛必须比小档宽）', () => {
  const island = makeIsland();
  const w = ['compact', 'standard', 'large'].map(s => island.contentWidthEstimate(GEO.contentScale(s, 'notch')));
  assert.deepEqual(w, [148, 182, 227], '三段内容的估算宽度');
  assert.ok(w[0] < w[1] && w[1] < w[2], '小 < 标准 < 大');
});

test('shape 还没有时按 1 倍内容缩放，不炸也不跳', () => {
  const island = makeIsland();
  assert.equal(island._metrics().fontUi, 11.5, '没有 shape 时回落 1 倍');
  // 内容缩放被夹在 0.75..2（与 CollapsedLimits.contentMinScale / 高上限 64 对应）
  assert.equal(island._metrics(0.1).fontUi, 8.5, '0.1 被抬到 0.75 → 11.5*0.75 = 8.625 → 8.5');
  assert.equal(island._metrics(9).fontUi, 23, '9 被压到 2 → 23');
});

test('柔影有完整绘制余量，且表面仍落在原位置', () => {
  const island = new Island({ style: 'notch', theme: { colors: {} } });
  island.applyShape({ style: 'notch', surface: { x: 851, y: 0, width: 238, height: 32 } });
  assert.equal(island.actor.x, 835, '左侧给阴影留 16px');
  assert.equal(island.actor.y, 0, '刘海仍贴顶');
  assert.equal(island.actor.width, 270, '左右各留 16px');
  assert.equal(island.actor.height, 48, '下方留 16px');
  assert.equal(island._pad, 16, '表面绘制时向右补回余量');
});

test('指示条不扩大阴影画布', () => {
  const island = new Island({ style: 'line', theme: { colors: {} } });
  island.applyShape({ style: 'line', surface: { x: 942, y: 4, width: 56, height: 4 } });
  assert.equal(island.actor.x, 942);
  assert.equal(island.actor.y, 4);
  assert.equal(island.actor.width, 56);
  assert.equal(island.actor.height, 4);
  assert.equal(island._pad, 0);
});

// ---------------------------------------------------------------- 收起态天气

// cairo 桩：只要记录调用名。island 的绘制路径里有 translate / clip / arc / fill 这些，
// 天气图标和文字各走一遍；这里不做像素比较，只锁「有没有画」和「会不会抛」。
function makePaintContext() {
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

test('收起态天气：图标 + 温度占一段，撤掉后回到原样', () => {
  const island = new Island({ style: 'notch', theme: { colors: {} } });
  island.setClockText('12:34');
  const baseW = island.contentWidthEstimate(1);
  const baseUnits = island.contentUnits();

  island.setWeather({ tempText: '21°', kind: 'partly' });
  assert.equal(island.contentUnits(), baseUnits + 1, '天气算一段');
  // 15（图标）+ 3（缝）+ '21°' 的估算宽度（3 个西文字 × 6.6 = 19.8）+ 6（段间距）= 43.8 → 44
  assert.equal(island.contentWidthEstimate(1) - baseW, 44, '宽度 = 图标 + 缝 + 温度字 + 段间距');

  island.setWeather(null);
  assert.equal(island.contentUnits(), baseUnits);
  assert.equal(island.contentWidthEstimate(1), baseW, '撤掉天气不留白');
});

test('天气只有图标 / 只有温度 / 空对象：不造空段，也不留占位', () => {
  const island = new Island({ style: 'notch', theme: { colors: {} } });
  const base = island.contentWidthEstimate(1);
  const baseUnits = island.contentUnits();

  island.setWeather({ kind: 'clear' });
  assert.equal(island.contentUnits(), baseUnits + 1);
  assert.equal(island.contentWidthEstimate(1) - base, 21, '只有图标：15 + 尾巴 6');

  island.setWeather({ tempText: '21°' });
  assert.equal(island.contentUnits(), baseUnits + 1);
  assert.equal(island.contentWidthEstimate(1) - base, 26, '只有温度：19.8 + 6 → 差 26');

  island.setWeather({ kind: null, tempText: '' });
  assert.equal(island.contentUnits(), baseUnits);
  assert.equal(island.contentWidthEstimate(1), base, '空对象不是一段');
});

test('天气变化只在内容指纹变了时通知重排', () => {
  const island = new Island({ style: 'notch', theme: { colors: {} } });
  let calls = 0;
  island.onContentChanged = () => { calls += 1; };

  island.setWeather({ tempText: '21°', kind: 'rain' });
  assert.equal(calls, 1, '多一段要重排');
  island.setWeather({ tempText: '21°', kind: 'rain' });
  assert.equal(calls, 1, '同温度同分组不重排');
  // 同温度同宽度：分组变了只换图形（repaint），不必重排
  island.setWeather({ tempText: '21°', kind: 'clear' });
  assert.equal(calls, 1, '同宽度只换图标不重排');
  island.setWeather({ tempText: '21°', kind: 'rain' });
  assert.equal(calls, 1, '同宽度不同分组也不重排');
  island.setWeather(null);
  assert.equal(calls, 2, '撤掉一段要重排');
});

test('收起态绘制：有天气时画出图标与温度，且不抛异常', () => {
  const island = new Island({ style: 'notch', theme: { colors: {} } });
  island.applyShape({ style: 'notch', surface: { x: 0, y: 0, width: 238, height: 32 }, inset: 30, scale: 1 });
  island.setClockText('12:34');

  const noWeather = makePaintContext();
  island._paintContent(noWeather, 238, 32);
  assert.equal(noWeather.calls.includes('translate'), false, '没有天气就不该走图标的 translate');

  island.setWeather({ tempText: '21°', kind: 'rain' });
  const withWeather = makePaintContext();
  island._paintContent(withWeather, 238, 32);
  assert.ok(withWeather.calls.includes('clip'), '内容先裁在表面里');
  assert.ok(withWeather.calls.includes('translate'), '天气图标按中心坐标平移后绘制');
  assert.ok(withWeather.calls.includes('scale'), '图标按档位缩放');
});
