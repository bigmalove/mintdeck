// lib/linux/tasks.js — 「任务」采集：下载（aria2 / qBittorrent）、容器（docker / podman）、systemd 失败单元。
//
// 规矩沿用 sysfs.js / netinfo.js：读数只有「已知」或「不可用 + 原因」两种。
// 这里的「不可用」尤其容易写错：
//   · 没装 docker 不是「0 个容器」——前者是 null（UI 写「—」），后者是 {total:0,running:0,names:[]}（UI 写「0」）；
//   · 没有失败单元不是「systemctl 不存在」——前者是 []（真的空），后者是 null（命令跑不起来）；
//   · qBittorrent 的 eta 8640000 是它自己的「∞」哨兵，照实显示「100 天」就是编造。
//
// 三路互不阻塞，谁先回来谁先出一帧（onSample 可能被调多次）：
//   · downloads  —— Soup（aria2 JSON-RPC / qBittorrent 先登录拿 SID），缓存 5s；
//   · containers —— Exec.run(docker ps)，missing / 跑不动再退 podman，缓存 10s；
//   · failedUnits —— Exec.run(systemctl --user --failed)，缓存 60s。
// 每一路同一时刻只允许一条在飞：UI 一次刷新（多页签 / 重绘）不该把 aria2 打三遍。
// 失败后 60s 安静期：密码错、daemon 没起都是「一直错」的状态，每 5 秒重试一次没有新信息，只会刷服务端日志。
//
// lib/linux 允许碰 GI，但一律惰性取（只有 gi()/soup()/execModule() 里才摸 imports）：
// node 侧 require 本文件跑纯解析测试时不会 ReferenceError。
// 顶层只用 var / function：Cinnamon 的 imports 加载器对顶层块级声明不如 function 稳（同 netinfo.js）。
'use strict';

// Soup 版本必须在 import 之前钉死：Soup 3.0 才有 send_and_read_async，不写这句拿到的是 2.4 的 API。
// 多一个 imports.gi.versions 判断：node --test 单进程跑整个目录时，别的测试会把假 imports 留在全局上
// （stub 里只有 gi、没有 versions，照 netinfo.js 那样直接点 .Soup 会 TypeError，把整个测试进程带崩）。
if (typeof imports !== 'undefined' && imports.gi && imports.gi.versions) imports.gi.versions.Soup = '3.0';

// ---------------------------------------------------------------- 常量（都是「为什么是这个数」）

var DOWNLOAD_CACHE_MS = 5 * 1000;       // 下载速度是最会变的量，5s 够跟手，又不至于每次都发包
var CONTAINER_CACHE_MS = 10 * 1000;     // 一次 ps 要起进程，10s 对「有没有容器在跑」这个显示够用
var FAILED_CACHE_MS = 60 * 1000;        // 失败单元是低频事件：60s 一轮（成功时也当缓存期用）
var FAIL_BACKOFF_MS = 60 * 1000;        // 失败安静期：不形成重试风暴
var WATCHDOG_MS = 15 * 1000;            // 一路卡死的兜底（Exec 被 cancelAll 时回调是静默丢弃的）

var HTTP_TIMEOUT_SEC = 3;               // 本机回环上的 aria2 / qBittorrent 没有理由比 3 秒还慢
var MAX_RESPONSE_BYTES = 256 * 1024;    // torrents/info 几千条也就几十 KB；超过这个数说明对面不对劲

var MAX_CONTAINER_NAMES = 5;            // 面板一行放得下的名字数，明细留给悬停/子页
var QBT_ETA_INF = 8640000;              // qBittorrent 用 8640000（100 天）表示「∞」
var DEFAULT_ARIA2_URL = 'http://127.0.0.1:6800/jsonrpc';
var DEFAULT_QBT_URL = 'http://127.0.0.1:8080';
var UA = 'MintDeck';

// 子进程一律 argv 形式（argv[0] 由 Exec.run 走 PATH 解析，不经 shell）：容器名/镜像名里带空格或分号也不会被拆开。
// 分隔符用真正的制表符，不依赖 docker/podman 对模板里 \t 的转义处理；解析端两种都接（见 parseDockerPs）。
var DOCKER_ARGV = ['docker', 'ps', '-a', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}'];
var PODMAN_ARGV = ['podman', 'ps', '-a', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}'];
// --plain 让输出固定为 UNIT LOAD ACTIVE SUB DESCRIPTION 五列（不带树形缩进），
// --no-legend 去掉表头与 "N loaded units listed" 尾巴，--failed 只要失败的。
var SYSTEMD_ARGV = ['systemctl', '--user', '--failed', '--no-legend', '--plain'];

