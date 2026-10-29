// lib/linux/weather.js — 天气采集：Open-Meteo 地理编码 + 预报（免 key，两跳串行）。
//
// 为什么要两个接口：Open-Meteo 的预报只认经纬度，城市名得先过 geocoding-api 换成坐标，
// 所以一次 fetchWeather 是「地理编码 → 预报」两跳。任何一跳不可用，整条按「不可用」处理。
//
// 规矩沿用 sysfs.js / netinfo.js（对应 BrimDeck.Core/SystemMonitor.cs:5-9）：读数只有
// 「已知」或「不可用 + 原因」两种，拿不到就给 null，绝不编造。这条在天气上尤其要紧：
// 0°C 是真读数（东北的冬天、山顶的清晨都是），null 是「取不到」。断网时拿 0°C 冒充，
// 面板会写「0°C 晴」，那是明确的假信息 —— 所以 parseForecast 宁可整条返回 null，也不补默认值。
//
// lib/linux 允许碰 GI，但一律惰性取（只有 gi()/soup()/gLib() 里才摸 imports）：
// node 侧 require 本文件跑纯解析测试时不会 ReferenceError，下面的 parse* 可以直接断死。
// 顶层只用 var / function：Cinnamon 的 imports 加载器只把顶层 var/function 挂到模块上，
// let/const 是块级声明，导入方会拿到 undefined。函数体内部随便用。
'use strict';

// Soup 版本必须在 import 之前钉死：Soup 3.0 才有 send_and_read_async，不写这句拿到的是 2.4 的 API。
// （2.4 里没有 send_and_read_async，消息收发是另一套 API，两版混用的结果是运行时才炸。）
if (typeof imports !== 'undefined' && imports.gi && imports.gi.versions) imports.gi.versions.Soup = '3.0';

// ---------------------------------------------------------------- 常量（都是「为什么是这个数」）

var GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
var FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
var WEATHER_UA = 'MintDeck';

// 上游要求 4s：一次取几 KB 的 JSON 不该拖更久，超时后 libsoup 以 CANCELLED 结束这次请求。
var HTTP_TIMEOUT_SEC = 4;
// 看门狗 = 超时 + 2s 余量。set_timeout 只管「连接/读写静默」，管不住回调被外部吞掉，
// 没有这道兜底，一条卡住的链会把 entry.handle 永久留在「在飞」，之后所有调用都排队，永不苏醒
// （netinfo.js:30-32 真机踩过这个坑，延迟面板一直显示 —，所以这里从一开始就带上）。
var REQUEST_WATCHDOG_MS = (HTTP_TIMEOUT_SEC + 2) * 1000;

// 预报缓存 10 分钟：Open-Meteo 的 current 段本来也就 15 分钟粒度，刷得更勤只是白烧请求。
var WEATHER_CACHE_MS = 10 * 60 * 1000;
// 失败安静期 60s：断网/被墙时若每帧都重试，就是对着 DNS 打点，还没有任何新信息。
var FAIL_BACKOFF_MS = 60 * 1000;

// 四日预报的响应在 2–3 KB 量级；128 KB 是「对面明显不对劲」的界线，别把内存交给服务器。
var MAX_RESPONSE_BYTES = 128 * 1024;

var FORECAST_DAYS = 4;                  // 面板要「今天 + 未来三天」
var CURRENT_FIELDS = 'temperature_2m,apparent_temperature,weather_code';
var DAILY_FIELDS = 'weather_code,temperature_2m_max,temperature_2m_min';

// 缓存表上限：设置里只有一个城市，正常也就一条；这个上限是防「有人在输入框里边打边调」把表撑大。
var MAX_ENTRY_LIMIT = 8;

// ---------------------------------------------------------------- GI 惰性句柄

function gi() {
  if (typeof imports === 'undefined' || !imports.gi) return null;
  return imports.gi;
}

function soup() {
  var g = gi();
  return g && g.Soup ? g.Soup : null;
}

function gLib() {
  var g = gi();
  return g && g.GLib ? g.GLib : null;
}

function noop() { }

