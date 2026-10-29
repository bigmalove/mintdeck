'use strict';

// lib/linux/calendar.js 的测试：ICS 解析、重复展开、窗口裁剪。
// 夹具全部自造：真实日历里的事件是私人数据，不往仓库里放。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cal = require('../mintdeck@bigmalove/lib/linux/calendar.js');

const DAY = 86400000;
const HOUR = 3600000;

function ics(...blocks) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...blocks, 'END:VCALENDAR'].join('\r\n');
}

function evt(lines) {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
}

test('parseIcs：单个事件、本地时间、SUMMARY 转义', () => {
  const text = ics(evt([
    'UID:abc-1',
    'DTSTART:20261029T093000',
    'DTEND:20261029T103000',
    'SUMMARY:周会\\, 全员',
    'LOCATION:3F'
  ]));
  const list = cal.parseIcs(text);
  assert.equal(list.length, 1);
  const e = list[0];
  assert.equal(e.uid, 'abc-1');
  assert.equal(e.summary, '周会, 全员');
  assert.equal(e.location, '3F');
  assert.equal(e.allDay, false);
  assert.equal(new Date(e.start).getHours(), 9);
  assert.equal(new Date(e.start).getMinutes(), 30);
  assert.equal(e.durationMs, HOUR);
});

test('parseIcs：全日事件、没有 DTEND 时按一天', () => {
  const list = cal.parseIcs(ics(evt(['UID:a', 'DTSTART;VALUE=DATE:20261030', 'SUMMARY:休假'])));
  assert.equal(list.length, 1);
  assert.equal(list[0].allDay, true);
  assert.equal(list[0].durationMs, DAY);
});

test('parseIcs：带 Z 的 UTC 时间按 UTC 解析', () => {
  const list = cal.parseIcs(ics(evt(['UID:u', 'DTSTART:20261029T000000Z', 'DTEND:20261029T010000Z', 'SUMMARY:UTC'])));
  assert.equal(list[0].start, Date.UTC(2026, 9, 29, 0, 0, 0));
});

test('parseIcs：折行还原（SUMMARY 续行）与坏块跳过', () => {
  const folded = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:fold',
    'DTSTART:20261029T120000',
    'SUMMARY:这是一个很长的标题，',
    ' 需要折行显示',
    'END:VEVENT',
    'BEGIN:VEVENT',
    // 缺 DTSTART：放不上日历，丢弃
    'UID:broken',
    'SUMMARY:没有开始时间',
    'END:VEVENT',
    'BEGIN:VTODO',
    'UID:todo',
    'DTSTART:20261029T120000',
    'END:VTODO',
    'END:VCALENDAR'
  ].join('\r\n');
  const list = cal.parseIcs(folded);
  assert.equal(list.length, 1);
  assert.equal(list[0].summary, '这是一个很长的标题，需要折行显示');
});

test('parseIcs：DURATION 兜底与 DTEND 缺失', () => {
  const list = cal.parseIcs(ics(
    evt(['UID:d', 'DTSTART:20261029T090000', 'DURATION:PT2H30M', 'SUMMARY:长会']),
    evt(['UID:e', 'DTSTART:20261029T150000', 'SUMMARY:默认一小时'])
  ));
  assert.equal(list[0].durationMs, 2 * HOUR + 30 * 60000);
  assert.equal(list[1].durationMs, HOUR);
});

test('parseDt：各种形态与非法值', () => {
  assert.equal(cal.parseDt('20261029'), new Date(2026, 9, 29).getTime());
  assert.equal(cal.parseDt('20261029T093000'), new Date(2026, 9, 29, 9, 30, 0).getTime());
  assert.equal(cal.parseDt('20261029T093000Z'), Date.UTC(2026, 9, 29, 9, 30, 0));
  assert.equal(cal.parseDt(''), null);
  assert.equal(cal.parseDt('20261301'), null);      // 13 月
  assert.equal(cal.parseDt('not-a-date'), null);
});

