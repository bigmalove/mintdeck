// tests/auto-size.test.js
// 「随显示内容多少自动缩放」这条新行为的回归：
//   · 段数 → 高度（1 段 24 … 5 段 40，3 段正好等于标准档、5 段等于大档）
//   · 宽度贴着内容走（fitContent），不再按 shoulder+corner=28 留死白
//   · island.contentUnits() 数出来的段数与真正画出来的段数一致
//   · 内容撤掉（音乐停）时会重排 —— 以前 setNowPlaying(null) 直接 return，岛停在原来的宽度上

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const GEO = require('../mintdeck@bigmalove/lib/core/geometry.js');

// GI 桩（与 island.test.js 同一套最小实现，只够构造对象）
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
    ui: { draw: require(path.join(__dirname, '..', 'mintdeck@bigmalove', 'lib', 'ui', 'draw.js')) },
    core: { geometry: GEO }
  }
};

const { Island } = require('../mintdeck@bigmalove/lib/deck/island.js');
if (!hadImports) delete global.imports;
if (!hadStage) delete global.stage;

const MONITOR = { x: 0, y: 0, width: 1920, height: 1080 };
const WORK = { x: 0, y: 30, width: 1920, height: 1050 };

function islandWith(parts) {
  const island = new Island({ style: 'notch', theme: { colors: {} } });
  if (parts.clock) island.setClockText('11:13');
  if (parts.rings) island.setQuotas(parts.rings.map((p) => ({ percent: p })));
  if (parts.title) island.setNowPlaying({ title: parts.title, playing: true });
  return island;
}

test('段数 → 高度：24 / 28 / 32 / 36 / 40，越界被夹住', () => {
  const heights = [1, 2, 3, 4, 5].map((u) => GEO.autoHeight(u));
  assert.deepEqual(heights, [24, 28, 32, 36, 40], '每多一段加 4');
  assert.equal(GEO.autoHeight(0), 24, '没有段数也按 1 段（24 高）');
  assert.equal(GEO.autoHeight(-3), 24, '负数夹到下限');
  assert.equal(GEO.autoHeight(9), 40, '再多也停在 40（= 大档）');
  assert.equal(GEO.autoHeight(undefined), 24, '没传就当空内容');
});

test('3 段 = 标准档、5 段 = 大档：auto 与三档能一一对上', () => {
  const standard = GEO.presetSettings('standard');
  const large = GEO.presetSettings('large');
  const at3 = GEO.autoSettings(3);
  const at5 = GEO.autoSettings(5);
  // 高度相关的那几项必须逐值一致。宽度只是「没有内容时的兜底值」—— 自动档的真实宽度由内容算出来，
  // 所以这里只要求它随段数单调、且留在 CollapsedLimits 里。
  for (const key of ['notchHeight', 'capsuleHeight', 'capsuleTop', 'lineLength', 'lineThickness']) {
    assert.equal(at3[key], standard[key], `3 段的 ${key} 必须等于标准档`);
    assert.equal(at5[key], large[key], `5 段的 ${key} 必须等于大档`);
  }
  assert.ok(GEO.autoSettings(1).notchWidth < GEO.autoSettings(5).notchWidth, '兜底宽度随段数单调');
  assert.equal(at3.fitContent, true, 'auto 档要贴着内容算宽度');
  assert.equal(standard.fitContent, undefined, '固定档位不许带 fitContent');
});

test('内容缩放随段数走，且与表面高度同源', () => {
  const scales = [1, 2, 3, 4, 5].map((u) => GEO.contentScale('auto', 'notch', u));
  assert.deepEqual(scales, [0.75, 0.875, 1, 1.125, 1.25], 'scale = 高 / 32');
  assert.deepEqual([1, 5].map((u) => GEO.contentScale('auto', 'capsule', u)), [0.75, 1.25], '胶囊同上');
  const shape = GEO.resolve(GEO.presetSettings('auto', 2), 'notch', MONITOR, WORK);
  assert.equal(shape.scale, GEO.contentScale('auto', 'notch', 2), 'resolve 的 scale 与 contentScale 一致');
});

