'use strict';

// providers/claude.js、providers/dsh.js、pricing.js 的测试。
// 夹具全部自造（真实样本只用来核对字段形状，不复制任何内容）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const claude = require('../mintdeck@bigmalove/lib/core/providers/claude.js');
const dsh = require('../mintdeck@bigmalove/lib/core/providers/dsh.js');
const pricing = require('../mintdeck@bigmalove/lib/core/pricing.js');

const DAY = 86400000;
// 固定「现在」= 本地 2026-10-28 12:00，测试不依赖运行时钟。
const NOW = new Date(2026, 9, 28, 12, 0, 0);

function at(daysAgo, hour) {
  return new Date(2026, 9, 28 - daysAgo, hour === undefined ? 9 : hour, 0, 0);
}

// ---- Claude 夹具 ------------------------------------------------------------

function assistantLine(extra) {
  const base = {
    type: 'assistant',
    message: {
      id: 'msg_a',
      model: 'claude-sonnet-5-5',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 10,
        cache_creation: { ephemeral_1h_input_tokens: 10 }
      }
    },
    timestamp: at(0).toISOString(),
    requestId: 'req_a'
  };
  return JSON.stringify(Object.assign(base, extra || {}));
}

function costState(usd, modelMap, startTime) {
  return JSON.stringify({
    type: 'cost-state',
    sessionId: 'sess-fake-0001',
    startTime: startTime === undefined ? at(10, 8).getTime() : startTime,
    totalCostUSD: usd,
    modelUsage: modelMap
  });
}

function modelUsage(usd) {
  return {
    'claude-sonnet-5-5': {
      inputTokens: 100,
      outputTokens: 20,
      thinkingTokens: 0,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 10,
      costUSD: usd,
      webSearchRequests: 0
    }
  };
}

