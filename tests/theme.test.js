// tests/theme.test.js
'use strict';

// 主题：宽容 JSON 解析、base 继承、对比度强制、颜色换算。
// 期望值来自上游源码（行号写在注释里）与本机 mintdeck@local/themes/*.json 的实际内容，
// 不是「跑一遍抄结果」。跑法：cd /mnt/E/vibecode/mintdeck && node --test tests/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const T = require('../mintdeck@local/lib/core/theme.js');

const THEMES_DIR = path.join(__dirname, '..', 'mintdeck@local', 'themes');
const BUILT_INS = ['dark', 'light', 'one-dark-pro', 'github-dark', 'github-light', 'dracula', 'night-owl', 'cyberpunk-edgerunners'];

function readTheme(id) {
  return fs.readFileSync(path.join(THEMES_DIR, id + '.json'), 'utf8');
}

let builtCache = null;
function builtIns() {
  if (builtCache === null) {
    builtCache = T.builtinThemes(BUILT_INS.map(function (id) {
      return { id: id, text: readTheme(id) };
    }));
  }
  return builtCache;
}

function colorOf(hex) {
  return T.parseColor(hex);
}

// ---------------------------------------------------------------- 解析

test('parseTheme：// 注释、/* */ 注释、尾逗号都能过，字符串里的 // 不受影响', () => {
  // PanelThemes.cs:89-94（ReadCommentHandling.Skip + AllowTrailingCommas）、:95-105（Parse）
  const text = [
    '{',
    '  // 这是行注释',
    '  "id": "midnight-teal",   /* 这是块注释 */',
    '  "name": "午夜青",',
    '  "homepage": "https://example.com/a//b",',
    '  "base": "dark",',
    '  "colors": {',
    '    "surface": "#04161A",',
    '    "accent": "#2DD4BF", // 尾注',
    '  },',
    '  "unknownKey": 123,',
    '}'
  ].join('\n');
  const file = T.parseTheme(text);
  assert.equal(file.id, 'midnight-teal', 'id 要能读出来（行注释不能把后面的内容吃掉）');
  assert.equal(file.name, '午夜青', 'name');
  assert.equal(file.homepage, 'https://example.com/a//b', '字符串里的 // 不是注释（dracula.json 的 homepage 就是这样）');
  assert.equal(file.base, 'dark', 'base');
  assert.equal(file.colors.accent, '#2DD4BF', '尾逗号后面的颜色项要保留');
  assert.equal(file.formatVersion, 1, '缺 formatVersion 取默认 1（PanelThemeFile.cs:162）');
  assert.equal(file.effects.surfaceGradient, null, '没写 effects 时渐变是 null，由 EffectRange 给默认值（Build.cs:138-142）');
  assert.equal(file.swatches, null, '没写 swatches 时是 null');
});

test('parseTheme：坏 JSON 与 null 颜色都要报错', () => {
  assert.throws(function () {
    T.parseTheme('{ "id": "x", ');
  }, /不是合法 JSON/, '半截 JSON 必须报错，不能静默变成空主题');
  // PanelThemes.cs:99-104：颜色值不能为 null
  assert.throws(function () {
    T.parseTheme('{ "colors": { "surface": null } }');
  }, /颜色值不能为 null/, 'null 颜色要被挡住');
});

// ---------------------------------------------------------------- 内置主题与继承

