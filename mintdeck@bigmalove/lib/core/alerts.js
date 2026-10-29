// lib/core/alerts.js —— 配额预警的判定逻辑（纯 JS，node 可测）
//
// 设置里的「配额到预警线时提醒 / 预警线 / 告警线」三项以前是空转的：勾了不会发生任何事。
// 这里只管**该不该提醒**，发通知留给 applet（它才有 GI 与 Notify）。
//
// 三条规矩：
//   1. **越线才响**（边沿触发）：等级只在「升高」时提醒一次，70% → 71% → 72% 不会再响。
//   2. **回落复位**：掉回线下（例如每周额度重置）后等级归 ok，下次再越线会重新提醒。
//   3. **不编百分比**：列里没有有限百分比的配额（Claude 未登录、WorkBuddy 只在服务端）就没有预警，
//      绝不当成 0% 处理 —— 与 providers 里「不可用 ≠ 0」同一条立场。
'use strict';

// 等级顺序：ok < warn < crit
var RANK = { ok: 0, warn: 1, crit: 2 };

function num(value) {
  // null / undefined / '' → null，不是 0：Number(null) 是 0，会把「读不到配额」当成「用了 0%」
  if (value === null || value === undefined || value === '') return null;
  var n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampPct(v, fallback) {
  var n = num(v);
  if (n === null) return fallback;
  return Math.max(0, Math.min(100, n));
}

// 一列里最紧的那一格配额：取所有有限百分比的最大值（5 小时 / 每周 / 上下文里最紧的才是该提醒的）
function peakPercent(column) {
  if (!column || typeof column !== 'object') return null;
  var best = null;
  var direct = num(column.percent);
  if (direct !== null) best = direct;
  var quotas = Array.isArray(column.quotas) ? column.quotas : [];
  for (var i = 0; i < quotas.length; i++) {
    // context:true 的是「上下文占用」这类瞬时读数，不是额度；对 90% 的上下文报警只会变成噪音
    if (quotas[i] && quotas[i].context === true) continue;
    var p = num(quotas[i] && quotas[i].percent);
    if (p !== null && (best === null || p > best)) best = p;
  }
  return best === null ? null : Math.max(0, Math.min(100, best));
}

// 阈值：两个百分比，critical 不高于 warning 时按 warning 处理（设置里可以填反，但不能因此永远不响）
function thresholds(opts) {
  var o = opts || {};
  var warn = clampPct(o.warning, 70);
  var crit = clampPct(o.critical, 90);
  if (crit < warn) crit = warn;
  return { warning: warn, critical: crit };
}

function levelOf(percent, limits) {
  if (percent === null) return 'ok';
  if (percent >= limits.critical) return 'crit';
  if (percent >= limits.warning) return 'warn';
  return 'ok';
}

// evaluate(columns, state, opts) -> { alerts: [{ name, level, percent }], state }
//   columns  面板用的列（data.js 组装的那份，含 name / quotas[].percent）
//   state    上一次的 { [name]: { level, at } }；返回值里的 state 要存回去
//   opts     { warning, critical, cooldownMs, now }
// 冷却：同一来源刚提醒过（默认 30 分钟）就跳过，避免手动来回拉告警线时刷屏。
function evaluate(columns, state, opts) {
  var o = opts || {};
  var limits = thresholds(o);
  var cooldown = num(o.cooldownMs);
  if (cooldown === null || cooldown < 0) cooldown = 1800000;
  var nowMs = num(o.now);
  if (nowMs === null) nowMs = Date.now();

  var prev = state && typeof state === 'object' ? state : {};
  var next = {};
  var alerts = [];
  var list = Array.isArray(columns) ? columns : [];

  for (var i = 0; i < list.length; i++) {
    var col = list[i];
    if (!col || typeof col !== 'object') continue;
    var name = typeof col.name === 'string' ? col.name : '';
    if (!name) continue;
    var percent = peakPercent(col);
    if (percent === null) continue;                 // 没有配额数据 → 不进状态机

    var level = levelOf(percent, limits);
    var last = prev[name] && typeof prev[name] === 'object' ? prev[name] : null;
    var lastLevel = last && RANK[last.level] !== undefined ? last.level : 'ok';
    var lastAt = last ? num(last.at) : null;
    var at = lastAt === null ? 0 : lastAt;

    if (RANK[level] > RANK[lastLevel] && (nowMs - at) >= cooldown) {
      alerts.push({ name: name, level: level, percent: percent });
      at = nowMs;
    }
    next[name] = { level: level, at: at };
  }

  // 严重级别排在前面：一次出现两条时，先看到「快用完了」
  alerts.sort(function (a, b) { return RANK[b.level] - RANK[a.level]; });
  return { alerts: alerts, state: next };
}

if (typeof module !== 'undefined') {
  module.exports = {
    RANK: RANK,
    peakPercent: peakPercent,
    thresholds: thresholds,
    levelOf: levelOf,
    evaluate: evaluate
  };
}
