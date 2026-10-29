// lib/linux/netinfo.js — 网络质量采集：延迟（ping）、公网 IP（Soup）、链路状态（sysfs）。
//
// 三条通道各自独立、互不阻塞：
//   · link     —— 同步读 /proc/net/dev + /sys/class/net/<iface>/{operstate,speed,mtu}，微秒级，不离开主循环；
//   · latency  —— ping 子进程，全异步（走 lib/linux/exec），缓存 60s，同一时刻只允许一条在飞；
//   · publicIp —— Soup 异步 GET api.ipify.org，缓存 10 分钟，超时 4s。
//
// 上游语义同 BrimDeck.Core/SystemMonitor.cs:5-9：读数只有「已知」或「不可用 + 原因」两种，
// 不可用返回 null，绝不编造 0（所以丢包率不会拿 transmitted/received 硬凑，见 parsePing 的注释）。
//
// 本文件属 lib/linux，允许碰 GI；但一律惰性取（gi()/soup()/execModule() 里才碰 imports），
// 这样 node 侧 require 时不会 ReferenceError，纯解析函数可以直接断言。
// 顶层只用 var / function：Cinnamon 的 imports 加载器对顶层块级声明不如 function 稳。
'use strict';

// Soup 版本必须在 import 之前钉死：Soup 3.0 才有 send_and_read_async，不写这句拿到的是别的 API。
// 注意：Soup 3 里没有 Session.send_async（2.4 的 API），消息收发一律走 send_and_read_async。
if (typeof imports !== 'undefined' && imports.gi && imports.gi.versions) imports.gi.versions.Soup = '3.0';

// 默认探测目标：1.1.1.1 有 anycast 且不响应 HTTP，被墙/DNS 污染的概率比 8.8.8.8 低。
// 想换目标改这一行即可（也可以在调用时给 pingCached 传 host，见 pingCached 的注释）。
var DEFAULT_PING_HOST = '1.1.1.1';

// 实测 iputils：ping -c 3 -W 1 -n 1.1.1.1 约 2.0s 出统计行；-W 是「单包等待上限」。
var PING_COUNT = 3;
var PING_WAIT_SEC = 1;

var PING_CACHE_MS = 60 * 1000;          // 延迟缓存 60s：秒级的刷新对这个面板没意义，只会白烧子进程
var FAIL_BACKOFF_MS = 60 * 1000;
// ping 的看门狗：正常 3 秒内一定结束；exec 层被 cancel（applet reload 时的 cancelAll）时
// 它的回调是「静默返回」的，不设看门狗的话 pingCache.handle 会永远停在「在飞」，延迟就此永久 null。
var PING_WATCHDOG_MS = 10000;        // 失败后的安静期：没有 ping / 没有 Soup / 请求失败，60s 内不再试
var PUBLIC_IP_CACHE_MS = 10 * 60 * 1000; // 公网 IP 缓存 10 分钟（家宽重播号不常有，10 分钟足够灵敏）
var HTTP_TIMEOUT_SEC = 4;               // 上游要求 4s：一次取十几字节的请求不该拖更久
var MAX_RESPONSE_BYTES = 64 * 1024;     // 公网 IP 响应就几十字节，超过这个数说明对面不对劲

var PUBLIC_IP_URL = 'https://api.ipify.org?format=json';
var PUBLIC_IP_UA = 'MintDeck';

// 与 sysmon 同规则的虚拟接口表（独立实现，不 require sysmon：本模块要能单独测）。
// 前缀表按「接口名可能带后缀」的命名习惯写：veth*、docker*、br-<hash>、virbr*。
var VIRTUAL_PREFIXES = ['veth', 'docker', 'br-', 'virbr'];
var VIRTUAL_EXACT = ['lo', 'meta'];     // meta 按小写比较：本机 tun 名就是字面量 Meta

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