test('builtinThemes：八套内置主题全部解析成功，顺序与 BuiltInOrder 一致', () => {
  // PanelThemes.cs:111 BuiltInOrder = dark, light, one-dark-pro, github-dark, github-light, dracula, night-owl, demo
  const built = builtIns();
  assert.deepEqual(built.errors, [], '八套内置主题不该有解析错误');
  assert.deepEqual(built.order, BUILT_INS, '展示顺序即 PanelThemes.BuiltInOrder');
  // 表面色取自各自的 json（dark.json:16、light.json:12 …）
  const surfaces = {
    dark: '#000000',
    light: '#FAFAFC',
    'one-dark-pro': '#21252B',
    'github-dark': '#0D1117',
    'github-light': '#FFFFFF',
    dracula: '#21222C',
    'night-owl': '#011627',
    'cyberpunk-edgerunners': '#0A0613'
  };
  for (const id of BUILT_INS) {
    const palette = T.enforceContrast(T.toPalette(built.themes[id]));
    assert.equal(T.formatColor(palette.surface), surfaces[id], id + ' 的表面色与 themes/' + id + '.json 一致');
  }
  // Build.cs:36：每个主题都从 dark 继承了全部颜色项，合并后一个不缺
  assert.equal(Object.keys(T.toPalette(built.themes.dark).colors).length, T.PanelTokens.length,
    'dark 合并后恰好覆盖全部 ' + T.PanelTokens.length + ' 个颜色键');
});

test('github-light 走 github-light → light → dark 三级链，字段逐项合并', () => {
  // Build.cs:86-100 BaseChain（dark 是链的终点）、:115-124 MergeEffects、:104-113 MergeClock
  const built = builtIns();
  const light = built.themes.light;
  const githubLight = built.themes['github-light'];
  assert.equal(githubLight.base, 'light', 'github-light.json 的 base 是 light');
  assert.equal(githubLight.effects.rimWidth, light.effects.rimWidth, 'rimWidth 继承自 light');
  assert.equal(githubLight.clock.palette.amber, '#9A6700', '时钟预设色用自己的');
  assert.equal(T.toPalette(githubLight).isDark, false, '浅色表面（Build.cs:42 的 .18 阈值）');
  assert.equal(T.toPalette(built.themes['night-owl']).isDark, true, 'night-owl 是深色表面');
});

test('resolve：override 缺的键从 base 取，swatches 不继承，身份信息取 override', () => {
  // Build.cs:26-34 逐层赋值（后写的赢）；PanelThemeFile.cs:178-180 swatches 明说不继承
  const base = T.parseTheme(JSON.stringify({
    id: 'base',
    colors: { surface: '#101010', accent: '#111111', hairline: '#222222' },
    apps: { claude: '#E5A385', codex: '#98DBB0' },
    swatches: ['#111111', '#222222']
  }));
  const override = T.parseTheme(JSON.stringify({
    id: 'child',
    name: '子主题',
    base: 'base',
    colors: { accent: '#FF0000' },
    apps: { claude: '#00FF00' }
  }));
  const merged = T.resolve(base, override);
  assert.equal(merged.colors.accent, '#FF0000', 'override 写了就用 override 的');
  assert.equal(merged.colors.hairline, '#222222', 'override 没写就从 base 取');
  assert.equal(merged.apps.codex, '#98DBB0', 'app 颜色同样继承');
  assert.equal(merged.swatches, null, 'swatches 不继承');
  assert.equal(merged.id, 'child', 'id 取 override');
  assert.equal(merged.name, '子主题', 'name 取 override');
});

test('resolve 用真实主题：只改一个色，其余全部来自 dark', () => {
  const dark = builtIns().themes.dark;
  const merged = T.resolve(T.parseTheme(readTheme('dark')),
    T.parseTheme(JSON.stringify({ id: 'my-dark', base: 'dark', colors: { accent: '#FF0000' } })));
  assert.equal(merged.colors.accent, '#FF0000', '覆盖的 accent');
  assert.equal(merged.colors.hairline, '#17FFFFFF', 'dark.json 的 hairline');
  assert.equal(merged.apps.claude, '#E5A385', 'dark.json 的 apps.claude');
  assert.equal(merged.colors.surface, dark.colors.surface, '其他颜色与 dark 完全一致');
});

// ---------------------------------------------------------------- 对比度强制

