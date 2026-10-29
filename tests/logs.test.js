'use strict';

// lib/core/logs.js 的测试：增量偏移、去重、坏行容错、分组聚合。
// 夹具全部自造；时间戳写死，不依赖运行时钟。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const logs = require('../mintdeck@local/lib/core/logs.js');

// ---- 夹具 ------------------------------------------------------------------

function usage(input, output, cacheRead, cacheWrite) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite
  };
}

// 一条 Claude Code 会话行。extra 只覆盖顶层字段；message 要整块给。
function assistant(extra) {
  const base = {
    type: 'assistant',
    message: { id: 'msg_1', model: 'claude-sonnet-5-0', usage: usage(100, 20, 30, 10) },
    timestamp: '2026-10-28T02:00:00.000Z',
    requestId: 'req_1'
  };
  return JSON.stringify(Object.assign(base, extra || {}));
}

function line(obj) {
  return JSON.stringify(obj);
}

// ---- 坏行 ------------------------------------------------------------------

test('坏行与非用量行被跳过，只统计可解析的 assistant 行（LogReader.cs:165-215）', function () {
  const text = [
    '{"type":"user","message":{"role":"user"}}',                 // 无 usage 关键词 → 直接跳过
    'not json at all',                                            // 同上，不进入 parse
    '{"type":"assistant","message":{"model":"m","usage":',        // 含 usage 且 JSON 截断 → 坏行
    '{"type":"assistant","usage":',                               // 第二条坏行
    line({ type: 'assistant', message: { model: 'claude-x' }, timestamp: '2026-10-28T01:00:00.000Z', requestId: 'r0' }), // 缺 usage
    assistant(),
    ''
  ].join('\n');

  var result = logs.readNew(logs.createReader(), '/s/a.jsonl', text);
  assert.equal(result.entries.length, 1, '只有末尾含完整 usage 的行算数');
  assert.equal(result.entries[0].requestId, 'req_1');
  assert.equal(result.entries[0].input, 100);
  assert.equal(result.entries[0].output, 20);
  assert.equal(result.entries[0].cacheRead, 30);
  assert.equal(result.entries[0].cacheWrite, 10);
  assert.equal(result.entries[0].total, 160);
  assert.equal(result.badLines, 2, '两条 JSON 坏行计数，缺字段的行不算坏行');
});

// ---- 增量续读 --------------------------------------------------------------

test('续读只解析 offset 之后的新增行，重复调用同一文本不再产出条目（LogReader.cs:96-154）', function () {
  var reader = logs.createReader();
  var first = assistant({ requestId: 'req_a' }) + '\n' + assistant({ requestId: 'req_b' }) + '\n';
  var one = logs.readNew(reader, '/s/a.jsonl', first);
  assert.equal(one.entries.length, 2);
  assert.equal(one.nextOffset, first.length);

  var again = logs.readNew(reader, '/s/a.jsonl', first);
  assert.equal(again.entries.length, 0, '没有新字节就不产出');
  assert.equal(again.nextOffset, first.length);

  var grown = first + assistant({ requestId: 'req_c' }) + '\n';
  var three = logs.readNew(reader, '/s/a.jsonl', grown);
  assert.equal(three.entries.length, 1);
  assert.equal(three.entries[0].requestId, 'req_c');
  assert.equal(three.nextOffset, grown.length);
});

test('末尾未换行的半行不消费，写完后一次补上', function () {
  var reader = logs.createReader();
  var partial = assistant({ requestId: 'req_half' }); // 故意不带 \n
  var first = logs.readNew(reader, '/s/a.jsonl', partial);
  assert.equal(first.entries.length, 0);
  assert.equal(first.nextOffset, 0, '半行不推进偏移');

  var done = logs.readNew(reader, '/s/a.jsonl', partial + '\n');
  assert.equal(done.entries.length, 1);
  assert.equal(done.nextOffset, partial.length + 1);
});

test('文件变短（截断/重写）从 0 重读', function () {
  var reader = logs.createReader();
  var long = assistant({ requestId: 'req_long' }) + '\n' + assistant({ requestId: 'req_long2' }) + '\n';
  assert.equal(logs.readNew(reader, '/s/a.jsonl', long).entries.length, 2);

  var short = assistant({ requestId: 'req_new' }) + '\n';
  var result = logs.readNew(reader, '/s/a.jsonl', short);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].requestId, 'req_new');
  assert.equal(result.nextOffset, short.length);
});

test('CRLF 行尾也能解析', function () {
  var reader = logs.createReader();
  var content = assistant({ requestId: 'crlf' }).replace(/\n/g, '') + '\r\n';
  var result = logs.readNew(reader, '/s/a.jsonl', content);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].requestId, 'crlf');
});

// ---- 去重 ------------------------------------------------------------------

