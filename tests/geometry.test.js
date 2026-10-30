// tests/geometry.test.js
'use strict';

// 收起态几何：每个期望值都是按 CollapsedGeometry.cs 逐行手算出来的（出处标在注释里），
// 不是「跑一遍看结果」抄回来的。跑法：cd /mnt/E/vibecode/mintdeck && node --test tests/

const test = require('node:test');
const assert = require('node:assert/strict');

const G = require('../mintdeck@bigmalove/lib/core/geometry.js');

const MONITOR = { x: 0, y: 0, width: 1920, height: 1080 };
const WORK = { x: 0, y: 30, width: 1920, height: 1050 };

// 断言用的小工具：只挑关心的字段，报错信息写人话 + 出处。
function check(actual, expected, where) {
  for (const key of Object.keys(expected)) {
    assert.deepEqual(actual[key], expected[key], `${where} 的 ${key}`);
  }
}

// ---------------------------------------------------------------- 常量

test('CollapsedLimits 与上游逐值一致', () => {
  // CollapsedGeometry.cs:8-39
  assert.equal(G.CollapsedLimits.baseHeight, 32, 'BaseHeight');
  assert.equal(G.CollapsedLimits.notchWidthDefault, 238, 'NotchWidthDefault');
  assert.equal(G.CollapsedLimits.notchWidthMin, 180, 'NotchWidthMin');
  assert.equal(G.CollapsedLimits.notchHeightMin, 24, 'NotchHeightMin');
  assert.equal(G.CollapsedLimits.notchHeightMax, 64, 'NotchHeightMax');
  assert.equal(G.CollapsedLimits.capsuleWidthDefault, 196, 'CapsuleWidthDefault');
  assert.equal(G.CollapsedLimits.capsuleTopDefault, 5, 'CapsuleTopDefault');
  assert.equal(G.CollapsedLimits.lineLengthDefault, 56, 'LineLengthDefault');
  assert.equal(G.CollapsedLimits.lineThicknessStep, 0.5, 'LineThicknessStep');
  assert.equal(G.CollapsedLimits.lineTopMax, 16, 'LineTopMax');
  assert.equal(G.CollapsedLimits.offsetLimit, 4000, 'OffsetLimit');
  // :25 ContentMinScale = NotchHeightMin / BaseHeight
  assert.equal(G.CollapsedLimits.contentMinScale, 0.75, 'ContentMinScale');
  // :30 肩 + 角 = 28，矮刘海的 side 会用到
  assert.equal(G.CollapsedLimits.notchCorner + G.CollapsedLimits.notchShoulder, 28, 'NotchCorner + NotchShoulder');
  // :39 CapsulePanelReach = FloatingHeaderExtra + 16
  assert.equal(G.CollapsedLimits.capsulePanelReach, G.CollapsedLimits.floatingHeaderExtra + 16, 'CapsulePanelReach');
});

// ---------------------------------------------------------------- 刘海

test('刘海默认值：238×32 居中贴顶，inset 30 / 角 12 / 肩 16', () => {
  // :97 height = min(Value(32 默认), 1080) = 32
  // :98 width = min(238, 1920) = 238
  // :104 Place(1920, 238, 0) = (1920-238)/2 = 841，y 固定 0
  // :103 scale = 32/32 = 1；:105 ContentWidth = 238 - 2*30 = 178
  const shape = G.resolve({}, 'notch', MONITOR, WORK);
  check(shape, {
    style: 'notch',
    surface: { x: 841, y: 0, width: 238, height: 32 },
    scale: 1,
    inset: 30,
    contentWidth: 178,
    bottomRadius: 12,
    topRadius: 0,
    shoulder: 16
  }, '刘海默认值');
});

test('刘海高度被显示器高度收窄（不回到 24 的下限）', () => {
  // :97 height = min(32, 20) = 20 —— 只有设置值被 Value() 夹进 24..64，显示器不参与那个夹子
  // :103 scale = 20/32 = 0.625；inset = 30*0.625 = 18.75；:105 238 - 37.5 = 200.5
  const shape = G.resolve({}, 'notch', { x: 0, y: 0, width: 1920, height: 20 }, WORK);
  check(shape, { scale: 0.625, inset: 18.75, contentWidth: 200.5 }, '显示器高 20 的刘海');
  assert.equal(shape.surface.height, 20, 'surface.height = min(默认 32, 显示器 20)');
});