test('enforceContrast：深灰文字沿色相提亮到刚好 4.5:1，已达标的主文字原样保留', () => {
  // Build.cs:44-71（每个颜色键各自的 needs）+ ThemeColor.cs:164-198（明度扫描 + 二分细化）
  const theme = T.resolve(T.parseTheme(readTheme('dark')),
    T.parseTheme(JSON.stringify({ id: 'dim', base: 'dark', colors: { textSecondary: '#333333' } })));
  const palette = T.enforceContrast(T.toPalette(theme));

  assert.equal(T.formatColor(palette.colors.textPrimary), '#F5F5F7',
    'textPrimary 本来就有 19:1，EnsureContrast 早退，一个字节都不该动');
  const before = T.contrast(colorOf('#333333'), palette.surface);
  assert.ok(before < 4.5, '#333333 在纯黑上只有 ' + before.toFixed(2) + ':1，确实不达标');
  const after = T.contrast(palette.colors.textSecondary, palette.surface);
  assert.ok(after >= 4.5, '提亮后必须达标（TextContrast = 4.5）');
  // 「刚够就好」：textSecondary 要对的底色里最亮的是弹出层（dark.json 的 #1A1A1D），它是真正的约束项；
  // 二分细化后应当贴着 4.5 过关，而不是一次跳到很亮
  const againstPopup = T.contrast(palette.colors.textSecondary, palette.colors.popup);
  assert.ok(againstPopup >= 4.5, '弹出层上也达标（' + againstPopup.toFixed(2) + ':1）');
  assert.ok(againstPopup < 4.6, '只多给一点点（' + againstPopup.toFixed(2) + ':1）');
  const dim = palette.colors.textSecondary;
  assert.equal(dim.r, dim.g, '灰色没有色相可保，三通道仍然相等');
  assert.equal(dim.g, dim.b, '灰色三通道仍然相等');

  const adjusted = palette.adjustments.filter(function (entry) {
    return entry.key === 'textSecondary';
  });
  assert.equal(adjusted.length, 1, '每个被改的颜色记一条（Build.cs:175）');
  assert.equal(adjusted[0].before, '#333333', '记录改动前的值');
  assert.equal(adjusted[0].minimum, 4.5, '记录它没达到的最低值');
  assert.equal(adjusted[0].reached, true, 'reached 表示最终是否全部达标');
  assert.equal(palette.adjustments.filter(function (entry) {
    return entry.key === 'textPrimary';
  }).length, 0, '没被改的颜色不出现在调整列表里');
});

test('enforceContrast：有彩色时只动明度，色相不漏', () => {
  // ThemeColor.cs:167-168 ToHsl → FromHsl(h, s, 新明度)，色相与饱和度保持不变
  const theme = T.resolve(T.parseTheme(readTheme('dark')),
    T.parseTheme(JSON.stringify({ id: 'dark-red', base: 'dark', colors: { clock: '#551100' } })));
  const palette = T.enforceContrast(T.toPalette(theme));
  const before = T.toHsl(colorOf('#551100'));
  const after = T.toHsl(palette.colors.clock);
  assert.ok(Math.abs(after.h - before.h) <= 1, '色相不变（' + before.h.toFixed(1) + '° → ' + after.h.toFixed(1) + '°）');
  assert.ok(after.l > before.l, '明度提高（' + before.l.toFixed(3) + ' → ' + after.l.toFixed(3) + '）');
  assert.ok(T.contrast(palette.colors.clock, palette.surface) >= 4.5, 'clock 要达到正文的 4.5:1');
});

test('enforceContrast：主题自己的取色器预设色也要能读', () => {
  // Build.cs:80-81：swatches 逐个 Over(surface) 再按图形 3:1 校正
  const theme = T.resolve(T.parseTheme(readTheme('dark')),
    T.parseTheme(JSON.stringify({ id: 'swatch', base: 'dark', swatches: ['#111111', '#FF0000'] })));
  const palette = T.enforceContrast(T.toPalette(theme));
  assert.equal(palette.swatches.length, 2, '两个预设色都保留');
  assert.ok(T.contrast(palette.swatches[0], palette.surface) >= 3, '#111111 被提到图形 3:1');
  assert.equal(T.formatColor(palette.swatches[1]), '#FF0000', '#FF0000 本来就在 5.25:1，原样保留');
});