test('同一 requestId 的流式重复只算一次，保留用量更完整的那条（LogReader.cs:66-67）', function () {
  var reader = logs.createReader();
  var small = assistant({
    requestId: 'req_dup',
    message: { id: 'msg_dup', model: 'claude-sonnet-5-0', usage: usage(5, 0, 0, 0) }
  });
  var big = assistant({
    requestId: 'req_dup',
    message: { id: 'msg_dup', model: 'claude-sonnet-5-0', usage: usage(50, 7, 0, 0) }
  });
  var text = small + '\n' + big + '\n';
  var result = logs.readNew(reader, '/s/a.jsonl', text);
  assert.equal(result.duplicates, 1);
  assert.equal(logs.allEntries(reader).length, 1, 'reader 里只留一条');

  var groups = logs.aggregate(result.entries);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].total, 57, '取更完整的那条（50+7），不是 5');
});

test('没有 requestId 时退回 message.id 作为去重键', function () {
  var reader = logs.createReader();
  var one = assistant({
    requestId: undefined,
    message: { id: 'msg_only', model: 'm', usage: usage(3, 1, 0, 0) }
  });
  var two = assistant({
    requestId: undefined,
    message: { id: 'msg_only', model: 'm', usage: usage(30, 10, 0, 0) }
  });
  var result = logs.readNew(reader, '/s/a.jsonl', one + '\n' + two + '\n');
  var groups = logs.aggregate(result.entries);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].total, 40);
});

test('既无 requestId 也无 message.id 时用行指纹：重读稳定，不同行不互吞', function () {
  var a = assistant({ requestId: undefined, message: { model: 'm', usage: usage(1, 0, 0, 0) } });
  var b = assistant({ requestId: undefined, message: { model: 'm', usage: usage(2, 0, 0, 0) } });
  var text = a + '\n' + b + '\n';

  var first = logs.readNew(logs.createReader(), '/s/a.jsonl', text);
  var second = logs.readNew(logs.createReader(), '/s/a.jsonl', text);
  assert.equal(first.entries.length, 2, '两行内容不同 → 两个 key');
  assert.deepEqual(
    second.entries.map(function (e) { return e.key; }),
    first.entries.map(function (e) { return e.key; })
  );
  assert.deepEqual(
    logs.aggregate(second.entries).map(function (g) { return [g.sessionKey, g.model, g.total]; }),
    logs.aggregate(first.entries).map(function (g) { return [g.sessionKey, g.model, g.total]; })
  );
});

// ---- 聚合 ------------------------------------------------------------------

test('aggregate 按 {sessionKey, model} 汇总四个 token 列', function () {
  var reader = logs.createReader();
  var textA =
    assistant({ requestId: 'a1', message: { id: 'm1', model: 'claude-sonnet-5-0', usage: usage(10, 1, 2, 3) } }) + '\n' +
    assistant({ requestId: 'a2', message: { id: 'm2', model: 'claude-octopus-9', usage: usage(7, 0, 0, 0) } }) + '\n';
  var a = logs.readNew(reader, '/s/a.jsonl', textA);

  var textB = assistant({
    requestId: 'b1',
    message: { id: 'm3', model: 'claude-sonnet-5-0', usage: usage(5, 5, 0, 0) }
  }) + '\n';
  var b = logs.readNew(reader, '/s/b.jsonl', textB);

  var groups = logs.aggregate(a.entries.concat(b.entries));
  assert.equal(groups.length, 3, 'a.jsonl 两个模型 + b.jsonl 一个模型');

  var aSonnet = groups.filter(function (g) {
    return g.sessionKey === '/s/a.jsonl' && g.model === 'claude-sonnet-5-0';
  })[0];
  assert.deepEqual(
    { input: aSonnet.input, output: aSonnet.output, cacheRead: aSonnet.cacheRead, cacheWrite: aSonnet.cacheWrite, total: aSonnet.total },
    { input: 10, output: 1, cacheRead: 2, cacheWrite: 3, total: 16 }
  );

  var bSonnet = groups.filter(function (g) { return g.sessionKey === '/s/b.jsonl'; })[0];
  assert.equal(bSonnet.total, 10);
});

test('aggregate 对拼起来的多次结果再按 key 去重（拼接不会重复计数）', function () {
  var reader = logs.createReader();
  var early = assistant({ requestId: 'req_x', message: { id: 'mx', model: 'm', usage: usage(1, 0, 0, 0) } });
  var first = logs.readNew(reader, '/s/a.jsonl', early + '\n');
  var late = assistant({ requestId: 'req_x', message: { id: 'mx', model: 'm', usage: usage(9, 1, 0, 0) } });
  var second = logs.readNew(reader, '/s/a.jsonl', early + '\n' + late + '\n');

  var groups = logs.aggregate(first.entries.concat(second.entries));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].total, 10);
});

test('aggregate(null) 与空数组不抛', function () {
  assert.deepEqual(logs.aggregate(null), []);
  assert.deepEqual(logs.aggregate([]), []);
});
