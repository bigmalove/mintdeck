// lib/linux/calendar.js —— 本机日历：读 .ics、展开重复、裁出窗口
//
// 只读 Cinnamon 同源的本地日历目录：
//   ~/.local/share/evolution/calendar/<账户>/<名字>.ics
// Cinnamon 自带的 calendar applet 走 org.cinnamon.CalendarServer（EDS 的 D-Bus 前端），但没装
// evolution-data-server、或用户没打开过日历应用时那条通道不存在；文件路径更小、更可控。
// 读不到就是 events: [] —— 不编事件，也不去猜用户「大概有什么日程」。
//
// 重复事件只展开 FREQ=DAILY / WEEKLY / MONTHLY / YEARLY（含 INTERVAL / COUNT / UNTIL）。
// BYDAY 组合、BYMONTHDAY、RDATE/EXDATE 这类规则不猜：按单次事件处理，宁可少显示也不显示错的重复
// （日历页最大的失败不是「空」，而是「多了一条不存在的会」）。
'use strict';

var DAY_MS = 86400000;
var HOUR_MS = 3600000;
var MAX_OCCURRENCES = 400;

// ---------------------------------------------------------------- 基础工具

function pad2(n) { return (n < 10 ? '0' : '') + n; }

// RFC5545 的折行：CRLF + 一个空格/Tab 表示续行。不先还原的话 SUMMARY 会被截断、RRULE 会被劈成两段。
function unfold(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function unescapeText(value) {
  return String(value || '')
    .replace(/\\[nN]/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// 属性行 → { name, params, value }。冒号可能是 TZID 值的一部分（TZID="Asia/Shanghai"），要跳过引号内的。
function parseLine(line) {
  var colon = -1;
  var inQuote = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line.charAt(i);
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === ':' && !inQuote) { colon = i; break; }
  }
  if (colon < 0) return null;

  var head = line.slice(0, colon);
  var value = line.slice(colon + 1);
  var segs = [];
  var cur = '';
  var q = false;
  for (var j = 0; j < head.length; j++) {
    var c = head.charAt(j);
    if (c === '"') { q = !q; cur += c; continue; }
    if (c === ';' && !q) { segs.push(cur); cur = ''; continue; }
    cur += c;
  }
  segs.push(cur);

  var name = String(segs.shift() || '').trim().toUpperCase();
  if (!name) return null;

  var params = {};
  for (var k = 0; k < segs.length; k++) {
    var seg = segs[k];
    var eq = seg.indexOf('=');
    if (eq < 0) continue;
    var key = seg.slice(0, eq).trim().toUpperCase();
    var val = seg.slice(eq + 1).trim().replace(/^"|"$/g, '');
    if (key) params[key] = val;
  }
  return { name: name, params: params, value: value };
}

// ICS 时间值 → epoch ms。
//   · 纯日期 20261029（全日事件）：本地 0 点；
//   · 带 Z：UTC；
//   · 不带 Z：按本地时间（Evolution 写本地时间时就是这个形态，不折腾 TZID）。
function parseDt(raw) {
  var s = String(raw || '').trim();
  var m = s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  var year = Number(m[1]), month0 = Number(m[2]) - 1, day = Number(m[3]);
  if (month0 < 0 || month0 > 11 || day < 1 || day > 31) return null;
  var hh = m[4] === undefined ? 0 : Number(m[4]);
  var mm = m[5] === undefined ? 0 : Number(m[5]);
  var ss = m[6] === undefined ? 0 : Number(m[6]);
  var ms = m[7] === 'Z'
    ? Date.UTC(year, month0, day, hh, mm, ss)
    : new Date(year, month0, day, hh, mm, ss).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// DURATION: P1D / PT2H30M / P1W
function parseDuration(raw) {
  var s = String(raw || '').trim().toUpperCase();
  var m = s.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  var ms = 0;
  if (m[1]) ms += Number(m[1]) * 7 * DAY_MS;
  if (m[2]) ms += Number(m[2]) * DAY_MS;
  if (m[3]) ms += Number(m[3]) * HOUR_MS;
  if (m[4]) ms += Number(m[4]) * 60000;
  if (m[5]) ms += Number(m[5]) * 1000;
  return ms > 0 ? ms : null;
}

// ---------------------------------------------------------------- 解析

// parseIcs(text) -> [{ uid, summary, location, start, end, allDay, rrule, durationMs }]
//   缺 DTSTART 的块丢弃（放不上日历）；坏行跳过，不抛。
function parseIcs(text) {
  var lines = unfold(text);
  var out = [];
  var props = null;
  var inEvent = false;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) continue;

    if (line === 'BEGIN:VEVENT') { props = {}; inEvent = true; continue; }
    if (line === 'END:VEVENT') {
      if (inEvent && props) {
        var ev = eventFromProps(props);
        if (ev) out.push(ev);
      }
      props = null;
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;

    var parsed = parseLine(line);
    if (!parsed) continue;
    // 同名属性后出现的覆盖前面的（DTSTART;TZID=.. 这类写法也能落到 DTSTART 上）
    props[parsed.name] = parsed.value;
  }
  return out;
}

function eventFromProps(props) {
  var rawStart = props.DTSTART;
  if (!rawStart) return null;
  var start = parseDt(rawStart);
  if (start === null) return null;

  var rawEnd = props.DTEND;
  var end = rawEnd ? parseDt(rawEnd) : null;
  var allDay = String(rawStart).indexOf('T') < 0;

  var duration = props.DURATION ? parseDuration(props.DURATION) : null;
  if (duration && (!rawEnd || end === null)) end = start + duration;

  if (allDay) {
    // 全日事件：DTEND 是「次日」；没有就按一天
    if (end === null || end <= start) end = start + DAY_MS;
  } else if (end === null || end <= start) {
    end = start + HOUR_MS;
  }

  return {
    uid: props.UID || '',
    summary: unescapeText(props.SUMMARY || ''),
    location: unescapeText(props.LOCATION || ''),
    start: start,
    end: end,
    allDay: allDay,
    rrule: props.RRULE || null,
    durationMs: end - start
  };
}

// ---------------------------------------------------------------- 重复展开

function parseRrule(raw) {
  var s = String(raw || '').trim().toUpperCase();
  if (!s) return null;
  var parts = s.replace(/^RRULE:/, '').split(';');
  var out = {};
  for (var i = 0; i < parts.length; i++) {
    var eq = parts[i].indexOf('=');
    if (eq < 0) continue;
    out[parts[i].slice(0, eq)] = parts[i].slice(eq + 1);
  }
  var freq = out.FREQ;
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;

  // 带 BY* 的规则（BYDAY 组合、BYMONTHDAY、BYSETPOS…）这一步不展开：
  // 猜错会凭空多出会议，比少显示几次糟糕得多 —— 当成单次事件，界面上仍然是「有这条日程」。
  var unsupported = ['BYDAY', 'BYMONTHDAY', 'BYSETPOS', 'BYWEEKNO', 'BYHOUR', 'BYMINUTE', 'BYSECOND', 'BYMONTH'];
  for (var u = 0; u < unsupported.length; u++) {
    if (out[unsupported[u]]) return null;
  }
  var interval = Number(out.INTERVAL);
  var count = Number(out.COUNT);
  return {
    freq: freq,
    interval: Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : 1,
    count: Number.isFinite(count) && count > 0 ? Math.floor(count) : null,
    until: out.UNTIL ? parseDt(out.UNTIL) : null
  };
}

// 按 freq 推进第 n 次：日/周走毫秒，月/年走 Date（月末 31 号落到 30 天的月份时会被 Date 自动进位，
// 这里夹回当月最后一天，避免 1/31 的会跑到 3/3）。
function shiftOccurrence(startMs, rule, n) {
  var step = rule.interval * n;
  if (rule.freq === 'DAILY') return startMs + step * DAY_MS;
  if (rule.freq === 'WEEKLY') return startMs + step * 7 * DAY_MS;
  var d = new Date(startMs);
  var day = d.getDate();
  if (rule.freq === 'MONTHLY') {
    d.setDate(1);
    d.setMonth(d.getMonth() + step);
    var lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
  } else {
    d.setFullYear(d.getFullYear() + step);
  }
  return d.getTime();
}

// expandOccurrences(event, fromMs, toMs) -> [{ start, end, allDay, summary, location, uid }]
//   把重复事件在窗口内展开成若干次；不重复的事件在窗口内就是它自己。
//   窗口判断用「有交集」：跨夜的事件在第二天也要算进来。
function expandOccurrences(event, fromMs, toMs) {
  if (!event || !Number.isFinite(event.start)) return [];
  var dur = Number.isFinite(event.durationMs) && event.durationMs > 0 ? event.durationMs : HOUR_MS;
  var rule = parseRrule(event.rrule);
  var out = [];

  function push(start) {
    if (start === null) return;
    var end = start + (event.durationMs > 0 ? event.durationMs : dur);
    if (end < fromMs || start > toMs) return;      // 无交集
    out.push({
      uid: event.uid,
      summary: event.summary,
      location: event.location,
      allDay: event.allDay,
      start: start,
      end: end
    });
  }

  if (!rule) { push(event.start); return out; }

  for (var n = 0; n < MAX_OCCURRENCES; n++) {
    var start = shiftOccurrence(event.start, rule, n);
    if (rule.count !== null && n >= rule.count) break;
    if (rule.until !== null && start > rule.until) break;
    if (start > toMs) break;
    push(start);
  }
  return out;
}

// 展开 + 排序 + 裁窗口
function filterRange(events, fromMs, toMs) {
  var list = Array.isArray(events) ? events : [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var occ = expandOccurrences(list[i], fromMs, toMs);
    for (var j = 0; j < occ.length; j++) out.push(occ[j]);
  }
  out.sort(function (a, b) { return a.start - b.start || (a.summary < b.summary ? -1 : 1); });
  return out;
}

// ---------------------------------------------------------------- 采集

function gio() {
  if (typeof imports === 'undefined' || !imports.gi) return null;
  return imports.gi.Gio || null;
}

function gLib() {
  if (typeof imports === 'undefined' || !imports.gi) return null;
  return imports.gi.GLib || null;
}

function calendarDirs() {
  var G = gLib();
  if (!G) return [];
  var home = G.get_home_dir();
  return [
    G.build_filenamev([home, '.local', 'share', 'evolution', 'calendar']),
    G.build_filenamev([home, '.local', 'share', 'evolution', 'tasks'])
  ];
}

function listIcs(dirPath, out) {
  var Gio = gio();
  if (!Gio || !dirPath) return out;
  var en = null;
  try {
    en = Gio.File.new_for_path(dirPath).enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
  } catch (e) {
    return out;
  }
  // 枚举器持有 dirfd，必须显式 close（不 close 一次刷新就吃掉一堆 fd，见 sysmon.js 的注解）
  try {
    var info;
    while ((info = en.next_file(null)) !== null) {
      var child = en.get_child(info);
      if (info.get_file_type() === Gio.FileType.DIRECTORY) {
        listIcs(child.get_path(), out);
      } else if (/\.ics$/i.test(info.get_name())) {
        out.push(child.get_path());
      }
    }
  } finally {
    try { en.close(null); } catch (e) { /* 已经关掉 */ }
  }
  return out;
}

function readText(path) {
  var G = gLib();
  if (!G) return null;
  try {
    var res = G.file_get_contents(path);       // [ok, bytes]
    if (!res || !res[0] || !res[1]) return null;
    return typeof TextDecoder !== 'undefined'
      ? new TextDecoder('utf-8').decode(res[1])
      : String(res[1]);
  } catch (e) {
    return null;
  }
}

// collectAsync(onDone) -> { abort }
//   onDone({ events, sources, error })，events 是「现在前 1 天 ~ 后 30 天」窗口内展开后的事件。
//   同步读文件（几个小文件，几十毫秒），由调用方放在定时器里跑；这里不自己起线程。
//   读不到任何文件时给 events: []、sources: []，不是错误。
function collectAsync(onDone) {
  var done = typeof onDone === 'function' ? onDone : function () { };
  var delivered = false;

  function finish(payload) {
    if (delivered) return;
    delivered = true;
    try { done(payload); } catch (e) { /* 回调坏了不影响这里 */ }
  }

  try {
    var dirs = calendarDirs();
    var files = [];
    for (var i = 0; i < dirs.length; i++) listIcs(dirs[i], files);

    var raw = [];
    var sources = [];
    for (var j = 0; j < files.length; j++) {
      var text = readText(files[j]);
      if (!text) continue;
      var parsed = parseIcs(text);
      for (var k = 0; k < parsed.length; k++) raw.push(parsed[k]);
      sources.push({ kind: 'ics', path: files[j], count: parsed.length });
    }

    var now = Date.now();
    var from = now - DAY_MS;
    var to = now + 30 * DAY_MS;
    finish({ events: filterRange(raw, from, to), sources: sources, error: null });
  } catch (e) {
    finish({ events: [], sources: [], error: String(e && e.message ? e.message : e) });
  }

  return { abort: function () { delivered = true; } };
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseIcs: parseIcs,
    parseDt: parseDt,
    parseDuration: parseDuration,
    parseRrule: parseRrule,
    expandOccurrences: expandOccurrences,
    filterRange: filterRange,
    collectAsync: collectAsync
  };
}