// qBittorrent 的「下载中」家族：只有这些状态算在跑。
// pausedDL / stoppedDL 名字里也带 DL，但它们不在下载 —— 漏了这条，暂停的种子会被面板报成「下载中」。
var QBT_ACTIVE_STATES = ['downloading', 'forceddl', 'metadl', 'stalleddl', 'queueddl', 'checkingdl'];

// ---------------------------------------------------------------- GI 惰性句柄

function gi() {
  if (typeof imports === 'undefined' || !imports.gi) return null;
  return imports.gi;
}

function soup() {
  var g = gi();
  return g && g.Soup ? g.Soup : null;
}

// GLib 只用来装看门狗 timeout。
function gLib() {
  var g = gi();
  return g && g.GLib ? g.GLib : null;
}

// 子进程统一走 lib/linux/exec（异步、argv、missing 时给 code:'missing'）。
// node 侧 / 极早期启动取不到 → null，由调用方按「不可用」处理，一句也不抛。
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

function bytesFromString(text) {
  var GLib = gLib();
  if (!GLib || !GLib.Bytes) return null;
  try {
    if (typeof TextEncoder !== 'undefined') return GLib.Bytes.new(new TextEncoder().encode(text));
  } catch (e) { /* 退到下面按字符串交给 GLib */ }
  try {
    return GLib.Bytes.new(text);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- 小工具

function trimmed(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw).trim();
}

// aria2 的字段是字符串（"totalLength":"12345"），qBittorrent 的是数字，统一过一遍。
// 空串必须先拦：Number('') === 0，会把「没有这个字段」洗成 0 字节 —— 那就是编造。
function toNumber(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  var text = String(raw).trim();
  if (!text) return null;
  var v = Number(text);
  return isFinite(v) ? v : null;
}

// 字节数 / 速度 / eta 这类量：负数是上游在瞎报（-1 常被当「未知」用），一律 null，不夹成 0。
function nonNegative(raw) {
  var v = toNumber(raw);
  if (v === null || v < 0) return null;
  return v;
}

function firstNumber(a, b) {
  var v = nonNegative(a);
  return v !== null ? v : nonNegative(b);
}

// 百分比夹到 0–100 并保留一位：aria2 的 completedLength 偶尔会略超 totalLength（边写边报），
// 不夹会画出 103% 的进度条；保留一位是为了相邻两个任务不要被四舍五入成同一个数。
function clampPercent(value) {
  if (value === null || value === undefined || !isFinite(value)) return null;
  var v = value < 0 ? 0 : value > 100 ? 100 : value;
  return Math.round(v * 10) / 10;
}

// 文件路径取 basename：aria2 的 files[].path 是绝对路径，直接进 UI 会撑爆一行。
function basenameOf(path) {
  var s = trimmed(path).replace(/[\\/]+$/, '');   // 目录形式的 path 以 / 结尾
  if (!s) return '';
  var cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return cut >= 0 ? s.slice(cut + 1) : s;
}

function parseJson(text) {
  if (text === null || text === undefined) return null;
  var src = String(text).trim();
  if (!src) return null;
  var head = src.charAt(0);
  if (head !== '{' && head !== '[') return null;   // "Ok." / "Fails." 之类根本不是 JSON
  try {
    return JSON.parse(src);
  } catch (e) {
    return null;    // 半截 JSON（连接中途断了）：宁可 null 也不拿半截数据当完整结果
  }
}

// ---------------------------------------------------------------- 纯解析：aria2

function aria2Name(entry, gid) {
  var files = entry.files;
  if (Array.isArray(files)) {
    for (var i = 0; i < files.length; i++) {
      var path = files[i] && files[i].path !== undefined ? basenameOf(files[i].path) : '';
      if (path) return path;
    }
  }
  // 拿不到文件名（元数据下载、纯 magnet）就退回 gid：gid 是事实，编个名字才是骗人
  return gid;
}

/**
 * 把一条 aria2 任务（tellActive / tellStatus 的元素）规整成面板要的形状。
 * @param {*} entry
 * @returns {{gid:string, name:string, percent:(number|null), downBytesPerSec:(number|null), etaSec:(number|null)}|null}
 */
function aria2Item(entry) {
  if (!entry || typeof entry !== 'object') return null;
  var gid = trimmed(entry.gid);
  if (!gid) return null;              // 没有 gid 的行既不能定位也不能去重，直接丢

  var total = nonNegative(entry.totalLength);
  var completed = nonNegative(entry.completedLength);
  var percent = null;
  if (total !== null && completed !== null && total > 0) {
    percent = clampPercent((completed / total) * 100);
  }
  var speed = nonNegative(entry.downloadSpeed);

  // tellActive 不带 eta，只有速度与剩余量：能算就自己算（从已知量推的，不是猜）。
  // 速度为 0 时算不出（remain/0），给 null，UI 显示「—」而不是「∞」。
  var eta = nonNegative(entry.eta);
  if (eta === null && speed !== null && speed > 0 && total !== null && completed !== null) {
    var remain = total - completed;
    eta = remain > 0 ? Math.ceil(remain / speed) : 0;
  }

  return { gid: gid, name: aria2Name(entry, gid), percent: percent, downBytesPerSec: speed, etaSec: eta };
}

// 活跃任务的聚合速度：每一项都知道才算得出来；一条都没有时是 0（确实没在下东西）。
function aggregateSpeed(items) {
  if (!items.length) return 0;
  var sum = 0;
  var seen = false;
  for (var i = 0; i < items.length; i++) {
    if (items[i].downBytesPerSec === null) continue;
    sum += items[i].downBytesPerSec;
    seen = true;
  }
  return seen ? sum : null;
}

/**
 * aria2 JSON-RPC 的结果 → 下载快照。
 * 两种入参形状都收：
 *   · 归一化后的 {"result":{"numActive":..,"numStopped":..,"numWaiting":..,"downloadSpeed":..,"active":[..]}}；
 *   · 裸 tellActive 的 {"result":[..]} —— 这种响应里没有任何计数，stopped 只能是 null
 *     （不拿 0 冒充「没有已停止任务」：UI 上「0 个已停」是断言，不是默认值）。
 * {"result":[]} 是「真的没有活跃任务」（给 {active:[], total:0, ...}）；坏 JSON / 带 error 的响应才是 null。
 * @param {string} jsonText
 * @returns {{active:Array, stopped:(number|null), total:(number|null), speedBytesPerSec:(number|null)}|null}
 */
function parseAria2(jsonText) {
  var data = parseJson(jsonText);
  if (data === null) return null;
  return aria2FromPayload(data);
}

function aria2FromPayload(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.error) return null;        // {"error":{"code":1,"message":"Unauthorized"}}：secret 不对，这条通道不可用

  var root = data.result === undefined ? data : data.result;
  var list = null;
  var counts = null;
  if (Array.isArray(root)) {
    list = root;
  } else if (root && typeof root === 'object') {
    counts = root;
    if (Array.isArray(root.active)) list = root.active;
  }
  if (!list) return null;             // 形状不认识：宁可 null 也不猜

  var active = [];
  for (var i = 0; i < list.length; i++) {
    var item = aria2Item(list[i]);
    if (item) active.push(item);
  }

  var numActive = null;
  var numWaiting = null;
  var numStopped = null;
  var speed = null;
  if (counts) {
    // 计数可能平铺在 result 上（本模块归一化后的形状），也可能被封装包在 stats / globalStat 里
    var stats = counts.stats && typeof counts.stats === 'object' ? counts.stats : counts;
    if (stats.globalStat && typeof stats.globalStat === 'object') stats = stats.globalStat;
    numActive = nonNegative(stats.numActive);
    numWaiting = nonNegative(stats.numWaiting);
    numStopped = firstNumber(stats.numStopped, counts.numStoppedTotal);
    speed = firstNumber(counts.downloadSpeed, stats.downloadSpeed);
  }

  var activeCount = numActive !== null ? numActive : active.length;
  var waiting = numWaiting !== null ? numWaiting : 0;
  var stopped = numStopped;           // 没有计数就是 null（不知道），不是 0
  var total = stopped !== null ? activeCount + waiting + stopped : activeCount + waiting;
  if (speed === null) speed = aggregateSpeed(active);

  return { active: active, stopped: stopped, total: total, speedBytesPerSec: speed };
}

