// tests/lyrics.test.js — 歌词解析的纯函数部分（parseLrc）。
// 对齐上游 src/BrimDeck.Core/Lyrics.cs:55-68：只认时间戳行、一行多戳展开成多条、[offset:±ms] 整体平移、
// 结果按时间升序；时间戳的小数位按毫秒左对齐（[00:01.5] 是 1500ms）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const lyrics = require('../mintdeck@bigmalove/lib/linux/lyrics.js');

// 取自真实 lrclib 响应的形状（syncedLyrics），外加一份网易云常见的多时间戳行。
const LRC = [
  '[ti:Look at the Stars]',
  '[ar:Soulline]',
  '[al:Look at the Stars]',
  '[00:12.50]The Big Dipper points towards the North Star',
  '[00:32.580]While Gemini twins dance afar',
  '[00:43.20][01:43.20]chorus repeats',
  '[03:04.300]',
  ''
].join('\n');

test('parseLrc：时间戳换成毫秒，文本取最后一个时间戳之后的部分（Lyrics.cs:57-59）', () => {
  const lines = lyrics.parseLrc('[00:12.50]first\n[01:05.005]second\n');
  assert.deepEqual(lines, [
    { timeMs: 12500, text: 'first' },
    { timeMs: 65005, text: 'second' }
  ]);
});

test('parseLrc：小数位左对齐（[00:01.5] = 1500ms，不是 5ms）', () => {
  assert.deepEqual(lyrics.parseLrc('[00:01.5]a\n').map((l) => l.timeMs), [1500]);
  assert.deepEqual(lyrics.parseLrc('[00:01.05]a\n').map((l) => l.timeMs), [1050]);
  assert.deepEqual(lyrics.parseLrc('[00:01.005]a\n').map((l) => l.timeMs), [1005]);
});

test('parseLrc：一行多个时间戳展开成多条，且按时间升序（副歌复用写法）', () => {
  const lines = lyrics.parseLrc('[00:43.20][01:43.20]chorus repeats\n');
  assert.deepEqual(lines, [
    { timeMs: 43200, text: 'chorus repeats' },
    { timeMs: 103200, text: 'chorus repeats' }
  ]);
});

test('parseLrc：[offset:±ms] 整体平移，负值压到 0（Lyrics.cs:53-54、64）', () => {
  const plus = lyrics.parseLrc('[offset:+500]\n[00:01.00]a\n[00:00.10]b\n');
  assert.deepEqual(plus.map((l) => l.timeMs), [600, 1500], '排序在平移之后做');
  const minus = lyrics.parseLrc('[offset:-5000]\n[00:01.00]a\n');
  assert.deepEqual(plus.length, 2);
  assert.deepEqual(minus.map((l) => l.timeMs), [0], '负时间不许出现');
});

test('parseLrc：元数据标签不产生歌词行，空文本行保留（当作间奏空档）', () => {
  const lines = lyrics.parseLrc(LRC);
  assert.equal(lines.length, 5, '4 个时间戳 + 1 个空行，[ti:]/[ar:]/[al:] 不算');
  assert.equal(lines[0].timeMs, 12500);
  assert.equal(lines[1].timeMs, 32580);
  assert.deepEqual(lines.slice(2, 4), [
    { timeMs: 43200, text: 'chorus repeats' },
    { timeMs: 103200, text: 'chorus repeats' }
  ]);
  assert.deepEqual(lines[4], { timeMs: 184300, text: '' });
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i].timeMs >= lines[i - 1].timeMs, '必须升序');
});

test('parseLrc：同一 (时间,文本) 去重；同一时间不同文本都保留', () => {
  const dup = lyrics.parseLrc('[00:10.00]a\n[00:10.00]a\n[00:10.00]b\n');
  assert.deepEqual(dup, [
    { timeMs: 10000, text: 'a' },
    { timeMs: 10000, text: 'b' }
  ]);
});

test('parseLrc：空输入、无时间戳、纯文本都给空数组（不编造行）', () => {
  assert.deepEqual(lyrics.parseLrc(''), []);
  assert.deepEqual(lyrics.parseLrc(null), []);
  assert.deepEqual(lyrics.parseLrc('just plain words\nno timestamps here\n'), []);
  assert.deepEqual(lyrics.parseLrc('[ti:only metadata]\n[ar:nobody]\n'), []);
});

test('plainLines：纯文本歌词保留顺序、时间一律 0（上游 Lyrics.cs:68-71）', () => {
  assert.deepEqual(lyrics.plainLines('x\n\n  y  \n'), [
    { timeMs: 0, text: 'x' },
    { timeMs: 0, text: 'y' }
  ]);
  assert.deepEqual(lyrics.plainLines(''), []);
});

test('fetchRemote：node 里没有 GI，回调拿到错误而不是抛异常', () => {
  let got = null;
  const handle = lyrics.fetchRemote({ title: 'x' }, (err, lines, source) => {
    got = { err: err && err.message, lines, source };
  });
  // 返回的是取消句柄（不是 null）：整条源链会同步失败到底，最后回调一次 err。
  assert.equal(typeof handle.abort, 'function');
  assert.match(got.err, /Soup/);
  assert.deepEqual(got.lines, []);
  assert.equal(got.source, null);
});