// ---------------------------------------------------------------- 颜色换算

test('parseColor / formatColor / mix / contrast 与上游一致', () => {
  // ThemeColor.cs:102-114 TryParse / ToString
  assert.deepEqual(T.parseColor('#80FF0000'), { r: 255, g: 0, b: 0, a: 128 }, '8 位是 #AARRGGBB');
  assert.deepEqual(T.parseColor('00FF00'), { r: 0, g: 255, b: 0, a: 255 }, '# 可省，6 位当不透明');
  assert.deepEqual(T.parseColor('  #0A84FF '), { r: 10, g: 132, b: 255, a: 255 }, 'trim 后解析');
  assert.equal(T.parseColor('#12345'), null, '长度不对 → null（TryParse 的失败态）');
  assert.equal(T.parseColor('#GG0000'), null, '非十六进制 → null');
  assert.equal(T.formatColor({ r: 255, g: 0, b: 0, a: 255 }), '#FF0000', '不透明用短写法（:113-114）');
  assert.equal(T.formatColor({ r: 255, g: 0, b: 0, a: 128 }), '#80FF0000', '半透明用 #AARRGGBB');

  // ColorMath.cs:73-78 Mix：share 夹到 0..1，逐通道 Math.Round（C# 默认取偶）
  assert.equal(T.mix('#000000', '#FFFFFF', 0.5), '#808080', '127.5 取偶 → 128（不是 127）');
  assert.equal(T.mix('#000000', '#FFFFFF', 9), '#FFFFFF', '份额超过 1 被夹成 1');
  assert.equal(T.mix('#112233', '#445566', 0), '#112233', '份额 0 原样返回');
  assert.equal(Math.round(T.distance('#000000', '#FFFFFF')), 442, 'ColorMath.Distance：√(3×255²) ≈ 441.7');

  // ThemeColor.cs:136-141 Contrast：黑白正好 21:1
  assert.equal(T.contrast(colorOf('#FFFFFF'), colorOf('#000000')), 21, '黑白 21:1');
  assert.equal(T.contrast(colorOf('#808080'), colorOf('#808080')), 1, '同色 1:1');
});

test('roundHalfEven 是 C# Math.Round 的默认行为（取偶）', () => {
  // 与几何模块的 AwayFromZero 相反：ThemeColor/ColorMath 全用默认的 ToEven
  assert.equal(T.roundHalfEven(2.5), 2, '2.5 → 2');
  assert.equal(T.roundHalfEven(3.5), 4, '3.5 → 4');
  assert.equal(T.roundHalfEven(-2.5), -2, '-2.5 → -2（不是 -3）');
  assert.equal(T.roundHalfEven(2.4), 2, '2.4 → 2');
});

// ---------------------------------------------------------------- 调色板

test('toPalette：表面压到不透明、tooltip 按叠在表面上的结果画、缺项兜底', () => {
  // Build.cs:36 缺项兜底、:39-43 表面/tooltip/bubble 的叠加
  const semi = T.toPalette(T.parseTheme(JSON.stringify({ colors: { surface: '#000000', tooltip: '#80EEEEEE' } })));
  assert.equal(T.formatColor(semi.surface), '#000000', '表面永远画成不透明');
  // 128/255 = 0.50196；238 × 0.50196 = 119.47 → 119 = 0x77
  assert.equal(T.formatColor(semi.colors.tooltip), '#777777', 'tooltip 按叠在表面上算出来');
  assert.equal(semi.isDark, true, '黑表面 → 深色主题');

  const bare = T.toPalette(T.parseTheme(JSON.stringify({ colors: { surface: '#FFFFFF' } })));
  assert.equal(T.formatColor(bare.colors.textPrimary), '#FFFFFF', '缺的颜色项补白色（surface 补黑色）');
  assert.equal(T.formatColor(bare.colors.surface), '#FFFFFF', 'surface 写了就用写的');
});