test('刘海设置高度先被 Value() 夹进 24..64', () => {
  // :198 Value(100, 24, 64, 32) = 64；:103 scale = 2；inset 60；contentWidth 238 - 120 = 118
  const tall = G.resolve({ notchHeight: 100 }, 'notch', MONITOR, WORK);
  check(tall, { scale: 2, inset: 60, contentWidth: 118, bottomRadius: 12, shoulder: 16 }, 'notchHeight 100 被夹成 64');
  // Value(10, 24, 64, 32) = 24；scale 0.75；inset 22.5；contentWidth 238 - 45 = 193
  const low = G.resolve({ notchHeight: 10 }, 'notch', MONITOR, WORK);
  check(low, { scale: 0.75, inset: 22.5, contentWidth: 193 }, 'notchHeight 10 被夹成 24');
});

test('非有限设置值回落默认（Value() 的 fallback 分支）', () => {
  // :198 double.IsFinite(value) ? Clamp : fallback —— NaN 与 Infinity 都走 fallback
  const shape = G.resolve({ notchWidth: NaN, notchHeight: Infinity, notchOffsetX: NaN },
    'notch', MONITOR, WORK);
  check(shape, { surface: { x: 841, y: 0, width: 238, height: 32 }, scale: 1, inset: 30 }, 'NaN/Infinity 回落');
});

test('刘海宽度被显示器宽度收窄，居中被夹到 0', () => {
  // :102 width = min(238, 200) = 200；:104 Place(200, 200, 0) = 0；:105 200 - 60 = 140
  const shape = G.resolve({}, 'notch', { x: 0, y: 0, width: 200, height: 1080 }, WORK);
  check(shape, { surface: { x: 0, y: 0, width: 200, height: 32 }, contentWidth: 140 }, '显示器宽 200 的刘海');
});

test('自动宽度：刘海宽度 = 内容 + 两侧 side，含最小宽度夹子', () => {
  // :100 side = max(30*32/32, 16+12) = max(30,28) = 30
  // :101 fit = clamp(200 + 60, 180, 8000) = 260；:102 width = min(260, 1920) = 260
  // :104 x = (1920-260)/2 = 830；:105 contentWidth = 260 - 60 = 200
  const shape = G.resolve({}, 'notch', MONITOR, WORK, 1, 200);
  check(shape, { surface: { x: 830, y: 0, width: 260, height: 32 }, contentWidth: 200 }, '自动宽度 200');

  // wanted 0 → fit = clamp(0+60, 180, 8000) = 180（最小宽度赢）；x = (1920-180)/2 = 870；contentWidth = 120
  const narrow = G.resolve({}, 'notch', MONITOR, WORK, 1, 0);
  check(narrow, { surface: { x: 870, y: 0, width: 180, height: 32 }, contentWidth: 120 }, '自动宽度 0 落到最小宽度');

  // notchHeight 48 → :100 side = max(30*48/32=45, 28) = 45；fit = 200 + 90 = 290
  // inset = 30*1.5 = 45；contentWidth = 290 - 90 = 200；x = (1920-290)/2 = 815
  const tall = G.resolve({ notchHeight: 48 }, 'notch', MONITOR, WORK, 1, 200);
  check(tall, { surface: { x: 815, y: 0, width: 290, height: 48 }, inset: 45, contentWidth: 200 },
    '自动宽度随 scale 加 side');
});

test('刘海偏移被剩余空间夹住（Place 的偏移夹子）', () => {
  // :187 half = (1920-238)/2 = 841；:188 shift = clamp(10000, ±4000) = 4000
  // :189 clamp(4000, -841, 841) = 841 → x = 841 + 841 = 1682（右边缘正好贴 1920）
  const right = G.resolve({ notchOffsetX: 10000 }, 'notch', MONITOR, WORK);
  check(right, { surface: { x: 1682, y: 0, width: 238, height: 32 } }, '偏移 10000 夹到右边缘');
  const left = G.resolve({ notchOffsetX: -10000 }, 'notch', MONITOR, WORK);
  check(left, { surface: { x: 0, y: 0, width: 238, height: 32 } }, '偏移 -10000 夹到左边缘');
});

test('显示器尺寸无效时刘海退化成 0 宽', () => {
  // :205 Finite(NaN) = 0 → screen 0 宽；:102 width = min(238, 0) = 0；:105 max(0, 0-60) = 0
  const shape = G.resolve({}, 'notch', { x: 0, y: 0, width: NaN, height: 1080 }, WORK);
  check(shape, { surface: { x: 0, y: 0, width: 0, height: 32 }, contentWidth: 0 }, '显示器宽 NaN');
});

// ---------------------------------------------------------------- 胶囊