function decode(bytes) {
  if (bytes === null || bytes === undefined) return '';
  if (typeof bytes === 'string') return bytes;
  try {
    return new TextDecoder().decode(bytes);
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------- 取值小工具
//
// 这三个函数的共同点：**不知道就返回 null**，绝不返回 0 / '' / NaN。
// NaN 尤其危险 —— 它会一路穿过 UI 变成 "NaN°C"，比「—」难看得多，也更容易被当成读数。

function trimOrNull(raw) {
  if (raw === null || raw === undefined) return null;
  var s = String(raw).trim();
  return s ? s : null;
}

// digits 给定时按位四舍五入（21.399999 → 21.4），只是收敛浮点毛刺，不改变读数。
function toFinite(raw, digits) {
  if (raw === null || raw === undefined) return null;
  // 空串/空白串必须先挡：Number('') 和 Number('  ') 都是 0，放过去就把「缺这个字段」变成 0°C。
  if (typeof raw === 'string' && !raw.trim()) return null;
  var v = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(v)) return null;
  if (typeof digits === 'number') {
    var p = Math.pow(10, digits);
    return Math.round(v * p) / p;
  }
  return v;
}

// JSON.parse 的失败一律当「没拿到」：半截 JSON、HTML 错误页（以 < 开头）、空串都走这里，不猜。
function parseJson(jsonText) {
  if (jsonText === null || jsonText === undefined) return null;
  var src = String(jsonText).trim();
  if (!src) return null;
  try {
    return JSON.parse(src);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- WMO 代码 → 图标分组
//
// 分组依据是「用户看到图标想确认的事」，不是逐条照抄代码表：
//   clear    0            天空全晴；
//   partly   1,2          1「大部晴」仍有少量云，跟 0 分开，否则一多半日子都是同一个太阳；
//   cloud    3            3 是「阴」：全天无直射，和 2 的「多云间晴」不是一回事；
//   fog      45,48        雾；48 是雾凇雾，同样贴地挡视线；
//   drizzle  51,53,55     毛毛雨三级；
//            56,57         冻毛毛雨 —— 落下来的形态仍是细雨，冰点信息本模块不上报，不另开一类；
//   rain     61,63,65     雨三级；
//            66,67         冻雨 —— 冻的是地面不是降水形态，归 rain；
//            80,81,82      阵雨三级 —— 与连续雨是时长差别，图标上没法区分，也归 rain；
//   snow     71,73,75     雪三级；77 雪粒；
//            85,86         阵雪；
//   storm    95,96,99     雷暴；96/99 是带冰雹的雷暴（冰雹单独画图标超出面板的表达力）。
// 表外的代码（4/10/30/40/50/60/70/79/90 等）Open-Meteo 不会给，真出现就是坏数据 → null，不猜。
var WMO_KINDS = {
  0: 'clear',
  1: 'partly',
  2: 'partly',
  3: 'cloud',
  45: 'fog',
  48: 'fog',
  51: 'drizzle',
  53: 'drizzle',
  55: 'drizzle',
  56: 'drizzle',
  57: 'drizzle',
  61: 'rain',
  63: 'rain',
  65: 'rain',
  66: 'rain',
  67: 'rain',
  71: 'snow',
  73: 'snow',
  75: 'snow',
  77: 'snow',
  80: 'rain',
  81: 'rain',
  82: 'rain',
  85: 'snow',
  86: 'snow',
  95: 'storm',
  96: 'storm',
  99: 'storm'
};

/**
 * WMO 天气代码 → 'clear'|'partly'|'cloud'|'fog'|'drizzle'|'rain'|'snow'|'storm'|null。
 * 只接受整数：Open-Meteo 给的是整数代码，4.5 这种只可能是坏数据或误传，按未知处理。
 * @param {number|string} code
 * @returns {string|null}
 */
function kindOf(code) {
  if (code === null || code === undefined) return null;
  // 先挡空串：Number('') === 0、Number('   ') === 0，不挡的话「没有代码」会被读成「晴」——
  // 那是把缺失值变成读数，正是本模块最不该做的事。
  if (typeof code === 'string' && !code.trim()) return null;
  var n = typeof code === 'number' ? code : Number(String(code).trim());
  if (!Number.isFinite(n) || n !== Math.trunc(n)) return null;
  var kind = WMO_KINDS[n];
  return typeof kind === 'string' ? kind : null;
}

// ---------------------------------------------------------------- 请求描述（只描述，不发）
//
// 只描述请求、不发请求，是为了让「换数据源」只有一处入口，也为了让 URL 能被测试直接断言。
// 中文城市名必须过 encodeURIComponent：Open-Meteo 收的是 percent-encoded UTF-8，
// 直接把「杭州」拼进 URL，libsoup 会按自己的默认编码再编一次，变成乱码查询。

/**
 * @param {string} city
 * @returns {{url:string}|null} 城市为空返回 null：发一个 name= 的空查询没有意义
 */
function geocodeRequest(city) {
  var name = trimOrNull(city);
  if (!name) return null;
  return {
    url: GEOCODE_URL +
      '?name=' + encodeURIComponent(name) +
      '&count=1&language=zh&format=json'
  };
}

// 纬度保留 4 位小数（约 11m）：Open-Meteo 的网格远粗于此，再多位只是让 URL 变长。
/**
 * @param {number} lat
 * @param {number} lon
 * @returns {{url:string}|null} 坐标非法/越界返回 null
 */
function forecastRequest(lat, lon) {
  var la = toFinite(lat);
  var lo = toFinite(lon);
  if (la === null || lo === null) return null;
  if (la < -90 || la > 90 || lo < -180 || lo > 180) return null;
  return {
    url: FORECAST_URL +
      '?latitude=' + toFinite(la, 4) +
      '&longitude=' + toFinite(lo, 4) +
      '&current=' + CURRENT_FIELDS +
      '&daily=' + DAILY_FIELDS +
      '&timezone=auto' +          // auto：让服务端按坐标返回本地时区，日界才对得上「今天」
      '&forecast_days=' + FORECAST_DAYS
  };
}

// ---------------------------------------------------------------- 地理编码解析

// 坐标范围检查：地理编码返回 999 纬度只可能是坏数据，拿到它去查预报只会得到另一个错答案。
function inLatRange(v) { return v !== null && v >= -90 && v <= 90; }
function inLonRange(v) { return v !== null && v >= -180 && v <= 180; }

/**
 * 解析 geocoding-api 的响应体。
 * - results 缺失 / 空数组 → null（这个城市名查不到，就是查不到，不退回默认城市）；
 * - 缺 lat/lon 或越界 → null（没有坐标，第二跳无从发起）；
 * - 缺 name → null（UI 上没法确认命中的是哪个地方，等于给了个不能显示的结果）；
 * - country 允许缺失 → null（小镇、极地科考站可能没有国家字段，不影响使用）。
 * @param {string} jsonText
 * @returns {{name:string, country:string|null, lat:number, lon:number}|null}
 */
function parseGeocode(jsonText) {
  var data = parseJson(jsonText);
  if (!data || typeof data !== 'object') return null;

  var results = data.results;
  if (!Array.isArray(results) || !results.length) return null;

  var hit = results[0];
  if (!hit || typeof hit !== 'object') return null;

  var name = trimOrNull(hit.name);
  if (!name) return null;

  var lat = toFinite(hit.latitude);
  var lon = toFinite(hit.longitude);
  if (!inLatRange(lat) || !inLonRange(lon)) return null;

  return { name: name, country: trimOrNull(hit.country), lat: lat, lon: lon };
}

// ---------------------------------------------------------------- 预报解析

// 只认 YYYY-MM-DD，而且要真是日历上存在的一天：2026-02-30 能过正则，
// Date 会把它滚到 3-02。所以回环比一次 —— 滚过就说明这个日期是假的，当坏数据丢掉。
var RE_DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(raw) {
  var s = trimOrNull(raw);
  if (!s || !RE_DAY.test(s)) return null;
  var probe = new Date(s + 'T00:00:00Z');
  if (!Number.isFinite(probe.getTime())) return null;
  if (probe.toISOString().slice(0, 10) !== s) return null;
  return s;
}

// current.time 形如 "2026-10-29T17:30"（timezone=auto 下是地方时，无时区后缀）。
// updatedAt 只回放这个字符串，不拿本机时钟顶替：本机时钟和「观测时间」是两件事。
var RE_STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/;

function parseStamp(raw) {
  var s = trimOrNull(raw);
  if (!s) return null;
  var m = RE_STAMP.exec(s);
  if (!m) return null;
  if (!parseDay(m[1])) return null;
  if (Number(m[2]) > 23 || Number(m[3]) > 59) return null;
  return s;
}

/**
 * 解析 forecast 的响应体。
 * 返回 null 的几种情况（都是「没有可用读数」，不是「天气是 0 度」）：
 *   1. 不是 JSON / 半截 JSON / HTML 错误页；
 *   2. 缺 current，或 current.temperature_2m 不是有限数 —— 当前气温是这条数据的锚，没有它整条不用；
 *   3. 缺 daily，或 daily 的四个数组有一个不是数组；
 *   4. 每一天都拿不齐（日期非法 / 缺最高最低温），days 为空。
 * 四日数组长度不一（某天少一项）时按最短截断：多出来的那天没有任何温度可用，补一个就是假数据。
 * 单日里 kind 允许为 null（未知代码只丢图标，气温照给）；apparentC 同理。
 * highC/lowC 恒等于 days[0] 的 max/min —— 保证两个字段和四日预报的第一格永远不打架。
 * @param {string} jsonText
 * @returns {{tempC:number, apparentC:number|null, kind:string|null, highC:number,
 *             lowC:number, days:Array<{date:string, maxC:number, minC:number, kind:string|null}>,
 *             updatedAt:string|null}|null}
 */
function parseForecast(jsonText) {
  var data = parseJson(jsonText);
  if (!data || typeof data !== 'object') return null;

  var current = data.current;
  if (!current || typeof current !== 'object') return null;

  var tempC = toFinite(current.temperature_2m, 1);
  if (tempC === null) return null;      // 连「现在几度」都没有：不给 UI 任何数字

  var daily = data.daily;
  if (!daily || typeof daily !== 'object') return null;

  var times = daily.time;
  var codes = daily.weather_code;
  var maxes = daily.temperature_2m_max;
  var mins = daily.temperature_2m_min;
  if (!Array.isArray(times) || !Array.isArray(codes) ||
    !Array.isArray(maxes) || !Array.isArray(mins)) return null;

  var count = Math.min(times.length, codes.length, maxes.length, mins.length);
  var days = [];
  for (var i = 0; i < count; i++) {
    var date = parseDay(times[i]);
    var high = toFinite(maxes[i], 1);
    var low = toFinite(mins[i], 1);
    if (!date || high === null || low === null) continue;   // 这天不完整：跳过，不补 0
    days.push({ date: date, maxC: high, minC: low, kind: kindOf(codes[i]) });
  }
  if (!days.length) return null;        // 一天都拿不齐：四日预报这块不可用

  return {
    tempC: tempC,
    apparentC: toFinite(current.apparent_temperature, 1),
    kind: kindOf(current.weather_code),
    highC: days[0].maxC,
    lowC: days[0].minC,
    days: days,
    updatedAt: parseStamp(current.time)
  };
}

// ---------------------------------------------------------------- 异步 HTTP
//
// 抽成一份而不是在 fetchWeather 里写两遍：一次天气要打两个接口，两份一样的连接/超时/看门狗
// 逻辑抄两遍，必然有一处漏掉 set_timeout 或忘了判状态码，而那种 bug 只在断网时才现形。

/**
 * 一次 GET，把响应体当 UTF-8 文本回调回来。失败一律 cb(null)，不抛。
 * 失败含：没有 Soup/GLib（node 侧、applet 极早期）、构造失败、超时、非 2xx、空体、超长。
 * 为什么要判 2xx：Open-Meteo 参数错了会回 400 + 一个 {"error":true,"reason":"..."} 的 JSON，
 * 不判状态码的话它会一路走到 JSON.parse，然后在「缺 current」那里悄悄变成 null，原因就丢了。
 * @param {{url:string}} request
 * @param {function(string|null)} cb
 * @returns {{abort:function}|null}
 */
function requestText(request, cb) {
  var done = typeof cb === 'function' ? cb : noop;
  var url = request && typeof request.url === 'string' ? request.url : null;
  if (!url) { done(null); return null; }

  var Soup = soup();
  var GLib = gLib();
  if (!Soup || !GLib) { done(null); return null; }   // node 侧：一句也不抛，直接不可用

  var session = null;
  var message = null;
  try {
    session = new Soup.Session();
    session.set_timeout(HTTP_TIMEOUT_SEC);
    message = Soup.Message.new('GET', url);
    var headers = message.get_request_headers();
    headers.append('User-Agent', WEATHER_UA);
    headers.append('Accept', 'application/json');
  } catch (e) {
    done(null);
    return null;
  }

  var finished = false;
  var timerId = 0;

  function settle(value) {
    if (finished) return;
    finished = true;
    if (timerId) {
      try { GLib.source_remove(timerId); } catch (e) { /* 已经触发过 */ }
      timerId = 0;
    }
    done(value);
  }

  var handle = {
    abort: function () {
      if (finished) return;
      try { session.abort(); } catch (e) { /* 已经结束 */ }
      settle(null);
    }
  };

  session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, function (sess, result) {
    if (finished) return;
    var body = null;
    try {
      var status = message.get_status();
      var bytes = sess.send_and_read_finish(result);   // 超时/断网/TLS 失败在这里抛
      var payload = bytes ? bytes.get_data() : null;
      if (status >= 200 && status < 300 && payloadFits(payload)) {
        body = decode(payload);
      }
    } catch (e) {
      body = null;
    }
    settle(body && body.trim() ? body : null);
  });

  // 看门狗：见 REQUEST_WATCHDOG_MS 上的注释。触发时顺手 abort 掉会话，免得它在后台继续占连接。
  // 注意 timeout_add 必须给 3 个参数（priority, interval, callback）：GJS 里 2 参数形式会抛
  // "At least 3 arguments required"，而这条调用在请求路径上，抛出去就等于整条链断掉。
  // 所以再包一层 try：拿不到定时器只是少一道兜底，不该让一次天气采集直接失败。
  try {
    timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REQUEST_WATCHDOG_MS, function () {
      timerId = 0;
      try { session.abort(); } catch (e) { /* 已经结束 */ }
      settle(null);
      return false;
    });
  } catch (e) {
    timerId = 0;
  }

  return handle;
}

// 单独一个谓词只是为了保持上面那段 try 短，一眼能看出「空体 / 超大」这类该弃的响应。
function payloadFits(payload) {
  return !!payload && payload.length > 0 && payload.length <= MAX_RESPONSE_BYTES;
}

// ---------------------------------------------------------------- 异步：天气
//
// 缓存表：key 是归一化后的城市名。每个 entry 自带 waiters，所以「同一时刻只飞一条」是
// 按城市成立的 —— 面板只有一个城市（来自设置），这就是同一时刻只有一条链在飞；
// 换城市时新城市各自独立，旧城市的链不会把新城市卡住（这正是要 per-city 而不是全局单飞的原因）。
//
// key 用 trim + toLowerCase：设置里存 "Hangzhou"/"hangzhou" 应命中同一份缓存；中文不受影响。
var weatherCache = {};

function cacheKey(city) {
  return String(city === null || city === undefined ? '' : city).trim().toLowerCase();
}

function entryFor(key) {
  var entry = weatherCache[key];
  if (!entry) {
    entry = { at: 0, data: null, failAt: 0, handle: null, waiters: [] };
    weatherCache[key] = entry;
  }
  return entry;
}

function drainWaiters(list, value) {
  var pending = list.slice(0);
  list.length = 0;
  for (var i = 0; i < pending.length; i++) {
    // 单个回调炸了不能连累别人：Cinnamon 里那就是一条无法定位的 GLib 日志，还顺手带走整条链的下一次刷新。
    try { pending[i](value); } catch (e) { /* 忽略 */ }
  }
}

// 表满了就扔掉「最久没动静且不在飞」的那条。在飞的绝不删：删了它回调回来时找不到 entry，
// 排队的人就永远等不到答案（netinfo.js:560-564 有同样的教训）。
function pruneEntries() {
  var keys = Object.keys(weatherCache);
  while (keys.length > MAX_ENTRY_LIMIT) {
    var victimKey = null;
    var victimStamp = 0;
    for (var i = 0; i < keys.length; i++) {
      var entry = weatherCache[keys[i]];
      if (!entry || entry.handle) continue;
      var stamp = Math.max(entry.at || 0, entry.failAt || 0);
      if (victimKey === null || stamp < victimStamp) {
        victimKey = keys[i];
        victimStamp = stamp;
      }
    }
    if (victimKey === null) return;      // 全在飞：宁可不缩表
    delete weatherCache[victimKey];
    keys = Object.keys(weatherCache);
  }
}

/**
 * 取某城市的天气：地理编码 → 预报，两跳串行，回调只会被叫一次。
 * - 城市为空 → **同步** cb(null)：城市来自设置，空着就是「没配」，不拿默认城市顶替；
 * - 成功缓存 10 分钟（按城市）；失败 cb(null) 并安静 60s（断网时不反复打接口）；
 * - 同城同时只飞一条链，后来的调用排队等这次结果，不打并发。
 * @param {string} city
 * @param {function(object|null)} cb
 * @returns {{abort:function}|null} 在飞的句柄；缓存命中 / 直接不可用时为 null
 */
function fetchWeather(city, cb) {
  var done = typeof cb === 'function' ? cb : noop;
  var name = trimOrNull(city);
  if (!name) { done(null); return null; }

  pruneEntries();

  var key = cacheKey(name);
  var entry = entryFor(key);
  var now = Date.now();

  if (entry.handle) {                    // 同城已有链在飞：排队
    entry.waiters.push(done);
    return entry.handle;
  }
  if (entry.data && entry.at && (now - entry.at) < WEATHER_CACHE_MS) {
    done(entry.data);                    // 10 分钟内的成功结果直接回放，不再打接口
    return null;
  }
  if (!entry.data && entry.failAt && (now - entry.failAt) < FAIL_BACKOFF_MS) {
    done(null);                          // 刚失败过：安静期里不再发请求，UI 继续显示「不可用」
    return null;
  }

  entry.waiters.push(done);

  var aborted = false;
  var current = null;                    // 当前这一跳的句柄（abort 要能打断第二跳）

  var handle = {
    abort: function () {
      if (aborted) return;
      aborted = true;
      entry.handle = null;               // 先摘干净：留着它这条 entry 会永久停在「在飞」
      var hop = current;
      current = null;
      if (hop) { try { hop.abort(); } catch (e) { /* 已经结束 */ } }
      entry.data = null;
      entry.failAt = Date.now();
      drainWaiters(entry.waiters, null);
    }
  };

  function finish(result) {
    if (aborted) return;
    aborted = true;
    entry.handle = null;
    entry.at = Date.now();
    if (result) {
      entry.data = result;
    } else {
      entry.data = null;                 // 失败时连旧结果也丢掉：宁可显示「不可用」，不显示过期读数
      entry.failAt = entry.at;
    }
    drainWaiters(entry.waiters, result || null);
  }

  // 先挂上句柄再起飞：第一跳在 node 侧会**同步**回调失败，若等起飞后才赋值，
  // finish() 先把 entry.handle 清成 null，紧接着又写回这个已死的 handle ——
  // 这条 entry 就永久停在「在飞」，之后每次调用都排进 waiters 永远不被叫醒。
  entry.handle = handle;

  // 第一跳：城市 → 坐标
  var first = requestText(geocodeRequest(name), function (geoText) {
    if (aborted) return;
    if (!geoText) { finish(null); return; }

    var place = parseGeocode(geoText);
    if (!place) { finish(null); return; }

    var req = forecastRequest(place.lat, place.lon);
    if (!req) { finish(null); return; }

    // 第二跳：坐标 → 预报
    var second = requestText(req, function (forecastText) {
      if (aborted) return;
      if (!forecastText) { finish(null); return; }

      var forecast = parseForecast(forecastText);
      if (!forecast) { finish(null); return; }

      // place 是「服务端认为你问的是哪个地方」，显示出来用户能核对（"杭州" → "杭州市, 中国"）。
      forecast.place = { name: place.name, country: place.country };
      finish(forecast);
    });
    current = second;
    if (!second && !aborted) finish(null);
  });

  current = first;
  if (!first && !aborted) finish(null);  // 第一跳就同步失败（node 侧没有 Soup）

  return handle;
}

if (typeof module !== 'undefined') {
  module.exports = {
    // 纯函数
    kindOf: kindOf,
    geocodeRequest: geocodeRequest,
    parseGeocode: parseGeocode,
    forecastRequest: forecastRequest,
    parseForecast: parseForecast,
    // 异步
    requestText: requestText,
    fetchWeather: fetchWeather,
    // 常量（改数据源 / 改缓存时长就改这里）
    GEOCODE_URL: GEOCODE_URL,
    FORECAST_URL: FORECAST_URL,
    WEATHER_CACHE_MS: WEATHER_CACHE_MS,
    FAIL_BACKOFF_MS: FAIL_BACKOFF_MS,
    HTTP_TIMEOUT_SEC: HTTP_TIMEOUT_SEC,
    // 只为测试：清空缓存与安静期，生产代码不要调
    resetForTests: function () { weatherCache = {}; }
  };
}