// 子进程统一走 lib/linux/exec（异步）。node 侧没有 imports，取到 null 由调用方按「不可用」处理。
function execModule() {
  if (typeof imports === 'undefined' || !imports.lib) return null;
  try {
    return imports.lib.linux && imports.lib.linux.exec ? imports.lib.linux.exec : null;
  } catch (e) {
    return null;
  }
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

// 读文本文件；读不到（不存在 / EINVAL / 没有 GLib）返回 null。
// null 与 '' 必须分开：operstate 读不到是「不知道」，读成空串会变成「unknown 接口」。
function readTextOrNull(path) {
  var GLib = gLib();
  if (!GLib) return null;
  try {
    var result = GLib.file_get_contents(path);
    if (!result || !result[0]) return null;
    return decode(result[1]);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- ping 输出解析

// 统计行里两个数字段可能被本地化成分号小数点（德语 "33,3333% packet loss"），统一按逗号先归一。
var RE_PACKETS_TX = /(\d+)\s+packets?\s+transmitted/i;
var RE_PACKETS_RX = /(\d+)\s+(?:packets?\s+)?received/i;
var RE_PACKET_LOSS = /([\d.,]+)%\s*packet\s+loss/i;
// iputils:  rtt min/avg/max/mdev = 12.3/14.1/16.0/1.2 ms
// busybox:  round-trip min/avg/max = 12.3/14.1/16.0 ms
// 只取 min/avg 两段：avg 是面板要的「延迟」，mdev/stddev 抖动本模块暂不上报。
var RE_RTT = /(?:rtt|round-trip)\s+min\/avg(?:\/max)?(?:\/(?:mdev|stddev))?\s*=\s*([\d.,]+)\/([\d.,]+)/i;

function toNumber(raw) {
  if (raw === null || raw === undefined) return null;
  var v = Number(String(raw).replace(/,/g, '.'));
  return Number.isFinite(v) ? v : null;
}

function toInt(raw) {
  var v = toNumber(raw);
  return v === null ? null : Math.round(v);
}

// 丢包率夹到 0–100，保留两位（"33.3333%" → 33.33）。
function clampLoss(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  var v = value < 0 ? 0 : value > 100 ? 100 : value;
  return Math.round(v * 100) / 100;
}

/**
 * 解析 `ping -c 3 -W 1 -n HOST` 的 stdout（iputils 与 busybox 两种格式）。
 * - rttMs 取 min/avg/max 的 **avg**；
 * - 全丢包时没有 rtt 行：rttMs 为 null，lossPercent 为 100（这是「已知的差」，不是「不知道」）；
 * - 只认统计行：既没有 transmitted 也没有 loss/rtt 行（报错信息、乱码、空串）时返回 null；
 * - loss 行缺失但收发计数齐全时才由 100*(1-rx/tx) 反推，其余一律 null —— 不编造。
 * @param {string} stdout
 * @returns {{rttMs:number|null, lossPercent:number|null, transmitted:number|null}|null}
 */
function parsePing(stdout) {
  var text = stdout === null || stdout === undefined ? '' : String(stdout);
  if (!text.trim()) return null;

  var txMatch = RE_PACKETS_TX.exec(text);
  var lossMatch = RE_PACKET_LOSS.exec(text);
  var rtt = RE_RTT.exec(text);

  var transmitted = txMatch ? toInt(txMatch[1]) : null;
  // 一行统计都没有 → 这不是 ping 的统计输出（典型是 "ping: connect: Network is unreachable"）。
  if (transmitted === null && !lossMatch && !rtt) return null;

  var lossPercent = null;
  if (lossMatch) {
    lossPercent = clampLoss(toNumber(RE_PACKET_LOSS.exec(text)[1]));
  } else if (transmitted !== null && transmitted > 0) {
    var rxMatch = RE_PACKETS_RX.exec(text);
    var received = rxMatch ? toInt(rxMatch[1]) : null;
    if (received !== null) lossPercent = clampLoss(100 * (1 - received / transmitted));
  }

  var rttMs = rtt ? toNumber(rtt[2]) : null;   // rtt[1]=min, rtt[2]=avg

  return { rttMs: rttMs, lossPercent: lossPercent, transmitted: transmitted };
}

// ---------------------------------------------------------------- /proc/net/dev

function isExcludedIface(name) {
  var low = String(name).toLowerCase();
  if (VIRTUAL_EXACT.indexOf(low) >= 0) return true;
  for (var i = 0; i < VIRTUAL_PREFIXES.length; i++) {
    if (low.indexOf(VIRTUAL_PREFIXES[i]) === 0) return true;
  }
  return false;
}

/**
 * /proc/net/dev 的「真实」接口列表（排除 lo / Meta / veth* / docker* / br-* / virbr*，保持文件顺序）。
 * rx 是冒号后第 1 个数字、tx 是第 9 个（§6.3 实测）。
 * 返回 [] 表示「没有可用接口」，不是「没有网卡」：全虚拟的环境（纯容器）也会给 []。
 * @param {string} text
 * @returns {{name:string, rxBytes:number, txBytes:number}[]}
 */
function parseIfaces(text) {
  var out = [];
  var rows = String(text === null || text === undefined ? '' : text).split('\n');
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var cut = row.indexOf(':');
    if (cut < 0) continue;
    var name = row.slice(0, cut).trim();
    if (!name) continue;
    if (isExcludedIface(name)) continue;
    var fields = row.slice(cut + 1).trim().split(/\s+/);
    if (fields.length < 9) continue;          // 表头行与残行都过不了这一关
    var rx = Number(fields[0]);
    var tx = Number(fields[8]);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
    out.push({ name: name, rxBytes: rx, txBytes: tx });
  }
  return out;
}

// ---------------------------------------------------------------- 链路状态（sysfs）

// operstate 只上报三态：sysfs 里的 dormant / lowerlayerdown / notpresent / testing 一律归 unknown。
function normalizeOperstate(raw) {
  if (raw === null || raw === undefined) return null;
  var v = String(raw).trim().toLowerCase();
  if (!v) return null;
  if (v === 'up') return 'up';
  if (v === 'down') return 'down';
  return 'unknown';
}

/**
 * 读一张网卡的链路状态。
 * 坑（本机实测）：
 *   · 无线网卡 wlp5s0 的 /sys/class/net/<if>/speed 是 EINVAL，读不到 → speedMbps null（不是 0）；
 *   · enp6s0 down 时 speed 给 "-1" → 非正数一律当未知；
 *   · operstate 文件不存在（老内核/特殊设备）→ null，调用方按「不知道」显示。
 * @param {string} iface
 * @param {function(string):(string|null)=} readFile 注入读文件（node 测试用）；默认走 GLib
 * @returns {{iface:string|null, operstate:string|null, speedMbps:number|null, mtu:number|null}}
 */
function readLinkState(iface, readFile) {
  var read = typeof readFile === 'function' ? readFile : readTextOrNull;
  var name = iface === null || iface === undefined ? '' : String(iface).trim();
  var out = { iface: name || null, operstate: null, speedMbps: null, mtu: null };
  if (!name) return out;

  var base = '/sys/class/net/' + name + '/';
  var state = read(base + 'operstate');
  out.operstate = state === null || state === undefined ? null : normalizeOperstate(state);

  var speedRaw = read(base + 'speed');
  if (speedRaw !== null && speedRaw !== undefined) {
    var speed = toNumber(String(speedRaw).trim());
    if (speed !== null && speed > 0) out.speedMbps = Math.round(speed);
  }

  var mtuRaw = read(base + 'mtu');
  if (mtuRaw !== null && mtuRaw !== undefined) {
    var mtu = toNumber(String(mtuRaw).trim());
    if (mtu !== null && mtu > 0) out.mtu = Math.round(mtu);
  }
  return out;
}

// 选一张「真实在用」的网卡：第一张 operstate=up 的；都不 up 时退回第一张（down 也是有信息量的）。
function currentLink() {
  var text = readTextOrNull('/proc/net/dev');
  if (text === null) return null;
  var ifaces = parseIfaces(text);
  if (!ifaces.length) return null;
  var fallback = null;
  for (var i = 0; i < ifaces.length; i++) {
    var state = readLinkState(ifaces[i].name);
    if (!fallback) fallback = state;
    if (state.operstate === 'up') return state;
  }
  return fallback;
}

// ---------------------------------------------------------------- 公网 IP

function normalizeIpValue(raw) {
  if (raw === null || raw === undefined) return null;
  var text = String(raw).trim();
  if (!text) return null;
  // 去掉可能包裹的引号（裸 JSON 字符串 '"1.2.3.4"'）
  if ((text.charAt(0) === '"' && text.charAt(text.length - 1) === '"') ||
    (text.charAt(0) === '\'' && text.charAt(text.length - 1) === '\'')) {
    text = text.slice(1, -1).trim();
  }
  if (!text) return null;

  var v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    for (var i = 1; i <= 4; i++) {
      if (Number(v4[i]) > 255) return null;     // 999.1.1.1 之类直接拒
    }
    return text;
  }

  // IPv6：只做粗校验（字符集 + 至少两个冒号 + 不许三条连续冒号），完整语法交给内核。
  // api64.ipify.org 会回 IPv6，这里不认就白丢一半环境。
  if (text.indexOf(':') > 0 && text.indexOf(':::') < 0 && /^[0-9a-fA-F:.]+$/.test(text)) return text;

  return null;
}

/**
 * 解析公网 IP 响应体：接受 {"ip":"1.2.3.4"}（ipify 的 format=json）、
 * 或裸文本 "1.2.3.4\n"；非法 / 空 / JSON 里没有 ip 字段一律 null。
 * @param {string} text
 * @returns {string|null}
 */
function parsePublicIp(text) {
  if (text === null || text === undefined) return null;
  var src = String(text).trim();
  if (!src) return null;

  var head = src.charAt(0);
  if (head === '{' || head === '[' || head === '"') {
    var data;
    try {
      data = JSON.parse(src);
    } catch (e) {
      return null;
    }
    if (Array.isArray(data)) data = data.length ? data[0] : null;
    if (typeof data === 'string') return normalizeIpValue(data);
    if (!data || typeof data !== 'object') return null;
    var value = typeof data.ip === 'string' ? data.ip : (typeof data.query === 'string' ? data.query : null);
    return normalizeIpValue(value);
  }

  // 裸文本：只认第一行（有的服务会在 IP 后面补一行说明）
  var firstLine = src.split('\n')[0].trim();
  return normalizeIpValue(firstLine);
}

// 只描述请求，不发：调用方要换服务时改这里（或改 PUBLIC_IP_URL 常量）即可，别在 fetchPublicIp 里散落 URL。
function publicIpRequest() {
  return {
    method: 'GET',
    url: PUBLIC_IP_URL,
    headers: { 'User-Agent': PUBLIC_IP_UA }
  };
}

// ---------------------------------------------------------------- 异步：ping

/**
 * 跑一次 ping 拿延迟。argv 形式（不拼 shell 字符串，与 exec.js 一致）。
 * 拿不到统计就 cb(null)：没有 ping 命令、网络不可达、全丢包（iputils 全丢包时退出码 1，
 * exec.run 只把 exit 0 的 stdout 交出来）都走这条。
 * @param {string} host
 * @param {function(object|null)} cb
 * @returns {{cancel:function}|null} exec 句柄（可取消）；同步失败返回 null
 */
function probePing(host, cb) {
  var done = typeof cb === 'function' ? cb : noop;
  var target = host === null || host === undefined ? DEFAULT_PING_HOST : String(host).trim();
  if (!target) { done(null); return null; }
  var Exec = execModule();
  if (!Exec) { done(null); return null; }   // node 侧 / 极早期启动：一句也不抛
  var argv = ['ping', '-c', String(PING_COUNT), '-W', String(PING_WAIT_SEC), '-n', target];
  return Exec.run(argv, function (stdout, code) {
      if (code !== 'ok' || !stdout) { done(null); return; }
    done(parsePing(stdout));
  });
}

// 延迟缓存：at 记录「最后一次尝试的时间」（成功失败都记），所以失败也会自然安静 60s，不会形成重试风暴。
var pingCache = { at: 0, sample: null, handle: null, waiters: [] };

function drainWaiters(list, value) {
  var pending = list.slice(0);
  list.length = 0;
  for (var i = 0; i < pending.length; i++) {
    try { pending[i](value); } catch (e) { /* 单个回调炸了不影响别人 */ }
  }
}

/**
 * 带缓存的延迟读数。
 * - 60s 内的结果（含 null）直接回放，不再起子进程；
 * - 同一时刻只允许一条 ping 在飞，后来的调用排进 waiters，等这一次结果，绝不打并发；
 * - 没有 ping 命令 → cb(null)，并在 60s 内不再重试（FAIL_BACKOFF_MS 由 pingCache.at 兜住）。
 * @param {function(object|null)} cb
 * @returns {{cancel:function}|null} 在飞的句柄（缓存命中时为 null）
 */
function pingCached(cb) {
  var done = typeof cb === 'function' ? cb : noop;
  var now = Date.now();

  if (pingCache.handle) {                 // 已经有一条在飞：排队
    pingCache.waiters.push(done);
    return pingCache.handle;
  }
  if (pingCache.at && (now - pingCache.at) < PING_CACHE_MS) {
    done(pingCache.sample);               // 缓存命中，可能是 null（上一次就是失败）
    return null;
  }

  pingCache.waiters.push(done);
  var handle = probePing(DEFAULT_PING_HOST, function (sample) {
    clearWatchdog();
    pingCache.handle = null;
    pingCache.at = Date.now();
    pingCache.sample = sample || null;
    drainWaiters(pingCache.waiters, pingCache.sample);
  });

  // 看门狗：进程被杀 / 回调被静默丢弃时，10 秒后把排队的人放掉（给 null，UI 显示 —）
  var watchdogId = 0;
  var glib = gLib();
  if (glib) {
    // GJS 的 GLib.timeout_add 要三个参数（priority, interval, callback）；
    // 只传两个会在真机上抛 "At least 3 arguments required"，被外层 try 吞掉，看门狗等于没装。
    watchdogId = glib.timeout_add(glib.PRIORITY_DEFAULT, PING_WATCHDOG_MS, function () {
      watchdogId = 0;
      if (!pingCache.waiters.length) return false;
      pingCache.handle = null;
      pingCache.at = Date.now();
      pingCache.sample = null;
      drainWaiters(pingCache.waiters, null);
      return false;
    });
  }
  function clearWatchdog() {
    if (!watchdogId) return;
    try { glib.source_remove(watchdogId); } catch (e) { /* 已经触发 */ }
    watchdogId = 0;
  }
  // probePing 在「没有 Exec」时会同步回调（此时 handle 为 null），赋值顺序仍安全：
  // 回调里已经把 handle 置空、把 waiters 发完，这里再把 null 写回去，不会漏发也不会重发。
  pingCache.handle = handle || null;
  return pingCache.handle;
}

// ---------------------------------------------------------------- 异步：公网 IP

var ipCache = { at: 0, ip: null, handle: null, waiters: [] };

/**
 * 取公网 IP。成功缓存 10 分钟；失败（含没有 Soup）cb(null) 并安静 60s。
 * 全程异步：Soup 的 send_and_read_async 在 GLib 主循环里回调；4s 超时由 session.set_timeout 兜住，
 * 超时后 libsoup 以 CANCELLED 结束这次请求（与 lyrics.js 的处理一致），失败分支照常 settle。
 * @param {function(string|null)} cb
 * @returns {{abort:function}|null}
 */
function fetchPublicIp(cb) {
  var done = typeof cb === 'function' ? cb : noop;
  var now = Date.now();

  if (ipCache.handle) {
    ipCache.waiters.push(done);
    return ipCache.handle;
  }
  if (ipCache.ip && ipCache.at && (now - ipCache.at) < PUBLIC_IP_CACHE_MS) {
    done(ipCache.ip);
    return null;
  }
  if (!ipCache.ip && ipCache.at && (now - ipCache.at) < FAIL_BACKOFF_MS) {
    done(null);                           // 刚失败过，安静期里不再发请求
    return null;
  }

  var Soup = soup();
  var GLib = gLib();
  if (!Soup || !GLib) {
    ipCache.at = now;
    ipCache.ip = null;                    // 没有 Soup：记住这次失败，60s 内不再试
    done(null);
    return null;
  }

  var request = publicIpRequest();
  var session;
  var message;
  try {
    session = new Soup.Session();
    session.set_timeout(HTTP_TIMEOUT_SEC);
    message = Soup.Message.new(request.method, request.url);
    var headers = message.get_request_headers();
    var keys = Object.keys(request.headers || {});
    for (var i = 0; i < keys.length; i++) headers.append(keys[i], request.headers[keys[i]]);
    headers.append('Accept', 'application/json');
  } catch (e) {
    ipCache.at = now;
    ipCache.ip = null;
    done(null);
    return null;
  }

  var finished = false;
  var handle = {
    abort: function () {
      if (finished) return;
      finished = true;
      try { session.abort(); } catch (e) { /* 已经结束 */ }
      ipCache.handle = null;
      ipCache.at = Date.now();
      ipCache.ip = null;
      drainWaiters(ipCache.waiters, null);
    }
  };
  ipCache.waiters.push(done);

  session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, function (sess, result) {
    if (finished) return;
    finished = true;
    ipCache.handle = null;
    ipCache.at = Date.now();

    var ip = null;
    try {
      var bytes = sess.send_and_read_finish(result);   // 超时/断网时这里抛，走下面的 catch
      var data = bytes ? bytes.get_data() : null;
      if (data && data.length && data.length <= MAX_RESPONSE_BYTES) {
        ip = parsePublicIp(decode(data));
      }
    } catch (e) {
      ip = null;
    }
    ipCache.ip = ip;                        // 失败就把旧值也丢掉：宁可显示「—」也不要显示过期的 IP
    drainWaiters(ipCache.waiters, ip);
  });
  ipCache.handle = handle;
  return handle;
}