test('胶囊默认值：196×32，工作区顶 + CapsuleTop', () => {
  // :76 height = min(Value(32 默认), 1050) = 32
  // :77 saved = 196；:79 width = min(196, 1920) = 196
  // :80 TopRange(32, 1050, ∞) = (0, 1018)；:81 top = clamp(5, 0, 1018) = 5
  // :83 x = area.x(0) + Place(1920, 196, 0) = 0 + 862 = 862；y = area.y(30) + 5 = 35
  // :82 inset = 16；:84 contentWidth = 196 - 32 = 164，上下圆角 = 32/2 = 16
  const shape = G.resolve({}, 'capsule', MONITOR, WORK);
  check(shape, {
    style: 'capsule',
    surface: { x: 862, y: 35, width: 196, height: 32 },
    scale: 1,
    inset: 16,
    contentWidth: 164,
    bottomRadius: 16,
    topRadius: 16,
    shoulder: 0
  }, '胶囊默认值');
});

test('胶囊 CapsuleTop 越界：先被 4000 夹，再被工作区底边夹', () => {
  // :81 Value(5000, 0, 4000, 5) = 4000；:80 TopRange max = clamp(1050-32, 0, ∞) = 1018
  // top = clamp(4000, 0, 1018) = 1018 → y = 30 + 1018 = 1048（下边缘正好 1080）
  const shape = G.resolve({ capsuleTop: 5000 }, 'capsule', MONITOR, WORK);
  check(shape, { surface: { x: 862, y: 1048, width: 196, height: 32 } }, 'capsuleTop 5000');
});

test('工作区比胶囊还矮时胶囊高度被收窄', () => {
  // :76 height = min(32, 20) = 20；:80 TopRange(20, 20, ∞) = (0, 0)；:81 top = clamp(5, 0, 0) = 0
  // y = 30 + 0 = 30；:82 inset = 16*20/32 = 10；:84 contentWidth = 196 - 20 = 176，圆角 10
  const shape = G.resolve({}, 'capsule', MONITOR, { x: 0, y: 30, width: 1920, height: 20 });
  check(shape, {
    surface: { x: 862, y: 30, width: 196, height: 20 },
    scale: 0.625,
    inset: 10,
    contentWidth: 176,
    bottomRadius: 10
  }, '工作区高 20 的胶囊');
});

test('工作区落在显示器外时退回整个显示器（Sanitize）', () => {
  // :207-210 work 夹进显示器后宽高为 0 → (screen, screen)；:83 用 screen 的 (0,0,1920,1080)
  // x = Place(1920, 196, 0) = 862；y = 0 + clamp(5, 0, 1080-32) = 5
  const shape = G.resolve({}, 'capsule', MONITOR, { x: 5000, y: 5000, width: 100, height: 100 });
  check(shape, { surface: { x: 862, y: 5, width: 196, height: 32 } }, '工作区在显示器外');
});

test('capsuleTopRange：0 到 workH - H，负数结果夹到 0', () => {
  // :132-133 → :181-182 TopRange(Finite(h), Finite(workH), ∞)
  assert.deepEqual(G.capsuleTopRange(32, { x: 0, y: 30, width: 1920, height: 1000 }), { min: 0, max: 968 },
    'CapsuleTopRange(32, 1000) = (0, 968)');
  assert.deepEqual(G.capsuleTopRange(2000, { x: 0, y: 30, width: 1920, height: 1000 }), { min: 0, max: 0 },
    'CapsuleTopRange(2000, 1000) = (0, 0)（clamp(-1000, 0, ∞) = 0）');
});

// ---------------------------------------------------------------- 指示条

test('指示条默认值：56×4，居中，圆角 = 厚/2', () => {
  // :88 length = min(56, 1920) = 56；:89 thickness = min(Snap(4,1), 1050) = 4
  // :90 TopRange(4, 1050, 16) = (0, 16)；:91 top = clamp(4, 0, 16) = 4
  // :92 x = area.x(0) + Place(1920, 56, 0) = 932；y = 30 + 4 = 34
  // :93 scale 1、inset 0、contentWidth = length = 56、圆角 2/2
  const shape = G.resolve({}, 'line', MONITOR, WORK);
  check(shape, {
    style: 'line',
    surface: { x: 932, y: 34, width: 56, height: 4 },
    scale: 1,
    inset: 0,
    contentWidth: 56,
    bottomRadius: 2,
    topRadius: 2,
    shoulder: 0
  }, '指示条默认值');
});

test('指示条长度先被 24..600 夹住，再被工作区宽度夹住', () => {
  // :198 Value(10, 24, 600, 56) = 24；:88 min(24, 1920) = 24；:92 x = (1920-24)/2 = 948
  const short = G.resolve({ lineLength: 10 }, 'line', MONITOR, WORK);
  check(short, { surface: { x: 948, y: 34, width: 24, height: 4 }, contentWidth: 24 }, 'lineLength 10 → 24');
  // min(56, 300) = 56；x = (300-56)/2 = 122
  const narrow = G.resolve({}, 'line', { x: 0, y: 0, width: 300, height: 1080 }, { x: 0, y: 30, width: 300, height: 1050 });
  check(narrow, { surface: { x: 122, y: 34, width: 56, height: 4 } }, '工作区宽 300 的指示条');
});