test('expandOccurrences：无 RRULE 时只出现一次，窗口外为空', () => {
  const base = new Date(2026, 9, 29, 9, 0, 0).getTime();
  const event = { uid: 'x', summary: 'S', start: base, end: base + HOUR, durationMs: HOUR, allDay: false, rrule: null };
  assert.equal(cal.expandOccurrences(event, base - DAY, base + DAY).length, 1);
  assert.equal(cal.expandOccurrences(event, base + 2 * DAY, base + 3 * DAY).length, 0);
});

test('expandOccurrences：DAILY + INTERVAL 只落在窗口内', () => {
  const start = new Date(2026, 9, 1, 9, 0, 0).getTime();
  const event = {
    uid: 'd', summary: '每日', start: start, end: start + HOUR, durationMs: HOUR, allDay: false,
    rrule: 'FREQ=DAILY;INTERVAL=2'
  };
  const from = new Date(2026, 9, 10, 0, 0, 0).getTime();
  const to = new Date(2026, 9, 15, 0, 0, 0).getTime();
  const occ = cal.expandOccurrences(event, from, to);
  // 10/1 起每 2 天：…10/9, 10/11, 10/13, 10/15(不含 since to 是 0 点)
  assert.deepEqual(occ.map(o => new Date(o.start).getDate()), [11, 13]);
});

test('expandOccurrences：COUNT 与 UNTIL 都能停', () => {
  const start = new Date(2026, 9, 1, 9, 0, 0).getTime();
  const mk = (rrule) => ({ uid: 'c', summary: 'x', start: start, durationMs: HOUR, allDay: false, rrule: rrule });
  const byCount = cal.expandOccurrences(mk('FREQ=DAILY;COUNT=3'), start - DAY, start + 30 * DAY);
  assert.equal(byCount.length, 3);

  const byUntil = cal.expandOccurrences(mk('FREQ=DAILY;UNTIL=20261004T000000'), start - DAY, start + 30 * DAY);
  assert.deepEqual(byUntil.map(o => new Date(o.start).getDate()), [1, 2, 3]);
});

test('expandOccurrences：WEEKLY / MONTHLY / YEARLY 推进', () => {
  const start = new Date(2026, 9, 6, 9, 0, 0).getTime();      // 10/6
  const mk = (rrule) => ({ uid: 'w', summary: 'x', start: start, durationMs: HOUR, allDay: false, rrule: rrule });
  const weekly = cal.expandOccurrences(mk('FREQ=WEEKLY'), start - DAY, start + 21 * DAY);
  assert.deepEqual(weekly.slice(0, 3).map(o => new Date(o.start).getDate()), [6, 13, 20]);

  const monthly = cal.expandOccurrences(mk('FREQ=MONTHLY'), start - DAY, start + 70 * DAY);
  assert.deepEqual(monthly.slice(0, 3).map(o => new Date(o.start).getMonth()), [9, 10, 11]);
});

test('expandOccurrences：不认识的 RRULE 当单次，不乱展开', () => {
  const start = new Date(2026, 9, 6, 9, 0, 0).getTime();
  const event = { uid: 'x', summary: 'x', start: start, durationMs: HOUR, allDay: false, rrule: 'FREQ=DAILY;BYDAY=MO,WE' };
  const occ = cal.expandOccurrences(event, start - DAY, start + 30 * DAY);
  assert.equal(occ.length, 1);
});

test('filterRange：跨多个事件排序、裁窗口、跨夜算交集', () => {
  const now = new Date(2026, 9, 29, 12, 0, 0).getTime();
  const overnight = {
    uid: 'n', summary: '通宵', start: new Date(2026, 9, 28, 22, 0, 0).getTime(),
    durationMs: 5 * HOUR, allDay: false, rrule: null
  };
  const later = {
    uid: 'l', summary: '下午', start: new Date(2026, 9, 29, 9, 0, 0).getTime(),
    durationMs: HOUR, allDay: false, rrule: null
  };
  const far = {
    uid: 'f', summary: '下月', start: new Date(2026, 10, 20, 9, 0, 0).getTime(),
    durationMs: HOUR, allDay: false, rrule: null
  };
  const list = cal.filterRange([far, later, overnight], now - 12 * HOUR, now + 12 * HOUR);
  assert.deepEqual(list.map(e => e.uid), ['n', 'l']);
});
