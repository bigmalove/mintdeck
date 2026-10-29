// tests/weather-icon.test.js —— 共享天气图标（lib/ui/weatherIcon.js）的形状分派与坐标变换。
//
// 面板与收起态现在画同一份图标，这里锁三件事：
//   1. 两个尺寸档都先把坐标系搬到图标中心（面板按绝对中心、岛按内容中的中心）；
//   2. scale 只在非 1 时生效，非法值回落 1（不能让一个坏参数把整帧画丢）；
//   3. kind 为 null 时一个调用都不发；未知 kind 按「云」画，不抛。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const draw = require('../mintdeck@bigmalove/lib/ui/draw.js');

// weatherIcon.js 顶层要读 imports.lib.ui.draw；测试进程里前面可能已经有人装过桩，
// 这里覆盖成本文件自己的（只多不少），再清缓存重新加载。
global.imports = { lib: { ui: { draw: draw } } };
const ICON_PATH = require.resolve('../mintdeck@bigmalove/lib/ui/weatherIcon.js');
delete require.cache[ICON_PATH];
const WeatherIcon = require(ICON_PATH);

function makeCtx() {
  const calls = [];
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'calls') return calls;
      if (prop === '$dispose') return undefined;
      return function (...args) { calls.push({ name: String(prop), args: args }); };
    },
    has() { return true; }
  });
  return ctx;
}

function names(calls) { return calls.map(c => c.name); }
function callOf(calls, name) { return calls.filter(c => c.name === name); }

test('面板图标：搬到中心后按绝对坐标画，太阳有 8 条光线', () => {
  const cr = makeCtx();
  WeatherIcon.draw(cr, 120, 40, 'clear', () => '#FFFFFF', 1);

  const moves = callOf(cr.calls, 'translate');
  assert.equal(moves.length, 1, '只在开头平移一次');
  assert.deepEqual(moves[0].args, [120, 40]);
  assert.equal(callOf(cr.calls, 'scale').length, 0, 'scale=1 不调用 scale');

  assert.ok(callOf(cr.calls, 'arc').length >= 1, '太阳本体');
  assert.equal(callOf(cr.calls, 'stroke').length, 8, '八条光线');
  assert.equal(callOf(cr.calls, 'save').length, 1);
  assert.equal(callOf(cr.calls, 'restore').length, 1);
});

test('收起态图标：按档位缩放，雷雨多一道闪电填充', () => {
  const cr = makeCtx();
  WeatherIcon.drawCompact(cr, 50, 20, 'storm', () => '#FFFFFF', 0.8);

  assert.deepEqual(callOf(cr.calls, 'translate')[0].args, [50, 20]);
  assert.deepEqual(callOf(cr.calls, 'scale')[0].args, [0.8, 0.8]);
  assert.ok(callOf(cr.calls, 'fill').length >= 2, '云 + 闪电各一次填充');

  const rain = makeCtx();
  WeatherIcon.drawCompact(rain, 0, 0, 'rain', () => '#FFFFFF', 0.8);
  assert.ok(callOf(rain.calls, 'stroke').length >= 2, '雨是两道短线');
  assert.equal(callOf(rain.calls, 'arc').length, 3, '雨云只由三个圆弧组成');
});

test('kind 未知按云画；kind 为 null 一个调用都不发', () => {
  const unknown = makeCtx();
  assert.doesNotThrow(() => WeatherIcon.drawCompact(unknown, 0, 0, 'meteor', () => '#FFFFFF', 1));
  assert.ok(callOf(unknown.calls, 'fill').length >= 1, '未知分组退化成云');

  const none = makeCtx();
  WeatherIcon.draw(none, 10, 10, null, () => '#FFFFFF', 1);
  WeatherIcon.drawCompact(none, 10, 10, '', () => '#FFFFFF', 1);
  assert.equal(none.calls.length, 0);
});

test('scale 非有限值回落 1；颜色可以是固定串', () => {
  const cr = makeCtx();
  assert.doesNotThrow(() => WeatherIcon.draw(cr, 0, 0, 'fog', '#9EEBEBF5', NaN));
  assert.equal(callOf(cr.calls, 'scale').length, 0, 'NaN 当成 1');
  assert.ok(callOf(cr.calls, 'stroke').length >= 3, '雾是三条横线');
});