test('指示条厚度被工作区高度收窄，上边随之归 0', () => {
  // :89 thickness = min(4, 3) = 3；:90 TopRange(3, 3, 16) = (0, 0)；:91 top = clamp(4,0,0) = 0
  // y = area.y(30) + 0 = 30；:93 圆角 = 1.5
  const shape = G.resolve({}, 'line', MONITOR, { x: 0, y: 30, width: 1920, height: 3 });
  check(shape, { surface: { x: 932, y: 30, width: 56, height: 3 }, bottomRadius: 1.5 }, '工作区高 3 的指示条');
});

test('roundLineThickness：半步进 + 远离零取整 + 2..8 夹子', () => {
  // :167-170 Clamp(Round(v/0.5, AwayFromZero) * 0.5, 2, 8)
  assert.equal(G.roundLineThickness(2.25), 2.5, '2.25/0.5 = 4.5，远离零 → 5 → 2.5（取偶会给 2.0）');
  assert.equal(G.roundLineThickness(2.3), 2.5, '2.3/0.5 = 4.6 → 5 → 2.5');
  assert.equal(G.roundLineThickness(2.75), 3, '2.75/0.5 = 5.5 → 6 → 3.0');
  assert.equal(G.roundLineThickness(1), 2, '1/0.5 = 2 → 1.0，被下限夹到 2');
  assert.equal(G.roundLineThickness(20), 8, '20/0.5 = 40 → 20，被上限夹到 8');
  assert.equal(G.roundLineThickness(NaN), 4, '非有限值 → LineThicknessDefault');
});

test('snapToDevicePixels：按设备像素取整，0.5 远离零，至少一个像素', () => {
  // :174-179
  assert.equal(G.snapToDevicePixels(4.2, 2), 4, '4.2*2 = 8.4 → 8 → 8/2 = 4');
  assert.equal(G.snapToDevicePixels(1.25, 2), 1.5, '1.25*2 = 2.5，远离零 → 3 → 3/2 = 1.5（取偶会给 1.0）');
  assert.equal(G.snapToDevicePixels(4.3, 2), 4.5, '4.3*2 = 8.6 → 9 → 9/2 = 4.5');
  assert.equal(G.snapToDevicePixels(0.2, 1), 1, '0.2 → round 0 → max(1, 0) = 1');
  assert.equal(G.snapToDevicePixels(NaN, 1), 1, 'dip 不是有限数 → 1 像素');
  assert.equal(G.snapToDevicePixels(5, NaN), 5, '缩放无效 → 按 1 算');
  assert.equal(G.snapToDevicePixels(4, 1.5), 4, '4*1.5 = 6 → 6/1.5 = 4');
});

test('lineTopRange：0 到 min(workH - thickness, 16)', () => {
  // :163-164 → TopRange(Finite(thickness), Finite(workH), LineTopMax = 16)
  assert.deepEqual(G.lineTopRange(2, { x: 0, y: 30, width: 1920, height: 1050 }), { min: 0, max: 16 }, '正常工作区');
  assert.deepEqual(G.lineTopRange(5000, { x: 0, y: 30, width: 1920, height: 1050 }), { min: 0, max: 0 },
    'clamp(1050-5000, 0, 16) = 0');
});

// ---------------------------------------------------------------- 范围

test('offsetXRange：剩余空间的一半，宽度无效时为 0', () => {
  // :113-115 half = max(0, (span - clamp(width, 0, span))/2)
  assert.deepEqual(G.offsetXRange('notch', 238, MONITOR, WORK), { min: -841, max: 841 }, '(1920-238)/2 = 841');
  assert.deepEqual(G.offsetXRange('notch', NaN, MONITOR, WORK), { min: 0, max: 0 }, '宽度不是有限数 → 0');
  assert.deepEqual(G.offsetXRange('notch', 3000, MONITOR, WORK), { min: 0, max: 0 }, '宽度超过 span → 夹到 span，剩 0');
  // 胶囊用工作区宽度：area.width = 1000 → (1000-196)/2 = 402；刘海仍看显示器 → 841
  const narrowWork = { x: 0, y: 30, width: 1000, height: 1050 };
  assert.deepEqual(G.offsetXRange('capsule', 196, MONITOR, narrowWork), { min: -402, max: 402 }, '胶囊看工作区宽 1000');
  assert.deepEqual(G.offsetXRange('notch', 238, MONITOR, narrowWork), { min: -841, max: 841 }, '刘海看显示器宽 1920');
});