// ---------------------------------------------------------------- 组装

/**
 * 一次「网络质量」采集，三件事互不阻塞，谁先到先回。
 * onSample 会被调用 1–3 次，每次给一整个快照；还没到的字段是 null（调用方按字段判空即可）。
 * 顺序通常为 link → latency → publicIp（link 是同步的，另外两件各自异步）。
 * @param {function({latency:object|null, publicIp:string|null, link:object|null})} onSample
 * @returns {{abort:function}|null}
 */
function collectAsync(onSample) {
  var emit = typeof onSample === 'function' ? onSample : noop;
  var out = { latency: null, publicIp: null, link: null };
  var aborted = false;
  var pingHandle = null;
  var ipHandle = null;

  function publish() {
    if (aborted) return;
    try {
      emit({ latency: out.latency, publicIp: out.publicIp, link: out.link });
    } catch (e) {
      // 回调里的异常不该把采集链带断（Cinnamon 里那就是一条无法定位的 GLib 日志）
    }
  }

  // 1) 链路：同步，微秒级，先出一帧，UI 立刻有网卡名与速率可显示。
  try { out.link = currentLink(); } catch (e) { out.link = null; }
  publish();

  // 2) 延迟：异步。缓存命中/没有 Exec 时会同步回调，照样触发一次 onSample。
  try {
    pingHandle = pingCached(function (sample) {
      out.latency = sample || null;
      publish();
    });
  } catch (e) {
    out.latency = null;
  }

  // 3) 公网 IP：异步。与 ping 并行，谁先回来谁先回。
  try {
    ipHandle = fetchPublicIp(function (ip) {
      out.publicIp = ip || null;
      publish();
    });
  } catch (e) {
    out.publicIp = null;
  }

  return {
    // 只停止「再发布」，**不杀**在跑的 ping / 公网 IP 请求：
    // 这两个请求带缓存、被所有 collector 共享（pingCached / fetchPublicIp 是模块级的），
    // 在这里取消会把 pingCache.handle 永久留在「在飞」状态 —— 之后每次调用都排进 waiters，
    // 谁也不会被叫醒，延迟就永远是 null（2026-10-29 真机踩过：面板上延迟一直显示 —）。
    abort: function () { aborted = true; }
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    // 纯函数
    parsePing: parsePing,
    parseIfaces: parseIfaces,
    readLinkState: readLinkState,
    parsePublicIp: parsePublicIp,
    publicIpRequest: publicIpRequest,
    // 异步
    probePing: probePing,
    pingCached: pingCached,
    fetchPublicIp: fetchPublicIp,
    collectAsync: collectAsync,
    // 常量（改目标 / 改缓存时长就改这里）
    DEFAULT_PING_HOST: DEFAULT_PING_HOST,
    DEFAULT_PUBLIC_IP_URL: PUBLIC_IP_URL,
    PING_CACHE_MS: PING_CACHE_MS,
    PUBLIC_IP_CACHE_MS: PUBLIC_IP_CACHE_MS,
    FAIL_BACKOFF_MS: FAIL_BACKOFF_MS
  };
}