// ---------------------------------------------------------------- 纯解析：qBittorrent

function qbitItem(torrent) {
  var name = trimmed(torrent.name);
  var hash = trimmed(torrent.hash);
  if (!name && !hash) return null;    // 既没名字也没 hash 的行在 UI 里无法定位，丢掉
  // progress 是 0–1 的浮点；负数（老版本用它表示未知）给 null，不画成 0%
  var progress = toNumber(torrent.progress);
  var percent = progress !== null && progress >= 0 ? clampPercent(progress * 100) : null;
  var eta = nonNegative(torrent.eta);
  if (eta !== null && eta >= QBT_ETA_INF) eta = null;   // 8640000 = ∞：显示「100 天」是假信息
  return {
    // gid 优先用 hash（qBittorrent 任务的真实身份）；没有 hash 才退 name，别让 UI 拿到空 key
    gid: hash || name,
    name: name || hash,
    percent: percent,
    downBytesPerSec: nonNegative(torrent.dlspeed),
    etaSec: eta
  };
}

function qbitIsActive(torrent, item) {
  var state = trimmed(torrent.state).toLowerCase();
  if (state) return QBT_ACTIVE_STATES.indexOf(state) >= 0;
  // 精简响应里没有 state：退回「现在真有下行速度」这个事实
  return item.downBytesPerSec !== null && item.downBytesPerSec > 0;
}