test('widthRange：设置范围被显示器/工作区收窄', () => {
  // :127-128 high = min(max, Span(...))；返回 (min(min, high), high)
  assert.deepEqual(G.widthRange('notch', MONITOR, WORK), { min: 180, max: 1920 }, '刘海 180..min(8000,1920)');
  assert.deepEqual(G.widthRange('notch', { x: 0, y: 0, width: 100, height: 1080 }, WORK), { min: 100, max: 100 },
    '显示器宽 100：min(180,100) = 100');
  assert.deepEqual(G.widthRange('capsule', MONITOR, { x: 0, y: 30, width: 1000, height: 1050 }), { min: 140, max: 1000 },
    '胶囊 140..工作区宽 1000');
  assert.deepEqual(G.widthRange('line', { x: 0, y: 0, width: 300, height: 1080 }, WORK), { min: 24, max: 300 },
    '指示条 24..min(600,300)');
});

// ---------------------------------------------------------------- 展开面板

test('胶囊贴边（搭桥内）时面板挂在工作区顶边，headerExtra 为 0', () => {
  // :149 HasBridge：surface.y - workTop = 35 - 30 = 5 ≤ BridgeMaxGap(20) → true → (top, 0)
  const shape = G.resolve({}, 'capsule', MONITOR, WORK);
  assert.deepEqual(G.panel(shape, WORK, 200), { top: 30, headerExtra: 0 }, '胶囊默认位置');
  // 刘海永远走 :146 的早退
  assert.deepEqual(G.panel(G.resolve({}, 'notch', MONITOR, WORK), WORK, 200), { top: 0, headerExtra: 0 }, '刘海面板贴屏幕边');
});

test('胶囊降到桥外时面板浮起，顶边在胶囊顶边以上 lift(32) = 6', () => {
  // surface.y = 30 + 200 = 230；:149 230-30 = 200 > 20 → 浮起
  // :160 lift = max(0, 22 - 32/2) = 6；:151 floating = clamp(230-6 = 224, top 30, max(30, 1080-200-6 = 874)) = 224
  const shape = G.resolve({ capsuleTop: 200 }, 'capsule', MONITOR, WORK);
  assert.deepEqual(G.panel(shape, WORK, 200), { top: 224, headerExtra: 6 }, '浮起的面板');
  // :156-157 只要顶边
  assert.equal(G.panelTop(shape, WORK, 200), 224, 'panelTop 与 Panel().Top 一致');
});

test('浮起的面板被工作区底边压回，pageHeight 太大时退回「挂着」', () => {
  // 胶囊顶 1048（见上一条），floating 原始 1042；上限 = 1080 - 200 - 6 = 874 → 874
  const low = G.resolve({ capsuleTop: 5000 }, 'capsule', MONITOR, WORK);
  assert.deepEqual(G.panel(low, WORK, 200), { top: 874, headerExtra: 6 }, '被底边压回 874');
  // :148 bottomLimit 600 → 上限 = 600 - 200 - 6 = 394
  assert.deepEqual(G.panel(low, WORK, 200, 600), { top: 394, headerExtra: 6 }, 'bottomLimit 600');
  // pageHeight 2000 → 上限 = max(30, 1080-2000-6 = -926) = 30 → clamp(..., 30, 30) = 30，
  // :152 floating > top 不成立 → 退回挂着
  assert.deepEqual(G.panel(low, WORK, 2000), { top: 30, headerExtra: 0 }, 'pageHeight 2000 退回挂在工作区顶边');
});

test('工作区的 Y/高度不是有限数时面板无处安放', () => {
  // :146 早退
  const shape = G.resolve({}, 'capsule', MONITOR, WORK);
  assert.deepEqual(G.panel(shape, { x: 0, y: NaN, width: 1920, height: 1050 }, 200), { top: 0, headerExtra: 0 },
    'work.y 为 NaN');
  assert.deepEqual(G.panel(shape, { x: 0, y: 30, width: 1920, height: NaN }, 200), { top: 0, headerExtra: 0 },
    'work.height 为 NaN');
});

test('capsulePanelLift：max(0, 22 - H/2)', () => {
  // :160
  assert.equal(G.capsulePanelLift(32), 6, '22 - 16 = 6（默认高度）');
  assert.equal(G.capsulePanelLift(44), 0, '22 - 22 = 0');
  assert.equal(G.capsulePanelLift(20), 12, '22 - 10 = 12');
  assert.equal(G.capsulePanelLift(NaN), 22, '非有限值按 0 算 → 22');
});

