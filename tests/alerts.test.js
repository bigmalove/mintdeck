'use strict';

// lib/core/alerts.js 的测试：配额预警的边沿触发、复位、冷却与「不编百分比」。
// 纯逻辑，不需要 GI；夹具是面板列的最小形状。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const alerts = require('../mintdeck@bigmalove/lib/core/alerts.js');

const T0 = new Date(2026, 9, 28, 12, 0, 0).getTime();
const MIN = 60000;

function col(name, percent) {
  return { name: name, quotas: [{ title: '5 小时', percent: percent }] };
}

function withNow(opts, now) {
  return Object.assign({}, opts, { now: now });
}

test('peakPercent 取所有配额里最紧的一格，全不可用时返回 null', function () {
  assert.equal(alerts.peakPercent({ quotas: [{ percent: 12 }, { percent: 88 }, { percent: null }] }), 88);
  assert.equal(alerts.peakPercent({ percent: 42, quotas: [] }), 42);
  assert.equal(alerts.peakPercent({ quotas: [{ percent: null }, {}] }), null);
  assert.equal(alerts.peakPercent(null), null);
});

test('evaluate：越线才提醒，同等级继续涨不再响，升到 crit 时再响一次', () => {
  const opts = { warning: 70, critical: 90, cooldownMs: 0, now: 1000 };

  let r = alerts.evaluate([col('Claude', 69)], {}, opts);
  assert.equal(r.alerts.length, 0);

  r = alerts.evaluate([col('Claude', 70)], r.state, opts);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].level, 'warn');
  assert.equal(r.alerts[0].percent, 70);

  // 71 / 85：同一等级，不响
  r = alerts.evaluate([col('Claude', 71)], r.state, opts);
  assert.equal(r.alerts.length, 0);
  r = alerts.evaluate([col('Claude', 85)], r.state, opts);
  assert.equal(r.alerts.length, 0);

  // 90：升级到 crit，再响一次
  r = alerts.evaluate([col('Claude', 90)], r.state, opts);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].level, 'crit');

  // 95：crit 内继续涨，不响
  r = alerts.evaluate([col('Claude', 95)], r.state, opts);
  assert.equal(r.alerts.length, 0);
});

test('evaluate：掉回线下复位，再越线会重新提醒', () => {
  const opts = { warning: 70, critical: 90, cooldownMs: 0, now: 1000 };
  let r = alerts.evaluate([col('Claude', 75)], {}, opts);
  assert.equal(r.alerts.length, 1);

  r = alerts.evaluate([col('Claude', 10)], r.state, opts);
  assert.equal(r.alerts.length, 0);
  assert.equal(r.state.Claude.level, 'ok');

  r = alerts.evaluate([col('Claude', 75)], r.state, opts);
  assert.equal(r.alerts.length, 1);
});

test('evaluate：同一来源在冷却窗口内不重复提醒', () => {
  const opts = { warning: 70, critical: 90, cooldownMs: 30 * MIN };

  let r = alerts.evaluate([col('Claude', 75)], {}, withNow(opts, T0));
  assert.equal(r.alerts.length, 1);

  // 5 分钟后回落再越线：冷却挡住
  r = alerts.evaluate([col('Claude', 10)], r.state, withNow(opts, T0 + MIN));
  r = alerts.evaluate([col('Claude', 75)], r.state, withNow(opts, T0 + 5 * MIN));
  assert.equal(r.alerts.length, 0);

  // 过了冷却窗口再回落再越线：重新提醒
  r = alerts.evaluate([col('Claude', 10)], r.state, withNow(opts, T0 + 31 * MIN));
  r = alerts.evaluate([col('Claude', 75)], r.state, withNow(opts, T0 + 31 * MIN));
  assert.equal(r.alerts.length, 1);
});

test('evaluate：没有配额百分比的列不参与，也不写状态', () => {
  const opts = { warning: 70, critical: 90, cooldownMs: 0 };
  const r = alerts.evaluate([
    { name: 'WorkBuddy', quotas: [{ title: '上下文', percent: null }] },
    { name: 'DeepSeek Harness', quotas: [] }
  ], {}, opts);
  assert.equal(r.alerts.length, 0);
  assert.deepEqual(Object.keys(r.state), []);
});

test('peakPercent / evaluate：context:true 的「上下文占用」不算配额，不进状态机', function () {
  const column = { name: 'WorkBuddy', quotas: [{ title: '上下文', percent: 96, context: true }] };
  assert.equal(alerts.peakPercent(column), null);
  const r = alerts.evaluate([column], {}, { warning: 80, critical: 90, cooldownMs: 0 });
  assert.equal(r.alerts.length, 0);
  assert.deepEqual(Object.keys(r.state), []);
});

test('evaluate：来源从列里消失后状态被丢弃，重新出现会再判一次', () => {
  const opts = { warning: 70, critical: 90, cooldownMs: 0 };
  let r = alerts.evaluate([col('Claude', 95)], {}, opts);
  assert.equal(r.alerts.length, 1);

  r = alerts.evaluate([], r.state, opts);          // 关掉 Claude 数据源
  assert.deepEqual(Object.keys(r.state), []);

  r = alerts.evaluate([col('Claude', 95)], r.state, opts);   // 再打开
  assert.equal(r.alerts.length, 1);
});

test('thresholds：critical 填得比 warning 低时按 warning 处理，不当成永远不响', function () {
  const t = alerts.thresholds({ warning: 80, critical: 50 });
  assert.equal(t.warning, 80);
  assert.equal(t.critical, 80);
});

test('levelOf：边界值属于更高一档', function () {
  const limits = { warning: 70, critical: 90 };
  assert.equal(alerts.levelOf(69.9, limits), 'ok');
  assert.equal(alerts.levelOf(70, limits), 'warn');
  assert.equal(alerts.levelOf(89.9, limits), 'warn');
  assert.equal(alerts.levelOf(90, limits), 'crit');
});

test('evaluate：一次出现两条时 crit 排在前面', () => {
  const opts = { warning: 70, critical: 90, cooldownMs: 0 };
  const r = alerts.evaluate([
    { name: 'A', quotas: [{ percent: 72 }] },
    { name: 'B', quotas: [{ percent: 96 }] }
  ], {}, opts);
  assert.equal(r.alerts.length, 2);
  assert.equal(r.alerts[0].name, 'B');
  assert.equal(r.alerts[1].name, 'A');
});