/**
 * `/api/v2/torrents/info` 的数组 → 下载快照（同一形状）。
 * /torrents/info 默认给**全部**种子，所以 total 就是数组长度，active 只留下载中的那些，
 * stopped = 其余（已暂停 / 已完成 / 排队 / 做种）—— 这是从列表本身推出来的，不是另配的计数。
 * 空数组是「真的没有种子」（{active:[],stopped:0,total:0,speedBytesPerSec:0}）；
 * 不是数组（登录失败时文本 "Fails." / 带 error 的对象）才是 null。
 * @param {string} jsonText
 * @returns {{active:Array, stopped:number, total:number, speedBytesPerSec:(number|null)}|null}
 */
function parseQbittorrent(jsonText) {
  var data = parseJson(jsonText);
  if (data === null) return null;
  if (!Array.isArray(data)) return null;

  var active = [];
  var total = data.length;            // 坏行也算一条任务：总数不该因为解析不出名字就变小
  var speedSum = 0;
  var speedSeen = false;
  for (var i = 0; i < data.length; i++) {
    var torrent = data[i];
    if (!torrent || typeof torrent !== 'object') continue;
    var item = qbitItem(torrent);
    var speed = nonNegative(torrent.dlspeed);
    if (speed !== null) { speedSum += speed; speedSeen = true; }
    if (item && qbitIsActive(torrent, item)) active.push(item);
  }

  return {
    active: active,
    stopped: Math.max(0, total - active.length),
    total: total,
    // 一条 dlspeed 都没有（字段缺失）→ null，不拿 0 冒充「速度为 0」
    speedBytesPerSec: speedSeen ? speedSum : (total ? null : 0)
  };
}

// ---------------------------------------------------------------- 纯解析：docker / podman

/**
 * `docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}'` 的 stdout（podman 同）。
 * 坑：
 *   · CRLF：经 ssh / 脚本转一手后每行可能带 \r，不剥掉 state 就永远不等于 'running'；
 *   · 有的版本把模板里的 \t 原样打出来（字面反斜杠+t），所以先把 "\\t" 归一成制表符再切；
 *   · .State 是 created / running / paused / exited / stopped / unknown，只有 running 算在跑 ——
 *     paused 是活着但不干活，报进 running 会让面板说「3 个在跑」而实际只有一个在服务。
 * 空输出 = 工具在、但没有容器（真的空，[]），不是不可用；不可用由调用方给 null。
 * @param {string} text
 * @returns {{id:string, name:string, image:string, state:string, running:boolean}[]}
 */
function parseDockerPs(text) {
  var out = [];
  if (text === null || text === undefined) return out;
  var rows = String(text).split('\n');
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i].replace(/\r/g, '').replace(/\\t/g, '\t').trim();
    if (!row) continue;
    var fields = row.indexOf('\t') >= 0 ? row.split('\t') : row.split(/\s{2,}/);
    if (fields.length < 2) continue;   // 单列行不是这个格式的输出（比如报错信息）：不猜
    var id = trimmed(fields[0]);
    if (!id) continue;
    var state = fields.length > 3 ? trimmed(fields[3]) : '';
    out.push({
      id: id,
      name: fields.length > 1 ? trimmed(fields[1]) : '',
      image: fields.length > 2 ? trimmed(fields[2]) : '',
      state: state,
      running: state.toLowerCase() === 'running'
    });
  }
  return out;
}

// ---------------------------------------------------------------- 纯解析：systemd

/**
 * `systemctl --user --failed --no-legend --plain` 的 stdout。
 * --plain 下每行是 UNIT LOAD ACTIVE SUB DESCRIPTION（"foo.service loaded failed failed ..."）：
 * ACTIVE 列（第 3 列）才是状态，DESCRIPTION 里可能有空格，所以只取前三列。
 * 空输出 = 「一个失败单元都没有」（[]，这是真的空）；命令本身不可用由调用方给 null（见 fetchFailedUnits）。
 * @param {string} text
 * @returns {{unit:string, active:(string|null)}[]}
 */
function parseFailedUnits(text) {
  var out = [];
  if (text === null || text === undefined) return out;
  var rows = String(text).split('\n');
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i].replace(/\r/g, '').trim();
    if (!row) continue;
    if (row.charAt(0) === '●') row = row.slice(1).trim();   // 非 --plain 时的项目符号
    var fields = row.split(/\s+/);
    var unit = fields[0];
    if (!unit) continue;
    if (/^[A-Z]+$/.test(unit)) continue;                    // 表头 UNIT LOAD ACTIVE…（--no-legend 本不给，防御）
    out.push({ unit: unit, active: fields.length > 2 ? fields[2] : null });
  }
  return out;
}

// ---------------------------------------------------------------- Soup