// ---------------------------------------------------------------- hover 桥

test('hasBridge / zone 与 CollapsedHover 一致', () => {
  // CollapsedHover.cs:22：surface.Y - BridgeTop <= BridgeMaxGap(20)，或形态不是 capsule
  assert.equal(G.hasBridge('capsule', { x: 862, y: 50, width: 196, height: 32 }, 30), true,
    '缝正好 20 仍算搭桥（<= 的比较）');
  assert.equal(G.hasBridge('capsule', { x: 862, y: 51, width: 196, height: 32 }, 30), false, '缝 21 > 20 不搭桥');
  assert.equal(G.hasBridge('notch', { x: 841, y: 0, width: 238, height: 32 }, 30), true, '刘海永远搭桥');

  // :25-30 胶囊搭桥时：顶端拉到工作区顶边 30，高度 = surface.bottom(35+32=67) - 30 = 37
  assert.deepEqual(G.zone('capsule', { x: 862, y: 35, width: 196, height: 32 }, 30),
    { x: 862, y: 30, width: 196, height: 37 }, '胶囊感知区顶到工作区边');
  // 指示条：BridgeTop 是屏幕边 0（:33-34，非胶囊一律 0），左右各加 8、下面加 2
  assert.deepEqual(G.zone('line', { x: 932, y: 34, width: 56, height: 4 }, 30),
    { x: 924, y: 0, width: 72, height: 40 }, '指示条感知区顶到屏幕边');
});

// ---------------------------------------------------------------- 尺寸档位（小 / 标准 / 大）

test('标准档展开后与上游默认逐值一致（预设不许偷改数值）', () => {
  for (const style of ['notch', 'capsule', 'line']) {
    assert.deepEqual(G.resolve(G.presetSettings('standard'), style, MONITOR, WORK),
      G.resolve({}, style, MONITOR, WORK),
      `标准档 ${style} 必须等于 CollapsedGeometry.cs 的默认值`);
  }
  // CollapsedGeometry.cs:8-39 的七个默认值原样出现在表里
  assert.deepEqual(G.presetSettings('standard'), {
    notchWidth: 238, notchHeight: 32,
    capsuleWidth: 196, capsuleHeight: 32, capsuleTop: 5,
    lineLength: 56, lineThickness: 4
  }, '标准档 = 238×32 / 196×32+5 / 56×4');
});

test('三档单调：高度与内容缩放都随档位递增', () => {
  const sizes = ['compact', 'standard', 'large'];
  const heights = sizes.map(s => G.resolve(G.presetSettings(s), 'notch', MONITOR, WORK).surface.height);
  assert.deepEqual(heights, [26, 32, 40], '刘海高 26 / 32 / 40（24..64 之内）');
  // scale = 高 / BaseHeight(32)
  assert.deepEqual(sizes.map(s => G.contentScale(s, 'notch')), [0.8125, 1, 1.25], '刘海内容缩放');
  assert.deepEqual(sizes.map(s => G.contentScale(s, 'capsule')), [0.8125, 1, 1.25], '胶囊内容缩放');
  // 指示条按厚度 / LineThicknessDefault(4)
  assert.deepEqual(sizes.map(s => G.contentScale(s, 'line')), [0.75, 1, 1.25], '指示条内容缩放');
});

test('小档胶囊 172×26：inset 与圆角一起缩小', () => {
  // height 26 → scale 0.8125；inset = 16*0.8125 = 13；圆角 = 26/2 = 13
  // width = min(172, 1920) = 172；x = (1920-172)/2 = 874；y = 30 + clamp(4, 0, 1050-26) = 34
  // contentWidth = 172 - 26 = 146
  const shape = G.resolve(G.presetSettings('compact'), 'capsule', MONITOR, WORK);
  check(shape, {
    surface: { x: 874, y: 34, width: 172, height: 26 },
    scale: 0.8125, inset: 13, contentWidth: 146, bottomRadius: 13
  }, '小档胶囊');
});

test('大档胶囊 232×40：inset 20、圆角 20', () => {
  // height 40 → scale 1.25；inset = 16*1.25 = 20；圆角 = 20
  // x = (1920-232)/2 = 844；y = 30 + clamp(6, 0, 1050-40) = 36；contentWidth = 232 - 40 = 192
  const shape = G.resolve(G.presetSettings('large'), 'capsule', MONITOR, WORK);
  check(shape, {
    surface: { x: 844, y: 36, width: 232, height: 40 },
    scale: 1.25, inset: 20, contentWidth: 192, bottomRadius: 20
  }, '大档胶囊');
});

