'use strict';

// lib/core/pomodoro.js 的测试：番茄钟状态机的阶段切换、暂停/恢复、自动接手、跳过与重置。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const pomo = require('../mintdeck@bigmalove/lib/core/pomodoro.js');

const T0 = 1700000000000;
const MIN = 60 * 1000;

function make(opts) {
  return pomo.create(Object.assign({ work: 25, workMin: 25, shortMin: 5, longMin: 15, longEvery: 4 }, opts || {}));
}

test('create：默认 25/5/15，每 4 轮一次长休息，初始 idle', () => {
  const s = make();
  assert.equal(s.phase, 'idle');
  assert.equal(s.running, false);
  assert.equal(s.cfg.workMin, 25);
  assert.equal(s.cfg.shortMin, 5);
  assert.equal(s.cfg.longMin, 15);
  assert.equal(s.cfg.longEvery, 4);
  assert.equal(pomo.remaining(s, T0), 0);
});

test('start：从 idle 进入 25 分钟专注，remaining 随 now 走', () => {
  const s = make();
  pomo.start(s, T0);
  assert.equal(s.phase, 'work');
  assert.equal(s.running, true);
  assert.equal(pomo.remaining(s, T0), 25 * MIN);
  assert.equal(pomo.remaining(s, T0 + 10 * MIN), 15 * MIN);
  assert.equal(pomo.format(pomo.remaining(s, T0 + 10 * MIN)), '15:00');
  assert.ok(Math.abs(pomo.progress(s, T0 + 10 * MIN) - 0.4) < 1e-9);
});

test('tick：专注段到点 → 记一轮、进 5 分钟短休息、事件 work-done', () => {
  const s = make();
  pomo.start(s, T0);
  const r = pomo.tick(s, T0 + 25 * MIN);
  assert.deepEqual(r.events, ['work-done']);
  assert.equal(s.rounds, 1);
  assert.equal(s.phase, 'short');
  assert.equal(s.running, true);          // autoAdvance 默认开
  assert.equal(pomo.remaining(s, T0 + 25 * MIN), 5 * MIN);
});

test('tick：第 4 轮结束给长休息，第 5 轮结束又回短休息', () => {
  const s = make();
  pomo.start(s, T0);
  let now = T0;
  // 跑完 3 整轮（工作 + 短休息），每轮 30 分钟
  for (let i = 0; i < 3; i++) {
    now += 25 * MIN; pomo.tick(s, now);        // work-done → short
    now += 5 * MIN; pomo.tick(s, now);         // break-done → work
  }
  assert.equal(s.rounds, 3);
  assert.equal(s.phase, 'work');
  now += 25 * MIN;
  const r = pomo.tick(s, now);                 // 第 4 轮
  assert.deepEqual(r.events, ['work-done']);
  assert.equal(s.rounds, 4);
  assert.equal(s.phase, 'long');
  assert.equal(pomo.remaining(s, now), 15 * MIN);

  now += 15 * MIN;
  const r2 = pomo.tick(s, now);                // 长休息结束
  assert.deepEqual(r2.events, ['break-done']);
  assert.equal(s.phase, 'work');
  now += 25 * MIN;
  pomo.tick(s, now);                           // 第 5 轮
  assert.equal(s.phase, 'short');
});

test('pause / resume：暂停后进度不丢，恢复时按剩余时间续上', () => {
  const s = make();
  pomo.start(s, T0);
  pomo.pause(s, T0 + 7 * MIN);
  assert.equal(s.running, false);
  assert.equal(pomo.remaining(s, T0 + 7 * MIN), 18 * MIN);
  // 暂停期间 now 继续走，剩余时间不变
  assert.equal(pomo.remaining(s, T0 + 100 * MIN), 18 * MIN);
  pomo.resume(s, T0 + 100 * MIN);
  assert.equal(s.running, true);
  assert.equal(pomo.remaining(s, T0 + 100 * MIN), 18 * MIN);
  assert.equal(pomo.remaining(s, T0 + 118 * MIN), 0);
});

test('autoAdvance=false：到点停在下一段起点，不自动跑', () => {
  const s = make({ autoAdvance: false });
  pomo.start(s, T0);
  const r = pomo.tick(s, T0 + 25 * MIN);
  assert.deepEqual(r.events, ['work-done']);
  assert.equal(s.phase, 'short');
  assert.equal(s.running, false);
  assert.equal(pomo.remaining(s, T0 + 60 * MIN), 5 * MIN);   // 停着不动
  pomo.resume(s, T0 + 60 * MIN);
  assert.equal(pomo.remaining(s, T0 + 62 * MIN), 3 * MIN);
});

test('tick 一次只推进一个阶段：睡过头不会一次跳完几轮', () => {
  const s = make();
  pomo.start(s, T0);
  const r = pomo.tick(s, T0 + 10 * 60 * MIN);   // 十小时后回来
  assert.deepEqual(r.events, ['work-done']);
  assert.equal(s.phase, 'short');
  assert.equal(s.running, true);
  assert.equal(s.rounds, 1);
});

test('skip：跳过专注段只进短休息、不记轮；跳过休息段回到专注', () => {
  const s = make();
  pomo.start(s, T0);
  pomo.skip(s, T0 + MIN);
  assert.equal(s.phase, 'short');
  assert.equal(s.rounds, 0);
  assert.equal(pomo.remaining(s, T0 + MIN), 5 * MIN);
  pomo.skip(s, T0 + 2 * MIN);
  assert.equal(s.phase, 'work');
  assert.equal(pomo.remaining(s, T0 + 2 * MIN), 25 * MIN);
});

test('stop：回到 idle 并清空轮数', () => {
  const s = make();
  pomo.start(s, T0);
  pomo.tick(s, T0 + 25 * MIN);
  assert.equal(s.rounds, 1);
  pomo.stop(s);
  assert.equal(s.phase, 'idle');
  assert.equal(s.running, false);
  assert.equal(s.rounds, 0);
  assert.equal(pomo.remaining(s, T0), 0);
  assert.equal(pomo.progress(s, T0), 0);
});

test('config：非法/越界值被夹住，非数字退回默认', () => {
  const cfg = pomo.config({ workMin: 0, shortMin: 999, longMin: 'abc', longEvery: 0, autoAdvance: 'yes' });
  assert.equal(cfg.workMin, 1);
  assert.equal(cfg.shortMin, 60);
  assert.equal(cfg.longMin, 15);
  assert.equal(cfg.longEvery, 1);
  assert.equal(cfg.autoAdvance, true);
});

test('format：mm:ss，0 与超过 59 分钟都正确', () => {
  assert.equal(pomo.format(0), '00:00');
  assert.equal(pomo.format(59 * 1000), '00:59');
  assert.equal(pomo.format(25 * MIN), '25:00');
  assert.equal(pomo.format(90 * MIN), '90:00');
  assert.equal(pomo.format(-5000), '00:00');
});

test('isBreak：只有 short / long 算休息', () => {
  const s = make();
  pomo.start(s, T0);
  assert.equal(pomo.isBreak(s), false);
  pomo.skip(s, T0);
  assert.equal(pomo.isBreak(s), true);
});