/**
 * 发一条 HTTP 请求（GET / POST），把响应体按文本交出去。
 * 只用 Soup 3 的 send_and_read_async：它在 GLib 主循环里回调，不开线程、不阻塞 shell 主线程。
 * 超时交给 session.set_timeout(3)：超时后 libsoup 以 CANCELLED 结束，回调照常 settle。
 * @param {string} method
 * @param {string} url
 * @param {Object<string,string>|null} headers 其中 Content-Type 交给 set_request_body_from_bytes，不重复 append
 * @param {(string|null)} body POST 体；null = 无体
 * @param {function(Error|null, number, (string|null), string)} cb (err, status, text, setCookie)
 * @returns {{abort:function}|null} 句柄；同步失败（URL 非法 / 没有 Soup）返回 null
 */
function soupRequest(method, url, headers, body, cb) {
  var done = typeof cb === 'function' ? cb : noop;
  var Soup = soup();
  var GLib = gLib();
  if (!Soup || !GLib) {
    done(new Error('Soup/GLib 不可用'), 0, null, '');
    return null;
  }

  var session;
  var message;
  try {
    session = new Soup.Session();
    session.set_timeout(HTTP_TIMEOUT_SEC);
    message = Soup.Message.new(method, url);
    if (!message) throw new Error('URL 非法: ' + url);
    var reqHeaders = message.get_request_headers();
    reqHeaders.append('User-Agent', UA);
    var keys = Object.keys(headers || {});
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === 'content-type') continue;
      reqHeaders.append(keys[i], headers[keys[i]]);
    }
    if (body !== null && body !== undefined) {
      var bytes = bytesFromString(String(body));
      if (!bytes) throw new Error('请求体编码失败');
      var contentType = headers && headers['Content-Type'] ? String(headers['Content-Type']) : 'application/x-www-form-urlencoded';
      message.set_request_body_from_bytes(contentType, bytes);
    }
  } catch (e) {
    done(e, 0, null, '');
    return null;
  }

  var finished = false;
  var handle = {
    abort: function () {
      if (finished) return;
      finished = true;
      try { session.abort(); } catch (e) { /* 已经结束 */ }
    }
  };

  session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, function (sess, result) {
    if (finished) return;
    finished = true;

    var bytes = null;
    var error = null;
    try {
      bytes = sess.send_and_read_finish(result);
    } catch (e) {
      error = e;                       // 超时 / 连接被拒 / 取消都走这里
    }
    var status = 0;
    try { status = Number(message.get_status()); } catch (e) { status = 0; }
    var cookie = '';
    try {
      var responseHeaders = message.get_response_headers();
      // qBittorrent 只用一条 Set-Cookie（SID=…），取第一条就够；GSList 的遍历在 GJS 里不值得为它展开
      if (responseHeaders) cookie = trimmed(responseHeaders.get_one('set-cookie'));
    } catch (e) {
      cookie = '';
    }

    if (error) { done(error, status, null, cookie); return; }
    var text = '';
    try {
      var data = bytes ? bytes.get_data() : null;
      if (data && data.length > MAX_RESPONSE_BYTES) {
        done(new Error('响应过大'), status, null, cookie);
        return;
      }
      text = data ? decode(data) : '';
    } catch (e) {
      done(e, status, null, cookie);
      return;
    }
    done(null, status, text, cookie);
  });
  return handle;
}

// ---------------------------------------------------------------- 单飞 + 缓存

function makeLane() {
  return { at: 0, ok: false, sample: null, handle: null, waiters: [] };
}

function drainWaiters(list, value) {
  var pending = list.slice(0);
  list.length = 0;
  for (var i = 0; i < pending.length; i++) {
    try { pending[i](value); } catch (e) { /* 单个回调炸了不影响别人 */ }
  }
}

/**
 * 一路采集的统一外壳：缓存 + 单飞 + 失败安静期 + 看门狗。
 * - ttlMs 内成功的结果（含「真的空」）直接回放；
 * - 失败（null）在 failTtlMs 内不再重试，避免「密码错 / daemon 没起」被每 5 秒戳一次；
 * - 同一时刻只飞一条，后来的调用排进 waiters，等这一次结果，绝不打并发。
 * @param {object} lane makeLane() 的产物
 * @param {number} ttlMs 成功缓存期
 * @param {number} failTtlMs 失败安静期
 * @param {function(function(?object)): *} job 起请求，回调 settle(sample)
 * @param {function(?object)} cb
 * @returns {{cancel:function}|*|null} 在飞的句柄（缓存命中时为 null）
 */