test('大档刘海 282×40：inset 37.5，圆角/肩仍按上游常数', () => {
  // scale = 40/32 = 1.25；inset = 30*1.25 = 37.5；contentWidth = 282 - 75 = 207
  // x = (1920-282)/2 = 819；圆角 12、肩 16 不随缩放变（CollapsedGeometry.cs:28-30）
  const shape = G.resolve(G.presetSettings('large'), 'notch', MONITOR, WORK);
  check(shape, {
    surface: { x: 819, y: 0, width: 282, height: 40 },
    scale: 1.25, inset: 37.5, contentWidth: 207, bottomRadius: 12, shoulder: 16
  }, '大档刘海');
});

test('自动宽度随档位变宽（同内容宽度 190）', () => {
  // 侧空隙 = max(30*scale, 肩+角 28)：小档 max(24.375, 28) = 28，大档 37.5
  // 小档 fit = clamp(190+56, 180, 8000) = 246 → x = (1920-246)/2 = 837，contentWidth = 246 - 48.75
  // 标准 fit = 250 → x = 835；大档 fit = 190+75 = 265 → x = (1920-265)/2 = 827.5
  const small = G.resolve(G.presetSettings('compact'), 'notch', MONITOR, WORK, 1, 190);
  check(small, { surface: { x: 837, y: 0, width: 246, height: 26 }, contentWidth: 197.25 }, '小档自动宽度');
  const base = G.resolve(G.presetSettings('standard'), 'notch', MONITOR, WORK, 1, 190);
  check(base, { surface: { x: 835, y: 0, width: 250, height: 32 }, contentWidth: 190 }, '标准档自动宽度');
  const big = G.resolve(G.presetSettings('large'), 'notch', MONITOR, WORK, 1, 190);
  check(big, { surface: { x: 827.5, y: 0, width: 265, height: 40 }, contentWidth: 190 }, '大档自动宽度');
  assert.ok(small.surface.width < base.surface.width && base.surface.width < big.surface.width,
    '宽 246 < 250 < 265：大档必须比小档宽');
});

test('每个档位的值都落在 CollapsedLimits 的存储范围里', () => {
  const L = G.CollapsedLimits;
  for (const size of Object.keys(G.SizePresets)) {
    const p = G.presetSettings(size);
    assert.ok(p.notchHeight >= L.notchHeightMin && p.notchHeight <= L.notchHeightMax, `${size} 刘海高越界`);
    assert.ok(p.capsuleHeight >= L.capsuleHeightMin && p.capsuleHeight <= L.capsuleHeightMax, `${size} 胶囊高越界`);
    assert.ok(p.capsuleTop >= L.capsuleTopMin && p.capsuleTop <= L.capsuleTopMax, `${size} 胶囊距顶越界`);
    assert.ok(p.lineLength >= L.lineLengthMin && p.lineLength <= L.lineLengthMax, `${size} 指示条长越界`);
    assert.ok(p.lineThickness >= L.lineThicknessMin && p.lineThickness <= L.lineThicknessMax, `${size} 指示条厚越界`);
    // 厚度按半步进（CollapsedGeometry.cs:19-20）
    assert.equal(p.lineThickness % L.lineThicknessStep, 0, `${size} 指示条厚不是半步进的整数倍`);
    assert.ok(p.notchWidth >= L.notchWidthMin && p.notchWidth <= L.notchWidthMax, `${size} 刘海宽越界`);
    assert.ok(p.capsuleWidth >= L.capsuleWidthMin && p.capsuleWidth <= L.capsuleWidthMax, `${size} 胶囊宽越界`);
  }
});

test('未知档位回落标准档；presetSettings 返回副本', () => {
  assert.equal(G.sizeOf('huge'), 'standard', '未知值落回 standard');
  assert.equal(G.sizeOf(undefined), 'standard', '没设置过也落回 standard');
  assert.equal(G.sizeOf('LARGE'), 'large', '大小写不敏感');
  const a = G.presetSettings('compact');
  a.notchHeight = 999;
  assert.equal(G.presetSettings('compact').notchHeight, 26, '改返回值不许污染预设表');
});

// ---------------------------------------------------------------- 指针命中（Cinnamon 移植独有）
//
// 期望值手算：body 从表面矩形里扣掉肩部 16、顶 6、底 12（都夹到 h/3）；
// wake 取 body 宽度 40%，夹到 64–130，取整；高度取 body 高的 60%，最少 10，再夹到 body 高。

