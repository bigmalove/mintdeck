// lib/core/pomodoro.js —— 番茄钟的状态机（纯 JS，node 可测）
//
// 只算「现在处于哪个阶段、还剩多久、该不该响」，不碰 GI、不画图、不发通知：
// applet 负责每秒 tick 一次并决定要不要弹通知，panel 负责把 mm:ss 画出来。
//
// 状态机只有三段：work（专注）→ short / long（休息）→ work ……
//   · 每完成 longEvery 个工作段，接下来那次休息是长休息（25/5 连四轮 = 100 分钟，然后 15 分钟）；
//   · autoAdvance 为 true 时阶段到点自动接上下一段（标准番茄钟就是这样跑的），
//     为 false 时到点就停在下一段的起点，等人按「继续」；
//   · 暂停不丢进度：running 时用 endsAt 倒推，暂停时把剩余毫秒存进 remainingMs。
//
// 时间一律由调用方传入（now），测试不依赖真实时钟。
'use strict';

var PHASE_IDLE = 'idle';
var PHASE_WORK = 'work';
var PHASE_SHORT = 'short';
var PHASE_LONG = 'long';

var DEFAULTS = {
  workMin: 25,
  shortMin: 5,
  longMin: 15,
  longEvery: 4,
  autoAdvance: true
};

var MIN_MS = 60000;

function intOr(value, fallback, lo, hi) {
  var n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  n = Math.round(n);
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

// 设置里的四个数字：分钟数与轮数都夹在合理区间，非法值退回默认（设置文件可能被手改坏）
function config(opts) {
  var o = opts || {};
  return {
    workMin: intOr(o.workMin, DEFAULTS.workMin, 1, 180),
    shortMin: intOr(o.shortMin, DEFAULTS.shortMin, 1, 60),
    longMin: intOr(o.longMin, DEFAULTS.longMin, 1, 120),
    longEvery: intOr(o.longEvery, DEFAULTS.longEvery, 1, 12),
    autoAdvance: o.autoAdvance === undefined ? DEFAULTS.autoAdvance : !!o.autoAdvance
  };
}

function durationOf(cfg, phase) {
  if (phase === PHASE_WORK) return cfg.workMin * MIN_MS;
  if (phase === PHASE_LONG) return cfg.longMin * MIN_MS;
  if (phase === PHASE_SHORT) return cfg.shortMin * MIN_MS;
  return 0;
}

function create(opts) {
  var cfg = config(opts);
  return {
    phase: PHASE_IDLE,
    running: false,
    rounds: 0,          // 已完成的专注段数（决定下一次休息是长还是短）
    durationMs: 0,
    remainingMs: 0,
    endsAt: 0,
    cfg: cfg
  };
}

function start(state, now) {
  var t = Number(now) || 0;
  if (state.phase === PHASE_IDLE) {
    setPhase(state, PHASE_WORK, true, t);
  } else if (!state.running) {
    resume(state, t);
  }
  return state;
}

function setPhase(state, phase, running, now) {
  var total = durationOf(state.cfg, phase);
  state.phase = phase;
  state.durationMs = total;
  state.running = running;
  state.remainingMs = total;
  state.endsAt = running ? now + total : 0;
  return state;
}

function pause(state, now) {
  if (!state.running) return state;
  var t = Number(now) || 0;
  state.remainingMs = Math.max(0, state.endsAt - t);
  state.running = false;
  state.endsAt = 0;
  return state;
}

function resume(state, now) {
  if (state.running || state.phase === PHASE_IDLE) return state;
  var t = Number(now) || 0;
  var left = state.remainingMs > 0 ? state.remainingMs : durationOf(state.cfg, state.phase);
  state.remainingMs = left;
  state.endsAt = t + left;
  state.running = true;
  return state;
}

function stop(state) {
  state.phase = PHASE_IDLE;
  state.running = false;
  state.durationMs = 0;
  state.remainingMs = 0;
  state.endsAt = 0;
  state.rounds = 0;
  return state;
}

function remaining(state, now) {
  if (state.phase === PHASE_IDLE) return 0;
  if (!state.running) return Math.max(0, state.remainingMs);
  return Math.max(0, state.endsAt - (Number(now) || 0));
}

function progress(state, now) {
  if (state.phase === PHASE_IDLE || !state.durationMs) return 0;
  var left = remaining(state, now);
  var p = 1 - left / state.durationMs;
  return Math.max(0, Math.min(1, p));
}

// 跳过当前阶段：专注段不计入 rounds（没干完就不算一轮），休息段直接回去工作
function skip(state, now) {
  var t = Number(now) || 0;
  if (state.phase === PHASE_IDLE) return state;
  // 跳过专注段只是提前休息，不记一轮 —— 长休息只认「真干满」的轮数
  var next = state.phase === PHASE_WORK ? PHASE_SHORT : PHASE_WORK;
  return setPhase(state, next, true, t);
}

// 到点了：返回本次要通知的事件（'work-done' / 'break-done'），并按 autoAdvance 接下一段。
// 一次 tick 里最多推进一个阶段 —— 长时间休眠后回来不该一次跳完好几轮。
function tick(state, now) {
  var t = Number(now) || 0;
  if (!state.running || state.phase === PHASE_IDLE) return { state: state, events: [] };
  if (t < state.endsAt) return { state: state, events: [] };

  var events = [];
  if (state.phase === PHASE_WORK) {
    state.rounds += 1;
    events.push('work-done');
    var longBreak = state.rounds % state.cfg.longEvery === 0;
    setPhase(state, longBreak ? PHASE_LONG : PHASE_SHORT, state.cfg.autoAdvance, t);
  } else {
    events.push('break-done');
    setPhase(state, PHASE_WORK, state.cfg.autoAdvance, t);
  }
  return { state: state, events: events };
}

function isBreak(state) {
  return state.phase === PHASE_SHORT || state.phase === PHASE_LONG;
}

// mm:ss。专注段可能被设到 180 分钟，所以分钟位不补零截断，直接写实数。
function format(ms) {
  var total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  var m = Math.floor(total / 60);
  var s = total % 60;
  return (m < 10 ? '0' + m : String(m)) + ':' + ('0' + s).slice(-2);
}

if (typeof module !== 'undefined') {
  module.exports = {
    PHASE_IDLE: PHASE_IDLE,
    PHASE_WORK: PHASE_WORK,
    PHASE_SHORT: PHASE_SHORT,
    PHASE_LONG: PHASE_LONG,
    DEFAULTS: DEFAULTS,
    config: config,
    create: create,
    start: start,
    pause: pause,
    resume: resume,
    stop: stop,
    skip: skip,
    tick: tick,
    remaining: remaining,
    progress: progress,
    isBreak: isBreak,
    format: format
  };
}