function laneFetch(lane, ttlMs, failTtlMs, job, cb) {
  var done = typeof cb === 'function' ? cb : noop;
  var now = Date.now();

  if (lane.handle) {                        // 已经有一条在飞：排队，等它
    lane.waiters.push(done);
    return lane.handle;
  }
  if (lane.at) {
    var age = now - lane.at;
    if (age < (lane.ok ? ttlMs : failTtlMs)) {
      done(lane.sample);                    // 缓存命中，可能是 null（上一次就是不可用）
      return null;
    }
  }
  lane.waiters.push(done);

  var GLib = gLib();
  var finished = false;
  var watchdogId = 0;

  function settle(sample) {
    if (finished) return;
    finished = true;
    if (watchdogId && GLib) {
      try { GLib.source_remove(watchdogId); } catch (e) { /* 已经触发 */ }
      watchdogId = 0;
    }
    lane.handle = null;
    lane.at = Date.now();
    lane.ok = !!sample;                     // [] 是 truthy：失败单元「真的空」也要按成功缓存
    lane.sample = sample || null;
    drainWaiters(lane.waiters, lane.sample);
  }

  var handle = null;
  try {
    handle = job(settle);
  } catch (e) {
    handle = null;
  }
  if (finished) return null;                // job 同步回调了（没有 GI / URL 非法）：别把 handle 再挂回 lane

  lane.handle = handle || { cancel: noop };
  if (GLib) {
    // 看门狗：exec 层被 cancelAll（applet reload）时回调是**静默丢弃**的，不设看门狗这一路会永远停在「在飞」，
    // 之后每次 collect 都只是排进 waiters，谁也不会被叫醒（netinfo.js 2026-10-29 真机踩过的坑）。
    try {
      watchdogId = GLib.timeout_add(WATCHDOG_MS, function () {
        watchdogId = 0;
        settle(null);
        return false;
      });
    } catch (e) {
      watchdogId = 0;
    }
  }
  return lane.handle;
}

// 每一路一个 lane：aria2 与 qBittorrent 分开缓存，切换源时互不污染。
var downloadLanes = { aria2: makeLane(), qbittorrent: makeLane() };
var containerLane = makeLane();
var failedLane = makeLane();

// ---------------------------------------------------------------- 采集：下载

/**
 * aria2：system.multicall 把 tellActive + getGlobalStat 合成一次请求。
 * 为什么要 multicall：两次往返意味着两个在飞状态、两份超时、两个可能失败的点，
 * 而这两条数据本来就是同一瞬间的快照，分开取还会出现「速度与任务条数对不上」的一帧。
 */
function fetchAria2(cfg, done) {
  var url = trimmed(cfg && cfg.url) || DEFAULT_ARIA2_URL;
  var secret = trimmed(cfg && cfg.secret);
  var token = secret ? ['token:' + secret] : [];   // 有 secret 时参数前置 token:<secret>
  var payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 'mintdeck',
    method: 'system.multicall',
    params: [[
      { methodName: 'aria2.tellActive', params: token },
      { methodName: 'aria2.getGlobalStat', params: token }
    ]]
  });
  return soupRequest('POST', url, { 'Content-Type': 'application/json' }, payload, function (err, status, text) {
    if (err || !text || status >= 400) { done(null); return; }
    done(aria2FromMulticall(text));
  });
}

// system.multicall 的每一项都包一层数组：[ [ {active…} ], [ {globalStat…} ] ]
function aria2FromMulticall(text) {
  var data = parseJson(text);
  if (!data || data.error || !Array.isArray(data.result)) return null;
  var result = data.result;

  var active = null;
  if (result.length > 0 && Array.isArray(result[0])) {
    var first = result[0];
    active = Array.isArray(first[0]) ? first[0] : first;   // 有包装层就拆，没有就当前提
  }
  if (!Array.isArray(active)) return null;                 // 单项 faultCode（auth 失败）：整条通道不可用

  var stats = null;
  if (result.length > 1 && result[1]) {
    var second = Array.isArray(result[1]) ? result[1][0] : result[1];
    if (second && typeof second === 'object' && !Array.isArray(second)) stats = second;
  }

  return aria2FromPayload({
    result: {
      active: active,
      numActive: stats ? stats.numActive : null,
      numWaiting: stats ? stats.numWaiting : null,
      numStopped: stats ? stats.numStopped : null,
      numStoppedTotal: stats ? stats.numStoppedTotal : null,
      downloadSpeed: stats ? stats.downloadSpeed : null
    }
  });
}

function sidFromCookie(cookie) {
  var m = /(?:^|[;,\s])SID=([^;,\s]+)/.exec(String(cookie || ''));
  return m ? m[1] : '';
}

/**
 * qBittorrent：POST /api/v2/auth/login（form）拿 SID cookie，再 GET /api/v2/torrents/info。
 * 登录失败（403 / "Fails." / 没有 SID）就 null，交给 60s 安静期 —— 密码错是「一直错」，重试没有意义。
 * SID 只在这条链里用，存起来反而会过期：每次采集都重新登录，成本是两个回环请求。
 */
