'use strict';

// providers/*.daily() 的测试：趋势页的逐日桶。
// 三家的窗口口径必须一致：含今天在内最近 N 个自然日，index 0 最早、最后一个今天。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const claude = require('../mintdeck@bigmalove/lib/core/providers/claude.js');
const dsh = require('../mintdeck@bigmalove/lib/core/providers/dsh.js');
const workbuddy = require('../mintdeck@bigmalove/lib/core/providers/workbuddy.js');

// 固定「现在」= 本地 2026-10-28 12:00
const NOW = new Date(2026, 9, 28, 12, 0, 0);

function at(daysAgo, hour) {
  return new Date(2026, 9, 28 - daysAgo, hour === undefined ? 9 : hour, 0, 0).getTime();
}

function claudeSession(entries, usd, mtimeDaysAgo) {
  const session = { mtime: at(mtimeDaysAgo === undefined ? 0 : mtimeDaysAgo, 10), entries: entries };
  if (usd !== undefined && usd !== null) {
    session.costStates = [{ ts: session.mtime, startTime: at(3), totalCostUSD: usd, modelUsage: {} }];
  }
  return session;
}

function entry(ts, total, model) {
  return { requestId: 'r' + ts, model: model || 'claude-sonnet-5-5', ts: ts, input: total, output: 0, cacheRead: 0, cacheWrite: 0, total: total };
}

test('claude.daily：长度 = 窗口天数，最后一个桶是今天', function () {
  const values = claude.daily([claudeSession([entry(at(0), 100), entry(at(0, 10), 50), entry(at(1), 70)])], NOW, 14);
  assert.equal(values.tokens.length, 14);
  assert.equal(values.tokens[13], 150);   // 今天
  assert.equal(values.tokens[12], 70);    // 昨天
  assert.equal(values.tokens[0], 0);      // 13 天前
});

test('claude.daily：窗口外的条目丢弃，不挤进最近一天', function () {
  const values = claude.daily([claudeSession([entry(at(20), 999), entry(at(13), 42)])], NOW, 14);
  assert.equal(values.tokens.reduce((a, b) => a + b, 0), 42);
  assert.equal(values.tokens[0], 42);     // 第 14 天前 = index 0
});

test('claude.daily：usd 按会话 mtime 归日；没有费用行时为 null', function () {
  const s = claude.daily([
    claudeSession([entry(at(0), 10)], 1.5, 0),
    claudeSession([entry(at(2), 10)], 2.5, 2)
  ], NOW, 14);
  assert.equal(s.usd[13], 1.5);
  assert.equal(s.usd[11], 2.5);
  assert.equal(s.usd.reduce((a, b) => a + b, 0), 4);

  const noCost = claude.daily([claudeSession([entry(at(0), 10)], null, 0)], NOW, 14);
  assert.equal(noCost.usd, null);
});

test('claude.daily：同一会话的多条 cost-state 只取最后一条，不重复相加', function () {
  const session = claudeSession([entry(at(0), 10)], 3, 0);
  session.costStates.push({ ts: session.mtime, startTime: at(3), totalCostUSD: 7, modelUsage: {} });
  const s = claude.daily([session], NOW, 14);
  assert.equal(s.usd[13], 7);
});

test('dsh.daily：按时间戳分天，长度与窗口一致', function () {
  const parsed = [{ entries: [entry(at(0), 30), entry(at(0, 11), 20), entry(at(3), 5)] }];
  const values = dsh.daily(parsed, NOW, 14);
  assert.equal(values.tokens.length, 14);
  assert.equal(values.tokens[13], 50);
  assert.equal(values.tokens[10], 5);
});

test('workbuddy.daily：积分按 updated_at 归日，没有 upd 的行不落桶', function () {
  const raw = {
    rows: [
      { sid: 'a', used: 10, size: 100, upd: at(0, 10), credit: 2.5 },
      { sid: 'b', used: 10, size: 100, upd: at(0, 11), credit: 1 },
      { sid: 'c', used: 0, size: 100, upd: null, credit: 9 },
      { sid: 'd', used: 10, size: 100, upd: at(2, 9), credit: 4 }
    ]
  };
  const values = workbuddy.daily(raw, NOW, 14);
  assert.equal(values.credits.length, 14);
  assert.equal(values.credits[13], 3.5);
  assert.equal(values.credits[11], 4);
  assert.equal(values.credits.reduce((a, b) => a + b, 0), 7.5);
});

test('三家 daily 对同一天的下标一致（趋势页三行能对齐）', function () {
  const day = at(5);
  const c = claude.daily([claudeSession([entry(day, 1)], null, 5)], NOW, 14);
  const d = dsh.daily([{ entries: [entry(day, 1)] }], NOW, 14);
  const w = workbuddy.daily({ rows: [{ upd: day, credit: 1 }] }, NOW, 14);
  assert.equal(c.tokens[8], 1);
  assert.equal(d.tokens[8], 1);
  assert.equal(w.credits[8], 1);
});

test('daily 对空输入/怪异参数不炸', function () {
  assert.equal(claude.daily([], NOW, 14).tokens.length, 14);
  assert.equal(dsh.daily([], NOW, 14).tokens.length, 14);
  assert.equal(workbuddy.daily({}, NOW, 14).credits.length, 14);
  assert.equal(dsh.daily([{}], NOW, 0).tokens.length, 7);       // 天数非法 → 退回 7 天
  assert.equal(claude.daily(null, NOW, -3).tokens.length, 7);
});