test('toPalette：效果渐变叠到表面上，scanlines 决定 hasOverlay', () => {
  // Build.cs:44-45（SurfaceStops）、PanelPalette.cs:60 HasOverlay
  const palette = T.enforceContrast(T.toPalette(builtIns().themes['cyberpunk-edgerunners']));
  assert.equal(palette.surfaceStops.length, 3, '表面 + 两段渐变 = 3 档底色');
  assert.equal(palette.hasOverlay, true, '有渐变 + 扫描线 → hasOverlay');
  assert.equal(palette.effects.surfaceGradient.length, 2, 'cyberpunk 的两段渐变');
  assert.equal(palette.effects.shadowOpacity, 0.6, '效果值照文件');
  const plain = T.enforceContrast(T.toPalette(builtIns().themes.dark));
  assert.equal(plain.surfaceStops.length, 1, 'dark 没有渐变，只有表面自己');
  assert.equal(plain.hasOverlay, false, 'dark 的 scanlines 是 0、也没有渐变');
});

// ---------------------------------------------------------------- 应用色

test('appColors：主题自己的应用色优先，缺的回落到 AppPresets', () => {
  const dracula = T.appColors(builtIns().themes.dracula);
  assert.equal(dracula.claude, '#FFB86C', 'dracula.json 的 apps.claude');
  assert.equal(dracula.zcode, '#BD93F9', 'dracula.json 的 apps.zcode');
  const bare = T.appColors(T.parseTheme(JSON.stringify({ id: 'bare', colors: { surface: '#000000' } })));
  assert.equal(bare.claude, '#E5A385', 'AppPresets.ThemeColor(Claude)（Settings.cs:143-145）');
  assert.equal(bare.manual, '#CC9EED', '手工源的紫色（Settings.cs:147）');
  assert.equal(bare.warning, '#E5C890', 'AppPresets.WarningColor（Settings.cs:132）');
  assert.equal(bare.critical, '#E78284', 'AppPresets.CriticalColor（Settings.cs:132）');
});

// ---------------------------------------------------------------- 与 lib/deck/store.js 的接口约定

test('resolve 能吃「已合并的主题 + 原始 JSON 对象」（store.js 的调用形态）', () => {
  // store.js 里是这样调的：this._Themes.resolve(base, raw)，base 是已解析的主题、raw 是裸 JSON。
  // 所以 resolve 的入参必须容忍：键没归一、effects/clock 直接是 JSON 形状、颜色已是 {r,g,b,a}。
  const dark = T.resolve(T.parseTheme(readTheme('dark')), null);
  const raw = {
    id: 'my-theme',
    base: 'dark',
    colors: { surface: '#04161A', accent: '#2DD4BF' },
    apps: { claude: '#FF9E3D' },
    effects: { surfaceGradient: ['#0A0613', '#1C0B30'], rimWidth: 1.25, scanlines: 0.04 },
    clock: { style: 'segment', color: 'default' },
    swatches: ['#111111', '#FF0000']
  };
  const merged = T.resolve(dark, raw);
  assert.equal(merged.colors.accent, '#2DD4BF', '原始 JSON 里的颜色');
  assert.equal(merged.colors.hairline, '#17FFFFFF', '没写的仍来自 dark');
  assert.equal(merged.effects.rimWidth, 1.25, '效果值来自原始 JSON');
  assert.equal(merged.effects.shadowBlur, 14, '没写的效果字段来自 dark（Build.cs:119-123 的 ?? 语义）');
  assert.equal(merged.effects.surfaceGradient.length, 2, '渐变被替换而不是拼接');
  assert.equal(merged.clock.style, 'segment', '时钟样式字段合并');
  assert.equal(merged.clock.palette.amber, '#FF9F43', '时钟预设色从 dark 继承（clock.palette 逐键合并）');
  // 已经合并过的对象再喂一次 resolve 也不能炸（幂等）
  const twice = T.resolve(dark, merged);
  assert.equal(twice.colors.accent, '#2DD4BF', '已归一的对象再合并一次结果不变');
});