function fetchQBittorrent(cfg, done) {
  var base = (trimmed(cfg && cfg.url) || DEFAULT_QBT_URL).replace(/\/+$/, '');
  var user = cfg && cfg.user !== undefined ? String(cfg.user) : '';
  var pass = cfg && cfg.pass !== undefined ? String(cfg.pass) : '';
  var form = 'username=' + encodeURIComponent(user) + '&password=' + encodeURIComponent(pass);

  // 两步请求共用一条可 abort 的链：只要 abort 当前这一段，前一段结束就没什么可中止的
  var chain = { current: null };
  var handle = {
    abort: function () {
      if (chain.current && chain.current.abort) {
        try { chain.current.abort(); } catch (e) { /* 已经结束 */ }
      }
    }
  };

  chain.current = soupRequest('POST', base + '/api/v2/auth/login', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Referer': base
  }, form, function (err, status, text, cookie) {
    if (err || !text || status >= 400) { done(null); return; }
    // 4.x 成功返回 "Ok."，失败返回 "Fails."（老版本状态码仍是 200，所以必须看正文）
    if (String(text).trim().toLowerCase().indexOf('ok') !== 0) { done(null); return; }
    var sid = sidFromCookie(cookie);
    if (!sid) { done(null); return; }

    chain.current = soupRequest('GET', base + '/api/v2/torrents/info', {
      'Cookie': 'SID=' + sid,
      'Referer': base
    }, null, function (err2, status2, text2) {
      if (err2 || !text2 || status2 >= 400) { done(null); return; }
      done(parseQbittorrent(text2));
    });
  });
  return handle;
}

// ---------------------------------------------------------------- 采集：容器

function containerSample(items) {
  var running = 0;
  var ordered = [];
  var i;
  for (i = 0; i < items.length; i++) {
    if (items[i].running) { running++; ordered.push(items[i]); }
  }
  for (i = 0; i < items.length; i++) {
    if (!items[i].running) ordered.push(items[i]);   // 在跑的排前面：面板最想知道的是「谁在服务」
  }
  var names = [];
  for (i = 0; i < ordered.length && names.length < MAX_CONTAINER_NAMES; i++) {
    names.push(ordered[i].name || ordered[i].id);    // 没有名字就用 id，绝不空串
  }
  return { total: items.length, running: running, names: names };
}

/**
 * 容器：docker 优先，podman 兜底。
 * - code:'missing'（没装 docker）→ 试 podman；
 * - code:'failed'（docker 装了但 daemon 没起 / socket 没权限）→ 也试 podman：
 *   这种机器上 podman 往往才是能用的那个，只看第一个命令会把「其实有容器」报成不可用；
 * - 两个都不可用 → null（不是 0 个）。
 */
function fetchContainers(done) {
  var Exec = execModule();
  if (!Exec) { done(null); return null; }

  var current = null;   // 当前在飞的那一段（docker 或 podman），abort 只收这一段
  var handleRef = {
    abort: function () {
      try { if (current) current.cancel(); } catch (e) { /* 已经结束 */ }
    }
  };

  function tryPodman() {
    current = Exec.run(PODMAN_ARGV, function (stdout, code) {
      if (code === 'ok' && stdout !== null) {
        done(containerSample(parseDockerPs(stdout)));
        return;
      }
      done(null);       // 两个都不可用：null，不是 0 个
    });
  }

  current = Exec.run(DOCKER_ARGV, function (stdout, code) {
    if (code === 'ok' && stdout !== null) {
      done(containerSample(parseDockerPs(stdout)));   // 空输出 = 真的 0 个容器
      return;
    }
    tryPodman();
  });
  return handleRef;
}

// ---------------------------------------------------------------- 采集：systemd

/**
 * systemd 用户失败单元。
 * code:'missing'（没有 systemctl）→ null；非零退出（没有用户 session bus，常见于纯 tty / 容器里）→ null。
 * 命令成功但输出为空 → []：这是「一个失败单元都没有」，是事实，不能用 null 顶替。
 */
function fetchFailedUnits(done) {
  var Exec = execModule();
  if (!Exec) { done(null); return null; }
  return Exec.run(SYSTEMD_ARGV, function (stdout, code) {
    if (code !== 'ok' || stdout === null) { done(null); return; }
    done(parseFailedUnits(stdout));
  });
}

// ---------------------------------------------------------------- 组装

// 交付形状里 downloads 自己也带 source（同时顶层还有 downloadsSource）：
// 前者让只读 downloads 的调用方不必再拼字段，后者在「这一路不可用」时明确是 null。
// 缓存里存的是 parse 的原始结果，这里包一层新的对象，避免给共享缓存塞字段。
function addSource(sample, source) {
  return {
    active: sample.active,
    stopped: sample.stopped,
    total: sample.total,
    speedBytesPerSec: sample.speedBytesPerSec,
    source: source
  };
}