test('自动档宽度贴着内容：空边只剩 shoulder + 10*scale', () => {
  // 2 个环 + 时钟的内容宽度按 estimateText 估算后交给 geometry，表面宽度必须 = 内容 + 两侧留白
  const island = islandWith({ rings: [40, 70], clock: true });
  const units = island.contentUnits();
  const k = GEO.contentScale('auto', 'notch', units);
  const wanted = island.contentWidthEstimate(k);
  const shape = GEO.resolve(GEO.presetSettings('auto', units), 'notch', MONITOR, WORK, 2, wanted);

  const scale = shape.scale;
  const side = 16 + 10 * scale;                       // shoulder + sidePad*scale
  assert.equal(units, 3, '两个环 + 时钟 = 3 段');
  assert.equal(shape.surface.height, 32, '3 段 → 32 高');
  assert.equal(shape.inset, side, 'inset 就是那点留白');
  assert.equal(shape.surface.width, wanted + 2 * side, '宽度 = 内容 + 两侧留白，一分不多');
  // 内容盒正好装下内容 → 没有「两边都空着」
  assert.ok(Math.abs(shape.contentWidth - wanted) < 1e-9, 'contentWidth 必须等于内容宽度');
  // 与固定档位对比：同样的内容在标准档会被下限顶到 180 宽，两边各空 20 多像素
  const fixed = GEO.resolve(GEO.presetSettings('standard'), 'notch', MONITOR, WORK, 2, wanted);
  assert.equal(fixed.surface.width, 180, '固定档位仍按 notchWidthMin 180 兜底');
  assert.ok(fixed.surface.width - shape.surface.width > 30, '自动档必须明显更窄');
});

test('内容越多，岛越高越宽（同一份内容逐段增加）', () => {
  const steps = [
    { clock: true },                                 // 1 段
    { clock: true, rings: [50] },                    // 2 段
    { clock: true, rings: [50, 60] },                // 3 段
    { clock: true, rings: [50], title: '歌名' },      // 4 段（标题同时带律动条）
    { clock: true, rings: [50, 60], title: '歌名' }   // 5 段
  ];
  const shapes = steps.map((parts) => {
    const island = islandWith(parts);
    const units = island.contentUnits();
    const k = GEO.contentScale('auto', 'notch', units);
    const wanted = island.contentWidthEstimate(k);
    return Island.computeShape(GEO.presetSettings('auto', units), 'notch', MONITOR, WORK, 2, wanted);
  });
  const heights = shapes.map((s) => s.surface.height);
  assert.deepEqual(heights, [24, 28, 32, 36, 40], '1..5 段 → 24/28/32/36/40 高');
  for (let i = 1; i < shapes.length; i++) {
    assert.ok(shapes[i].surface.width > shapes[i - 1].surface.width, '内容变多，岛必须变宽');
  }
});

test('段数：封面 + 每个环 + 文字 + 律动 + 时钟，上限夹到 5', () => {
  const empty = new Island({ style: 'notch', theme: { colors: {} } });
  assert.equal(empty.contentUnits(), 0, '什么都没有就是 0 段');

  const clockOnly = islandWith({ clock: true });
  assert.equal(clockOnly.contentUnits(), 1);

  const withTitle = islandWith({ clock: true, title: '歌名' });
  assert.equal(withTitle.contentUnits(), 3, '标题同时带律动条');

  const dense = islandWith({ clock: true, title: '歌名', rings: [10, 20, 30] });
  assert.equal(dense.contentUnits(), 6, '3 环 + 文字 + 律动 + 时钟 = 6');
  assert.equal(GEO.autoUnits(dense.contentUnits()), 5, '超过上限时夹到 5');
});

test('内容撤掉会触发重排（音乐停 → 岛跟着缩回去）', () => {
  const island = islandWith({ rings: [40], title: '一首很长的歌名', clock: true });
  let relayouts = 0;
  island.onContentChanged = () => { relayouts += 1; };

  const wide = island.contentWidthEstimate();
  island.setNowPlaying(null);
  assert.equal(relayouts, 1, 'setNowPlaying(null) 必须回调一次');
  assert.ok(island.contentWidthEstimate() < wide, '内容变少，估算宽度必须变小');
  assert.equal(island.contentUnits(), 2, '只剩 1 个环 + 时钟');

  // 同样的内容再设一遍，不该重复重排
  island.setNowPlaying(null);
  assert.equal(relayouts, 1, '内容没变不重排');
});

test('三个档位名与 auto 都能被 sizeOf 认识', () => {
  assert.equal(GEO.sizeOf('auto'), 'auto');
  assert.equal(GEO.sizeOf('AUTO'), 'auto', '大小写不敏感');
  assert.equal(GEO.sizeOf('standard'), 'standard');
  const a = GEO.presetSettings('auto', 4);
  a.notchHeight = 999;
  assert.equal(GEO.presetSettings('auto', 4).notchHeight, 36, 'auto 也要返回副本');
});