test('cssColor：给 deck 层的 CSS 用的 rgba()', () => {
  // 上游的 #AARRGGBB 不是 CSS 能认的写法（CSS 的 8 位是 #RRGGBBAA），所以单独给一个
  assert.equal(T.cssColor('#F5F5F7'), 'rgba(245, 245, 247, 1)', '不透明色 alpha = 1');
  assert.equal(T.cssColor('#80FF0000'), 'rgba(255, 0, 0, 0.502)', '128/255 = 0.50196 → 0.502');
  assert.equal(T.cssColor('#00000000'), 'rgba(0, 0, 0, 0)', '全透明');
});

// ---------------------------------------------------------------- 三色衍生（PanelThemes.Derive）

test('derive：底色改成白色时连带换掉配不上的前景', () => {
  // Derive.cs:35-65
  const palette = T.enforceContrast(T.toPalette(builtIns().themes.dark));
  const derived = T.derive(palette, 'surface', '#FFFFFF');
  assert.equal(T.formatColor(derived.surface), '#FFFFFF', '种色本身进结果');
  // 深色主题的 #F5F5F7 在白色上只有 1.06:1，必须换成 LightForeground #1D1D1F（Derive.cs:47-48）
  assert.equal(T.formatColor(derived.textPrimary), '#1D1D1F', '前景被换成浅色主题前景');
  assert.equal(T.formatColor(derived.clock), '#1D1D1F', 'clock 跟随前景（Derive.cs:51）');
  assert.equal(derived.textSecondary.a, 0xb8, '浅底的次要文字不透明度 0xB8（Derive.cs:15）');
  // 浅底主题的弹出层朝白走：amount -0.8 → Mix(background, White, .8) = #FFFFFF
  assert.equal(T.formatColor(derived.popup), '#FFFFFF', '弹出层朝白（Derive.cs:25）');
  assert.equal(T.formatColor(derived.rangeFill), '#2E0A84FF', '浅底的日期范围底色不透明度 0x2E（Derive.cs:62）');
  assert.throws(function () {
    T.derive(palette, 'textTertiary', '#FFFFFF');
  }, /不是三色之一/, '只有 surface/textPrimary/accent 能做种子');
});

test('derive：只改强调色时不碰文字与填充', () => {
  // Derive.cs:49-63：seed == accent 跳过前景与填充那两段
  const palette = T.enforceContrast(T.toPalette(builtIns().themes.dark));
  const derived = T.derive(palette, 'accent', '#2DD4BF');
  assert.deepEqual(Object.keys(derived).sort(), ['accent', 'onAccent', 'rangeFill'],
    '除了强调色只带来它上面的文字和日期范围底色');
  assert.equal(T.formatColor(derived.accent), '#2DD4BF', '种色');
});

test('readable：读不清的颜色被挪到刚好 3:1', () => {
  // PanelPalette.cs:105 Readable → EnsureContrast(SurfaceStops, GraphicContrast)
  const palette = T.enforceContrast(T.toPalette(builtIns().themes.dark));
  const fixed = T.readable(palette, '#111111');
  assert.ok(T.contrast(fixed, palette.surface) >= 3, '被挪到达标');
  assert.ok(T.contrast(fixed, palette.surface) < 3.1, '只挪到刚好（' + T.contrast(fixed, palette.surface).toFixed(2) + ':1）');
});