function httpCfg(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return { url: trimmed(raw.url), secret: trimmed(raw.secret), user: raw.user, pass: raw.pass };
}

/**
 * 一次「任务」采集：三路互不阻塞，谁先到先回。
 * onSample 会被调用 1–4 次，每次给一整个快照；还没到 / 不可用的字段是 null。
 * 一上来先出一帧全 null：没配置（opts 里一个源都没有）时 UI 也要能立刻显示「未配置」，
 * 不能等一个永远不来的回调。
 * @param {{aria2:(object|null), qbittorrent:(object|null), containers:(boolean|undefined)}} opts
 * @param {function({downloads:object|null, downloadsSource:string|null, containers:object|null, failedUnits:(Array|null)})} onSample
 * @returns {{abort:function}}
 */
function collectAsync(opts, onSample) {
  var cfg = opts && typeof opts === 'object' ? opts : {};
  var emit = typeof onSample === 'function' ? onSample : noop;

  var state = { downloads: null, downloadsSource: null, containers: null, failedUnits: null };
  var aborted = false;

  function publish() {
    if (aborted) return;
    try {
      emit({
        downloads: state.downloads,
        downloadsSource: state.downloadsSource,
        containers: state.containers,
        failedUnits: state.failedUnits
      });
    } catch (e) {
      // 回调里的异常不该把采集链带断（在 Cinnamon 里那就是一条查不到源头的 GLib 日志）
    }
  }

  publish();   // 首帧：全 null，UI 立刻有话可说

  // ---- 下载：aria2 优先，不通再试 qBittorrent（两个都配了说明用户两个都在用）
  var plan = [];
  var aria2 = httpCfg(cfg.aria2);
  var qbit = httpCfg(cfg.qbittorrent);
  if (aria2) plan.push({ source: 'aria2', cfg: aria2 });
  if (qbit) plan.push({ source: 'qbittorrent', cfg: qbit });

  var step = 0;
  function nextSource() {
    if (aborted || step >= plan.length) return;   // 都不通：state.downloads 保持 null，不额外发帧
    var entry = plan[step++];
    laneFetch(downloadLanes[entry.source], DOWNLOAD_CACHE_MS, FAIL_BACKOFF_MS, function (done) {
      return entry.source === 'aria2' ? fetchAria2(entry.cfg, done) : fetchQBittorrent(entry.cfg, done);
    }, function (sample) {
      if (aborted) return;
      if (sample) {
        state.downloads = addSource(sample, entry.source);
        state.downloadsSource = entry.source;
        publish();
        return;
      }
      nextSource();   // 这一条不可用 → 试下一个配置好的源
    });
  }
  nextSource();

  // ---- 容器：只有 opts.containers === true 才碰子进程（默认不查，免得白起进程）
  if (cfg.containers === true) {
    laneFetch(containerLane, CONTAINER_CACHE_MS, FAIL_BACKOFF_MS, fetchContainers, function (sample) {
      if (aborted) return;
      state.containers = sample || null;
      publish();
    });
  }

  // ---- systemd 失败单元：没有开关，失败单元本来就少，60s 一轮可以接受
  laneFetch(failedLane, FAILED_CACHE_MS, FAILED_CACHE_MS, fetchFailedUnits, function (sample) {
    if (aborted) return;
    state.failedUnits = sample || null;     // [] 是 truthy：真的空照样发
    publish();
  });

  return {
    // 只停止「再发布」，**不杀**在飞的请求：这些 lane 是模块级缓存、被所有 collector 共享，
    // 在这里取消会把 lane.handle 永久留在「在飞」，之后每次 collect 都只排队、谁也不叫醒（netinfo.js 的教训）。
    abort: function () { aborted = true; }
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    // 纯函数（测试重点）
    parseAria2: parseAria2,
    parseQbittorrent: parseQbittorrent,
    parseDockerPs: parseDockerPs,
    parseFailedUnits: parseFailedUnits,
    // 异步
    collectAsync: collectAsync,
    // 常量（改地址 / 改缓存时长就改这里）
    DEFAULT_ARIA2_URL: DEFAULT_ARIA2_URL,
    DEFAULT_QBT_URL: DEFAULT_QBT_URL,
    DOCKER_ARGV: DOCKER_ARGV,
    PODMAN_ARGV: PODMAN_ARGV,
    SYSTEMD_ARGV: SYSTEMD_ARGV,
    DOWNLOAD_CACHE_MS: DOWNLOAD_CACHE_MS,
    CONTAINER_CACHE_MS: CONTAINER_CACHE_MS,
    FAILED_CACHE_MS: FAILED_CACHE_MS,
    FAIL_BACKOFF_MS: FAIL_BACKOFF_MS
  };
}
