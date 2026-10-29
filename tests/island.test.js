// tests/island.test.js
// 覆盖"改档位后内容要跟着变"这条回归：island.js 依赖 imports.gi，这里用最小桩把它拉进 node，
// 只测构造 / 度量 / 宽度估算，不碰真实绘制（_paint 需要 cairo context）。
// 以前的 bug 就是表面变大、字体和图标纹丝不动 —— 那组断言在这里锁住。

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const GEO = require('../mintdeck@local/lib/core/geometry.js');

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
    PangoCairo: {}
  },
  lib: {
    // 真实 draw.js 是纯 JS，直接复用，别再造一份假实现
    ui: { draw: require(path.join(__dirname, '..', 'mintdeck@local', 'lib', 'ui', 'draw.js')) },
    core: { geometry: GEO }
  }
};

// 桩只在把 island.js 拉进内存时需要；之后立刻撤掉，否则后面 require 的 lib/linux/*
// 会把桩里的 imports.gi 当成真的 GJS 环境（lyrics.js 就要写 imports.gi.versions.Soup）。
const { Island } = require('../mintdeck@local/lib/deck/island.js');
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
