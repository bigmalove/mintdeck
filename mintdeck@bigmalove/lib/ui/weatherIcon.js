// lib/ui/weatherIcon.js —— 天气图标（cairo 自绘）
//
// 面板（panel.js 日程页右上角）和收起态（island.js 时钟左边）画的是同一套 WMO 分组，
// 之前只有面板里有一份内联实现；收起态要加天气，若再抄一遍，两边迟早画得不一样
// （面板改个雨滴长度、岛上没跟，用户看到的是两个天气）。所以图标只留这一份。
//
// 两个尺寸档：
//   draw()        面板用，逻辑尺寸约 17×24（含雨滴 / 闪电的尾巴）；
//   drawCompact() 收起态用，全部塞进 12×12 的方框，只保留一眼能认出的轮廓。
//
// 颜色不从主题里猜：调用方传 colorOf(key)，key 用 'textSecondary' / 'textTertiary' / 'accent'，
// 面板与岛的主题默认色不同（DEFAULT_COLORS 各一份），各传各的取色函数即可。
'use strict';

const Draw = imports.lib.ui.draw;

// scale 必须 > 0；非有限值按 1 处理（绘制层不该因为一个坏参数整帧报废）
function normalizedScale(scale) {
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function resolveColorOf(colorOf) {
    if (typeof colorOf === 'function') return colorOf;
    const fixed = typeof colorOf === 'string' ? colorOf : '#9EEBEBF5';
    return function () { return fixed; };
}

// 统一入口：把坐标系搬到图标中心并缩放，下面的路径全部以 (0,0) 为原点，
// 这样同一份路径既能在面板里按 1 画，也能在岛上按 0.9 画。
function withTransform(cr, cx, cy, scale, body) {
    const s = normalizedScale(scale);
    cr.save();
    cr.translate(Number.isFinite(cx) ? cx : 0, Number.isFinite(cy) ? cy : 0);
    if (s !== 1) cr.scale(s, s);
    body();
    cr.restore();
}

// ---------------------------------------------------------------- 面板尺寸

// 面板图标本体（与 panel.js 原先的内联实现逐点一致，只是原点挪到了图标中心）
function paintPanelShape(cr, kind, color) {
    // 线条统一风格：1.3 宽、圆头，和面板里其它小图标一致
    Draw.setColor(cr, color('textSecondary'));
    cr.setLineWidth(1.3);
    cr.setLineCap(1);

    if (kind === 'clear') {
        cr.newSubPath(); cr.arc(0, 0, 4.2, 0, Math.PI * 2); cr.fill();
        for (let i = 0; i < 8; i++) {
            const ang = i * Math.PI / 4;
            cr.newSubPath();
            cr.moveTo(Math.cos(ang) * 6.2, Math.sin(ang) * 6.2);
            cr.lineTo(Math.cos(ang) * 8.4, Math.sin(ang) * 8.4);
            cr.stroke();
        }
        return;
    }
    if (kind === 'fog') {
        for (let i = 0; i < 3; i++) {
            cr.newSubPath();
            cr.moveTo(-8, -4 + i * 4);
            cr.lineTo(8 - (i === 1 ? 3 : 0), -4 + i * 4);
            cr.stroke();
        }
        return;
    }

    // 云：三个圆弧连成一片，再兜一条底边
    cr.newSubPath();
    cr.arc(-4.5, 1.5, 4.2, Math.PI, 0);
    cr.arc(1.5, -2, 5.6, Math.PI * 0.85, Math.PI * 0.15);
    cr.arc(7, 1.5, 4.2, Math.PI, 0);
    cr.lineTo(-4.5, 5.7);
    cr.closePath();
    cr.fill();

    if (kind === 'partly') {
        Draw.setColor(cr, color('textTertiary'));
        cr.newSubPath(); cr.arc(7.5, -6, 3.4, 0, Math.PI * 2); cr.fill();
    }
    if (kind === 'rain' || kind === 'drizzle') {
        Draw.setColor(cr, color('textSecondary'));
        const len = kind === 'drizzle' ? 3 : 4.6;
        for (let i = 0; i < 3; i++) {
            const dx = -5 + i * 5;
            cr.newSubPath(); cr.moveTo(dx, 8); cr.lineTo(dx - 1.2, 8 + len); cr.stroke();
        }
    }
    if (kind === 'snow') {
        Draw.setColor(cr, color('textSecondary'));
        for (let i = 0; i < 3; i++) {
            cr.newSubPath(); cr.arc(-5 + i * 5, 9.5, 1.1, 0, Math.PI * 2); cr.fill();
        }
    }
    if (kind === 'storm') {
        Draw.setColor(cr, color('accent'));
        cr.newSubPath();
        cr.moveTo(1, 6.5); cr.lineTo(-2, 12.5);
        cr.lineTo(0.6, 12.5); cr.lineTo(-1.4, 17);
        cr.lineTo(4, 10.6); cr.lineTo(1.4, 10.6);
        cr.closePath();
        cr.fill();
    }
}

// ---------------------------------------------------------------- 收起态尺寸

// 云轮廓的紧凑版：范围 x∈[-4.8, 6.0]、y∈[-4.8, 3.0]。
// 岛的高度只有 24–40，竖直空间比面板小一半，所以三个圆弧要按比例收小；
// 直接把面板那份路径乘个系数是不行的 —— 雨滴与闪电的尾巴会先顶出岛外。
function compactCloud(cr) {
    cr.newSubPath();
    cr.arc(-2.4, 0.7, 2.4, Math.PI, 0);
    cr.arc(0.7, -1.4, 3.2, Math.PI * 0.85, Math.PI * 0.15);
    cr.arc(3.9, 0.7, 2.3, Math.PI, 0);
    cr.lineTo(-2.4, 3.0);
    cr.closePath();
    cr.fill();
}

// 紧凑图标本体：全部画在 ±6 的方框内，24px 高的刘海里也读得出「晴 / 云 / 雨 / 雪 / 雷」
function paintCompactShape(cr, kind, color) {
    cr.setLineWidth(1.2);
    cr.setLineCap(1);

    if (kind === 'clear') {
        Draw.setColor(cr, color('textSecondary'));
        cr.newSubPath(); cr.arc(0, 0, 2.3, 0, Math.PI * 2); cr.fill();
        for (let i = 0; i < 8; i++) {
            const ang = i * Math.PI / 4;
            cr.newSubPath();
            cr.moveTo(Math.cos(ang) * 3.4, Math.sin(ang) * 3.4);
            cr.lineTo(Math.cos(ang) * 4.9, Math.sin(ang) * 4.9);
            cr.stroke();
        }
        return;
    }
    if (kind === 'fog') {
        Draw.setColor(cr, color('textSecondary'));
        for (let i = 0; i < 3; i++) {
            cr.newSubPath();
            cr.moveTo(-4.6, -3 + i * 3);
            cr.lineTo(4.6 - (i === 1 ? 2 : 0), -3 + i * 3);
            cr.stroke();
        }
        return;
    }

    Draw.setColor(cr, color('textSecondary'));
    compactCloud(cr);

    if (kind === 'partly') {
        // 太阳压在云的右上角外侧，和面板一样是「多云间晴」而不是两层云
        Draw.setColor(cr, color('textTertiary'));
        cr.newSubPath(); cr.arc(4.4, -4.0, 1.9, 0, Math.PI * 2); cr.fill();
    }
    if (kind === 'rain' || kind === 'drizzle') {
        Draw.setColor(cr, color('textSecondary'));
        const len = kind === 'drizzle' ? 1.6 : 2.4;
        for (let i = 0; i < 2; i++) {
            const dx = -1.4 + i * 3.2;
            cr.newSubPath(); cr.moveTo(dx, 4.2); cr.lineTo(dx - 0.8, 4.2 + len); cr.stroke();
        }
    }
    if (kind === 'snow') {
        Draw.setColor(cr, color('textSecondary'));
        cr.newSubPath(); cr.arc(-1.4, 5.0, 0.9, 0, Math.PI * 2); cr.fill();
        cr.newSubPath(); cr.arc(1.8, 5.0, 0.9, 0, Math.PI * 2); cr.fill();
    }
    if (kind === 'storm') {
        Draw.setColor(cr, color('accent'));
        cr.newSubPath();
        cr.moveTo(0.8, 3.4); cr.lineTo(-1.6, 6.6);
        cr.lineTo(0.2, 6.6); cr.lineTo(-1.0, 8.6);
        cr.lineTo(2.6, 4.8); cr.lineTo(0.8, 4.8);
        cr.closePath();
        cr.fill();
    }
}

// ---------------------------------------------------------------- 对外

/**
 * 面板用的天气图标（逻辑尺寸约 17×24，含雨滴 / 闪电的尾巴）。
 * @param {object} cr cairo context
 * @param {number} cx 图标中心 x
 * @param {number} cy 图标中心 y
 * @param {string|null} kind clear|partly|cloud|fog|drizzle|rain|snow|storm
 * @param {function|string} colorOf 取色函数（key → CSS 颜色），或固定颜色
 * @param {number} [scale=1]
 */
function draw(cr, cx, cy, kind, colorOf, scale) {
    if (!kind) return;
    const color = resolveColorOf(colorOf);
    withTransform(cr, cx, cy, scale, function () { paintPanelShape(cr, kind, color); });
}

/**
 * 收起态用的紧凑天气图标（±6 方框，细节少一档）。
 * 参数同 draw()。
 */
function drawCompact(cr, cx, cy, kind, colorOf, scale) {
    if (!kind) return;
    const color = resolveColorOf(colorOf);
    withTransform(cr, cx, cy, scale, function () { paintCompactShape(cr, kind, color); });
}

if (typeof module !== 'undefined') {
    module.exports = { draw: draw, drawCompact: drawCompact };
}