// 一个完整会话：今日一条 assistant、3 天前一条、两条 cost-state（后一条才是累计真值）。
const SESSION_TODAY = [
  assistantLine({ requestId: 'req_today', message: { id: 'msg_today', model: 'claude-sonnet-5-5', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 } } }),
  assistantLine({ requestId: 'req_3d', timestamp: at(3).toISOString(), message: { id: 'msg_3d', model: 'claude-sonnet-5-5', usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
  costState(0.01, modelUsage(0.01)),
  costState(0.026194, modelUsage(0.026194))
].join('\n') + '\n';

// ---- Claude：解析 ----------------------------------------------------------

test('claude.parseSession 同时解析 assistant 行与 cost-state 行', function () {
  const parsed = claude.parseSession(SESSION_TODAY, { sessionKey: '/p/today.jsonl', mtime: at(0, 10) });

  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(Object.keys(parsed.entries[0]).sort(), [
    'cacheRead', 'cacheWrite', 'input', 'model', 'output', 'requestId', 'total', 'ts'
  ]);
  const first = parsed.entries[0];
  assert.equal(parsed.entries[0].requestId, 'req_today');
  assert.equal(parsed.entries[0].model, 'claude-sonnet-5-5');
  assert.equal(parsed.entries[0].input, 100);
  assert.equal(parsed.entries[0].output, 20);
  assert.equal(parsed.entries[0].cacheRead, 30);
  assert.equal(parsed.entries[0].cacheWrite, 10, 'cache_creation_input_tokens 合并成一列');
  assert.equal(parsed.entries[0].ts, at(0).getTime());

  assert.equal(parsed.costStates.length, 2);
  assert.equal(parsed.costStates[1].totalCostUSD, 0.026194);
  assert.equal(claude.lastCostState({ costStates: [{ totalCostUSD: 0.01 }, { totalCostUSD: 0.026 }] }).totalCostUSD, 0.026);
});

test('出口条目里 cost-state 的两种行都被识别，坏行与其它类型忽略', function () {
  const text = [
    '{"type":"attachment","attachment":{}}',
    '{broken json with "usage" inside',
    JSON.stringify({ type: 'assistant', message: { model: 'm' }, timestamp: at(0).toISOString() }), // 缺 usage
    JSON.stringify({ type: 'assistant', message: { model: 'm', usage: {} }, timestamp: 'not-a-date', requestId: 'x' }),
    costState(0.5, modelUsage(0.5)),
    ''
  ].join('\n');
  const parsed = claude.parseSession(text, { sessionKey: 's' });
  assert.equal(parsed.entries.length, 0);
  assert.equal(parsed.costStates.length, 1);
});

// ---- Claude：汇总 ----------------------------------------------------------

function claudeSessions() {
  const today = claude.parseSession(SESSION_TODAY, { sessionKey: '/p/today.jsonl', mtime: at(0, 10) });
  const threeDays = claude.parseSession(
    assistantLine({ requestId: 'req_s2', timestamp: at(3).toISOString(), message: { id: 'msg_s2', model: 'claude-sonnet-5-5', usage: { input_tokens: 40, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n' +
      costState(0.5, modelUsage(0.5), at(3, 8).getTime()) + '\n',
    { sessionKey: '/p/3d.jsonl', mtime: at(3, 10) }
  );
  const tenDays = claude.parseSession(
    assistantLine({ requestId: 'req_s3', timestamp: at(10).toISOString(), message: { id: 'msg_s3', model: 'claude-octopus-9', usage: { input_tokens: 9, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n' +
      costState(5, { 'claude-octopus-9': { costUSD: 5 } }, at(10, 8).getTime()) + '\n',
    { sessionKey: '/p/10d.jsonl', mtime: at(10, 10) }
  );
  return [today, threeDays, tenDays];
}

test('claude.summarize 按本地自然日切今日/最近 7 天', function () {
  const summary = claude.summarize(claudeSessions(), NOW);
  // 今日：仅 at(0) 那条 100+20+30+10=160
  assert.equal(summary.today.tokens, 160);
  // 本周（含今日共 7 天）：160 + at(3) 的 60 + 3 天前会话的 40 = 260；10 天前的 9 不计
  assert.equal(summary.week.tokens, 260);
  assert.equal(summary.models.length, 1, '10 天前的 claude-octopus-9 不进本周模型表（token 与费用都不在窗口内）');
  assert.equal(summary.models[0].model, 'claude-sonnet-5-5');
  assert.equal(summary.models[0].tokens, 260);
  assert.ok(Math.abs(summary.models[0].usd - 0.526194) < 1e-9);
});

test('claude.summarize 的 usd 取每个会话最后一条 cost-state，不跨状态相加', function () {
  const summary = claude.summarize(claudeSessions(), NOW);
  // today.jsonl 的两条 cost-state 是 0.01 与 0.026194 → 只能取后者
  assert.ok(Math.abs(summary.today.usd - 0.026194) < 1e-9, '累计值相加会得到 0.036194，属于重复计数');
  assert.ok(Math.abs(summary.week.usd - (0.026194 + 0.5)) < 1e-9);
});

test('claude.summarize 按会话 mtime 归日：昨天写的会话不算今天', function () {
  const yesterday = claude.parseSession(
    costState(0.75, modelUsage(0.75)) + '\n',
    { sessionKey: '/p/y.jsonl', mtime: at(1, 23) }
  );
  const summary = claude.summarize([yesterday], NOW);
  assert.equal(summary.today.usd, 0, 'mtime 是昨天的会话不进今日');
  assert.ok(Math.abs(summary.week.usd - 0.75) < 1e-9);
});

test('claude.summarize 没有费用行时 usd 为 null（有费用但为 0 时才是 0）', function () {
  const noCost = claude.parseSession(assistantLine() + '\n', { sessionKey: 's', mtime: at(0, 10) });
  const summary = claude.summarize(noCost, NOW);
  assert.equal(summary.today.usd, null);
  assert.equal(summary.today.tokens, 160);
});

test('claude.summarize 接受单个 parsed 对象、数组与数字 now', function () {
  const parsed = claude.parseSession(SESSION_TODAY, { sessionKey: 's', mtime: at(0, 10) });
  const single = claude.summarize(parsed, NOW.getTime());
  const list = claude.summarize([parsed], NOW);
  assert.deepEqual(single, list);
});

// ---- Claude：配额请求 ------------------------------------------------------

test('claude.quotaRequest 返回 GET + Bearer + anthropic-beta + x-app', function () {
  const request = claude.quotaRequest('tok-placeholder');
  assert.equal(request.method, 'GET');
  assert.equal(request.url, 'https://api.anthropic.com/api/oauth/usage', '上游 UsageService.cs:348 的端点');
  assert.equal(request.headers.Authorization, 'Bearer tok-placeholder');
  assert.equal(request.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(request.headers['x-app'], 'cli');
  // PLAN.md §6.1 记载的旧地址仍可显式指定
  assert.equal(claude.quotaRequest('t', { url: claude.QUOTA_URL_WEB }).url, 'https://claude.ai/api/oauth/usage');
});

// ---- Claude：配额响应 ------------------------------------------------------

test('claude.parseQuotaResponse 读 _percentage/_reset_time（PLAN.md §6.1 的写法）', function () {
  const quotas = claude.parseQuotaResponse({
    five_hour: { _percentage: 45.5, _reset_time: '2026-10-28T16:00:00.000Z' },
    seven_day: { _percentage: 9, _reset_time: '2026-11-02T00:00:00.000Z' },
    seven_day_sonnet: { _percentage: 12 }
  });
  assert.equal(quotas.length, 3);
  assert.equal(quotas[0].label, '5 小时额度');
  assert.equal(quotas[0].usedPercent, 45.5);
  assert.equal(quotas[0].resetAt, Date.parse('2026-10-28T16:00:00.000Z'));
  assert.equal(quotas[1].label, '每周额度');
  assert.equal(quotas[2].label, 'Sonnet 每周');
  assert.equal(quotas[2].resetAt, null, '缺 _reset_time 就是 null，不是编一个时间');
});

test('claude.parseQuotaResponse 也认上游的 utilization/resets_at 写法（LogReader.cs:245-246）', function () {
  const quotas = claude.parseQuotaResponse('{"five_hour":{"utilization":71,"resets_at":"2026-10-28T16:00:00Z"},"seven_day":{"utilization":30}}');
  assert.equal(quotas.length, 2);
  assert.equal(quotas[0].usedPercent, 71);
  assert.equal(quotas[0].resetAt, Date.parse('2026-10-28T16:00:00Z'));
  assert.equal(quotas[1].usedPercent, 30);
  assert.equal(quotas[1].resetAt, null, 'seven_day 没给 resets_at');
});

test('claude.parseQuotaResponse 跳过缺失项，不补 0；extra_usage 单独成项', function () {
  const quotas = claude.parseQuotaResponse({
    five_hour: { _percentage: 0 },
    extra_usage: { used_credits: 2.5, monthly_limit: 10, resets_at: '2026-11-01T00:00:00Z' }
  });
  assert.equal(quotas.length, 2, 'seven_day / seven_day_sonnet 缺失 → 不出现');
  assert.equal(quotas[0].usedPercent, 0, '真的是 0% 时可以出现');
  assert.equal(quotas[1].label, '额外用量');
  assert.equal(quotas[1].usedPercent, 25);
  assert.equal(quotas[1].usedCredits, 2.5);
  assert.equal(quotas[1].monthlyLimit, 10);

  assert.deepEqual(claude.parseQuotaResponse('not json'), []);
  assert.deepEqual(claude.parseQuotaResponse(null), []);
});

// ---- DSH ------------------------------------------------------------------

function dshLine(extra, data) {
  const base = {
    type: 'assistant/message',
    seq: 22,
    time: at(0).getTime(),
    data: Object.assign({
      turn: 1,
      step: 1,
      message: { id: 'm-1', role: 'assistant', source: { provider: 'reapi', model: 'deepseek/deepseek-v4.1-flash-1017-thinking-max' } },
      usage: { inputTokens: 2431, outputTokens: 351, totalTokens: 18014, cacheReadTokens: 15232 }
    }, data || {})
  };
  return JSON.stringify(Object.assign(base, extra || {}));
}

test('dsh.parseSession 只认 assistant/message，其它事件与缺 usage 的行跳过', function () {
  const text = [
    JSON.stringify({ type: 'session', time: at(0).getTime(), data: { cwd: '/x' } }),
    JSON.stringify({ type: 'tool/call', seq: 3, time: at(0).getTime(), data: { tool: 'read' } }),
    JSON.stringify({ type: 'user/message', seq: 4, time: at(0).getTime(), data: { message: {} } }),
    dshLine(),
    dshLine({ seq: 23 }, { usage: undefined }),                     // 缺 usage → 跳过
    dshLine({ seq: 24 }, { message: { id: 'm-3', source: { provider: 'sky', model: 'deepseek-flash' } }, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 5 } }),
    ''
  ].join('\n');

  const parsed = dsh.parseSession(text);
  assert.equal(parsed.entries.length, 2);
  const first = parsed.entries[0];
  assert.deepEqual(Object.keys(first).sort(), ['cacheRead', 'cacheWrite', 'input', 'model', 'output', 'provider', 'seq', 'total', 'ts']);
  assert.equal(first.seq, 22);
  assert.equal(first.ts, at(0).getTime(), 'time 是毫秒，不再换算');
  assert.equal(first.provider, 'reapi');
  assert.equal(first.model, 'deepseek/deepseek-v4.1-flash-1017-thinking-max');
  assert.equal(first.input, 2431);
  assert.equal(first.output, 351);
  assert.equal(first.cacheRead, 15232);
  assert.equal(first.cacheWrite, 0, 'cacheWriteTokens 缺失按 0');
  assert.equal(first.total, 18014);
  assert.equal(parsed.entries[1].cacheWrite, 5);
  assert.equal(parsed.entries[1].provider, 'sky');
});

test('dsh.parseSession 对同一 message.id 只算一次（fork 会话复制父事件）', function () {
  const same = dshLine({ seq: 30 }, { message: { id: 'm-dup', source: { provider: 'sky', model: 'deepseek-flash' } } });
  const parsed = dsh.parseSession(same + '\n' + same + '\n');
  assert.equal(parsed.entries.length, 1);
});

test('dsh.parseSession 兼容 usage 挂在 message 下的变体（任务正文的样例写法）', function () {
  const variant = JSON.stringify({
    type: 'assistant/message',
    seq: 9,
    time: at(0).getTime(),
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'm-variant',
        source: { provider: 'reapi', model: 'deepseek-flash' },
        usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 }
      }
    }
  });
  const parsed = dsh.parseSession(variant + '\n');
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].total, 6);
});

test('dsh.summarize 切今日/本周，usd 恒为 null', function () {
  const flash = 'deepseek-flash';
  const today = dshLine(); // m-1, 今日, totalTokens 18014
  const old = dshLine({ seq: 40, time: at(3).getTime() }, { message: { id: 'm-old', source: { provider: 'sky', model: flash } }, usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50, cacheReadTokens: 0 } });
  const ancient = dshLine({ seq: 41, time: at(10).getTime() }, { message: { id: 'm-ancient', source: { provider: 'sky', model: flash } }, usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, cacheReadTokens: 0 } });
  const parsed = dsh.parseSession([today, old, ancient, ''].join('\n'));

  const summary = dsh.summarize(parsed, NOW);
  assert.equal(summary.today.tokens, 18014);
  assert.equal(summary.week.tokens, 18014 + 50, '3 天前计入本周，10 天前不计');
  assert.equal(summary.today.usd, null);
  assert.equal(summary.week.usd, null);
  assert.equal(summary.models.length, 2, '本周出现两个模型：v4.1-flash 与 deepseek-flash');
  const byModel = Object.create(null);
  summary.models.forEach(function (row) { byModel[row.model] = row; });
  assert.equal(byModel[flash].tokens, 50);
  assert.equal(byModel[flash].usd, null);
  assert.equal(byModel['deepseek/deepseek-v4.1-flash-1017-thinking-max'].tokens, 18014);
});

// ---- 价格 ------------------------------------------------------------------

test('pricing.priceFor 命中精确模型，单位是美元/百万 token', function () {
  const price = pricing.priceFor('claude-sonnet-4-6');
  assert.deepEqual(price, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 });
  assert.deepEqual(pricing.priceFor('anthropic/claude-sonnet-4.6'), price, 'vendor 前缀与点号版本都归一');
  assert.deepEqual(pricing.priceFor('  GPT-5  '), { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 });
});

test('pricing.priceFor 对带日期/思考档后缀的 ID 走族回退（Pricing.cs:353-363）', function () {
  assert.notEqual(pricing.priceFor('claude-sonnet-5-5'), null, '本机真实的 claude-sonnet-5-5');
  assert.deepEqual(pricing.priceFor('claude-sonnet-5-5'), { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 });
  assert.notEqual(pricing.priceFor('deepseek/deepseek-v4.1-flash-1017-thinking-max'), null);
  assert.notEqual(pricing.priceFor('moonshotai/kimi-k3.1-pro-thinking'), null);
  assert.equal(pricing.priceFor('totally-unknown-model'), null, '查不到就是 null，不假装免费');
  assert.equal(pricing.priceFor(''), null);
  assert.equal(pricing.priceFor(null), null);
});

test('pricing 只对 claude 归一版本点号，本机三个真实模型 ID 都能定价', function () {
  // Pricing.cs:261-262 的 Normalize 只处理 claude-*/anthropic/claude-*
  assert.equal(pricing.estimateUsd({ input: 1000000, output: 0, cacheRead: 0 }, 'deepseek/deepseek-v4.1-flash-1017'), 0.27);
  assert.notEqual(pricing.priceFor('deepseek/deepseek-v4.1-flash-1017'), null);
  assert.notEqual(pricing.priceFor('moonshotai/kimi-k3.1-pro-thinking'), null);
  assert.notEqual(pricing.priceFor('deepseek-flash'), null);
});

test('pricing.estimateUsd 按三列估价', function () {
  const tokens = { input: 1000000, output: 1000000, cacheRead: 0, cacheWrite: 0 };
  assert.equal(pricing.estimateUsd(tokens, 'claude-sonnet-4-6'), 3 + 15);
  assert.ok(Math.abs(pricing.estimateUsd({ input: 0, output: 0, cacheRead: 1000000, cacheWrite: 0 }, 'claude-sonnet-4-6') - 0.3) < 1e-12);
  // 下划线写法（原始 usage 对象）也能吃
  assert.ok(Math.abs(pricing.estimateUsd({ input_tokens: 2000000, output_tokens: 0, cache_read_input_tokens: 0 }, 'claude-sonnet-4-6') - 6) < 1e-12);
  assert.equal(pricing.estimateUsd(tokens, 'totally-unknown-model'), null);
  assert.equal(pricing.estimateUsd(null, 'claude-sonnet-4-6'), null);
});

test('pricing.estimateUsd 与 providers 的条目直接对接', function () {
  const parsed = claude.parseSession(SESSION_TODAY, { sessionKey: 's', mtime: at(0, 10) });
  const entry = parsed.entries[0];
  const usd = pricing.estimateUsd(entry, entry.model);
  // 100*3 + 20*15 + 30*0.3 + 10*3 = 300+300+9+30 = 639 → /1e6
  assert.ok(Math.abs(usd - 639e-6) < 1e-12, '实际得到 ' + usd);
});