test('body：刘海去掉肩角、顶部透明带和底部圆角', () => {
  // 实测的运行时几何：surface 336x40 @1752,0
  const b = G.body('notch', { x: 1752, y: 0, width: 336, height: 40 });
  check(b, { x: 1768, y: 6, width: 304, height: 22 }, 'notch 336x40');
  // shoulder = min(16, 336/4=84) = 16；top = min(6, 40/3) = 6；bottom = min(12, 40/3) = 12

  const b2 = G.body('notch', { x: 1801, y: 0, width: 238, height: 32 });
  assert.equal(b2.x, 1817, '238 宽：左边进 16');
  assert.equal(b2.y, 6, '顶边进 6');
  assert.equal(b2.width, 206, '238 - 16*2');
  assert.ok(Math.abs(b2.height - 15.3333) < 0.01, '32 - 6 - 32/3');
});

test('body：胶囊就是表面本身，指示条只认正中 80px', () => {
  const c = G.body('capsule', { x: 100, y: 5, width: 196, height: 32 });
  check(c, { x: 100, y: 5, width: 196, height: 32 }, 'capsule');

  const l = G.body('line', { x: 940, y: 4, width: 56, height: 4 });
  check(l, { x: 940, y: 4, width: 56, height: 4 }, '指示条短于 80：整条都算');

  const l2 = G.body('line', { x: 900, y: 4, width: 200, height: 6 });
  check(l2, { x: 960, y: 4, width: 80, height: 6 }, '指示条长于 80：只认正中 80');
});

test('body：没有几何时返回 null，不抛', () => {
  assert.equal(G.body('notch', null), null);
  assert.equal(G.body('notch', { x: 0, y: 0, width: 0, height: 40 }), null);
  assert.equal(G.body('notch', { x: 0, y: 0, width: 200, height: 0 }), null);
});

test('wake：正中窄带，宽 40% 夹到 64–130，高 60% 至少 10', () => {
  // 运行时实测值：surface 336x40 → body 304x22 → wake 122x13 @1859,6
  const w = G.wake('notch', { x: 1752, y: 0, width: 336, height: 40 });
  check(w, { x: 1859, y: 6, width: 122, height: 13 }, 'notch 336x40');

  const w2 = G.wake('notch', { x: 1801, y: 0, width: 238, height: 32 });
  check(w2, { x: 1879, y: 6, width: 82, height: 10 }, 'notch 238x32：0.4*206=82.4→82，高 9.2 抬到 10');

  const w3 = G.wake('notch', { x: 0, y: 0, width: 1600, height: 40 });
  assert.equal(w3.width, 130, '超宽岛：夹到 130');

  const w4 = G.wake('notch', { x: 0, y: 0, width: 200, height: 40 });
  assert.equal(w4.width, 67, '0.4 * (200-32) = 67.2 → 67，仍在 64 以上');

  const w5 = G.wake('notch', { x: 0, y: 0, width: 120, height: 40 });
  assert.equal(w5.width, 64, '0.4 * (120-32) = 35.2 → 抬到 64');
});

test('wake 永远落在 body 里，body 永远落在表面里', () => {
  const cases = [
    ['notch', { x: 0, y: 0, width: 238, height: 32 }],
    ['notch', { x: 1752, y: 0, width: 336, height: 40 }],
    ['notch', { x: 900, y: 0, width: 800, height: 64 }],
    ['capsule', { x: 100, y: 5, width: 196, height: 32 }],
    ['line', { x: 900, y: 4, width: 56, height: 4 }],
    ['line', { x: 900, y: 4, width: 200, height: 10 }]
  ];
  for (const [style, surface] of cases) {
    const b = G.body(style, surface);
    const w = G.wake(style, surface);
    const where = `${style} ${surface.width}x${surface.height}`;
    assert.ok(b.x >= surface.x && b.x + b.width <= surface.x + surface.width + 1e-9, `${where}: body 横向越界`);
    assert.ok(b.y >= surface.y && b.y + b.height <= surface.y + surface.height + 1e-9, `${where}: body 纵向越界`);
    assert.ok(w.x >= b.x && w.x + w.width <= b.x + b.width + 1e-9, `${where}: wake 横向不在 body 里`);
    assert.ok(w.y >= b.y && w.y + w.height <= b.y + b.height + 1e-9, `${where}: wake 纵向不在 body 里`);
  }
});

test('hits：闭区间；空/缺矩形一律 false', () => {
  const r = { x: 100, y: 10, width: 50, height: 20 };
  assert.equal(G.hits(r, 100, 10), true, '左上角算命中');
  assert.equal(G.hits(r, 150, 30), true, '右下角算命中');
  assert.equal(G.hits(r, 99.9, 10), false, '差 0.1px 就不算');
  assert.equal(G.hits(r, 150.1, 30), false);
  assert.equal(G.hits(null, 0, 0), false, '没几何时永远不命中（宁可不弹）');
  assert.equal(G.hits({ x: 0, y: 0, width: 0, height: 0 }, 0, 0), false);
});
