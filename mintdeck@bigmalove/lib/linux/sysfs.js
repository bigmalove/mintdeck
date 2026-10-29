// lib/linux/sysfs.js — 温度 / 风扇 / 磁盘用量的 sysfs + Gio 通道。
//
// 规矩沿用 sysmon.js（对应 BrimDeck.Core/SystemMonitor.cs:5-9）：读数只有「已知」或「不可用 + 原因」两种，
// 拿不到就给 null / 空结构，绝不编造 0。这条在这里尤其要紧：
//   · 0°C 是真相（冷库、刚上电、传感器贴在出风口），null 是「这台机器不报温度」，UI 上前者写 "0°C"、后者写 "—"；
//   · 0 rpm 是风扇真的停转（该报警），null 是「没有风扇传感器」——两者混了就等于骗人。
//
// lib/linux 允许碰 GI，但一律惰性取（只有 gi() 里才摸 imports.gi）：
// node 侧 require 本文件跑纯解析测试时不会 ReferenceError，下面那些 parse* 可以直接断死。
//
// Cinnamon 侧通过 imports.lib.linux.sysfs 取导出，而 GJS 的模块对象只暴露顶层 var / function
// （let/const 是块级声明，不会挂到模块上）。所以本文件顶层不用 let/const，只在函数体内部用。
'use strict';

// ---------------------------------------------------------------- 常量（都是「为什么是这个数」）

// sysfs 的毫摄氏度是驱动说了算的，驱动没初始化好会吐哨兵值：-127000 是 coretemp / 部分 acpitz 的经典无效值，
// 0x7fffffff（2147483647）也见过。处理方式是判「不可用」（null），不是夹到 0 / 100：
//   · 夹住 = 编造读数，直接违反上面的规矩；
//   · 照实返回 -127°C 又会被 UI 当成「机器冻住了」，同样是假信息。
// 所以两端各设一道门。150°C 而不是 120°C：120°C 是真会出现的过热读数（CPU 节流点 100–115），
// 照实放行才叫「已知」；150 以上只可能是坏传感器。
var TEMP_MIN_C = -60;
var TEMP_MAX_C = 150;

// fan1_input 单位 rpm。0 合法（停转是事实）；负数或十万转以上是寄存器没读到 / 驱动在瞎报。
var FAN_MAX_RPM = 100000;

// 面板一行放不下更多明细：thermal_zone + 一堆 coretemp 通道动辄十几条，
// 这里按「最热 / 最快」截前 N 条，明细本身就是给鼠标悬停看的。
var MAX_ZONES = 8;
var MAX_FANS = 8;

var THERMAL_DIR = '/sys/class/thermal';
var HWMON_DIR = '/sys/class/hwmon';
var DISK_ATTRS = 'filesystem::size,filesystem::used,filesystem::free';

// ---------------------------------------------------------------- GI 惰性句柄

function gi() {
  if (typeof imports === 'undefined' || !imports.gi) return null;
  return imports.gi;
}

function gLib() {
  var g = gi();
  return g && g.GLib ? g.GLib : null;
}

function gioModule() {
  var g = gi();
  return g && g.Gio ? g.Gio : null;
}

function decode(bytes) {
  if (bytes === null || bytes === undefined) return '';
  if (typeof bytes === 'string') return bytes;
  try {
    return new TextDecoder().decode(bytes);
  } catch (e) {
    return '';
  }
}

// 读文本文件；读不到返回 null。null 与 '' 必须分开：传感器文件不存在（没有 fan1_input / tempN_label）
// 和「文件在但内容空」是两种事，前者要跳过该条，后者按垃圾处理。
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

// ---------------------------------------------------------------- 纯解析（node 里可测）

// 只认十进制数字：sysfs 给的是 "46000\n"，而 "n/a"、"46000abc"、"0x7fffffff"、"1e5" 全是驱动/固件在瞎报。
// 走正则而不是 Number()，是因为 Number('0x10')=16、Number('1e5')=100000 会把垃圾洗成看起来正常的值。
var DECIMAL_RE = /^[-+]?(\d+(\.\d*)?|\.\d+)$/;

function milliToCelsius(raw) {
  if (raw === null || raw === undefined) return null;
  var text = String(raw).trim();          // 文件普遍以 '\n' 结尾，另有驱动给 '\r\n' / 前导空格
  if (!text) return null;
  if (!DECIMAL_RE.test(text)) return null;
  var celsius = Number(text) / 1000;
  if (!isFinite(celsius)) return null;
  if (celsius < TEMP_MIN_C || celsius > TEMP_MAX_C) return null;
  // 归一化 -0：JS 的 Number('-0')/1000 是 -0，JSON/字符串里会变成 "-0"，面板写出 "-0°C" 很难看。
  if (celsius === 0) celsius = 0;
  // 半度要留着（46500 → 46.5）：面板写 46.5°C 无害，而 Math.round 会把相邻两个 zone 抹成同一个数。
  return Math.round(celsius * 1000) / 1000;
}

/**
 * /sys/class/thermal/thermal_zoneN/temp 的内容（毫摄氏度，带换行）→ 摄氏数。
 * @param {?string} raw
 * @returns {number|null} null = 不可用（空、乱码、坏传感器哨兵值）
 */
function parseThermalZone(raw) {
  return milliToCelsius(raw);
}

/**
 * /sys/class/hwmon/hwmonN/tempK_input 的内容 → 摄氏数。
 * 与 parseThermalZone 单位相同（毫摄氏度），但留成独立函数：将来个别驱动改报微度时只动这一处，
 * 调用方（readThermal 的 hwmon 分支）不需要跟着改。
 * @param {?string} raw
 * @returns {number|null}
 */
function parseHwmonTemp(raw) {
  return milliToCelsius(raw);
}

/**
 * hwmon 的 fanN_input（或 /sys/class/thermal/cooling_deviceN/cur_state 之类纯整数通道）→ rpm 整数。
 * 小数与科学计数法按不可用处理：sysfs 风扇通道只会给整数，出现 "1200.5" 说明文件不是风扇。
 * @param {?string} raw
 * @returns {number|null}
 */
function parseFanRpm(raw) {
  if (raw === null || raw === undefined) return null;
  var text = String(raw).trim();
  if (!text) return null;
  if (!/^[-+]?\d+$/.test(text)) return null;
  var rpm = Number(text);
  if (!isFinite(rpm)) return null;
  if (rpm < 0 || rpm > FAN_MAX_RPM) return null;
  return rpm;
}

/**
 * label / type / name 文件的内容 → 一个能进 UI 的名字。
 * 优先用 label（厂商写的 "Composite"、"Package id 0"），没有就退回调用方给的兜底名。
 * 为什么要 strip 空白：见过带换行和多余空格的 label（"Package id 0\n"），原样进 UI 会撑高一行。
 * @param {?string} raw 文件内容（可能是 null：文件不存在）
 * @param {string=} fallback
 * @returns {string}
 */
function parseTempLabel(raw, fallback) {
  var fb = typeof fallback === 'string' ? fallback : '';
  if (raw === null || raw === undefined) return fb;
  var label = String(raw).replace(/\s+/g, ' ').trim();
  return label ? label : fb;
}

// ---------------------------------------------------------------- 目录枚举

// 名字里的序号（thermal_zone7 → 7、temp12_input → 12），用于稳定排序：
// sysfs 的 readdir 顺序不保证，而 UI 与测试都希望 zone 按 0,1,2… 出现。
function ordinal(name) {
  var m = /(\d+)/.exec(String(name));
  return m ? Number(m[1]) : 0;
}

function byOrdinal(a, b) {
  return ordinal(a) - ordinal(b);
}

/**
 * 列一个目录下名字以 prefix 开头的子项。
 * 目录不存在（没装 thermal / 没有 hwmon）或枚举失败时返回 []，不抛 —— 传感器是「有就报、没有就没有」的东西。
 * @param {*} Gio
 * @param {string} dir
 * @param {string} prefix
 * @returns {string[]}
 */
function listDirNames(Gio, dir, prefix) {
  var names = [];
  var en = null;
  try {
    en = Gio.File.new_for_path(dir).enumerate_children('standard::name', 0, null);
  } catch (e) {
    return names;
  }
  // 枚举器握着一个 dirfd，必须显式 close：GJS 靠 GC 回收，等 GC 时这些 fd 全开着。
  // 一次刷新要枚举 thermal + 每个 hwmon，刷几十次就把 cinnamon 的 1024 上限吃光，
  // 进程直接 abort（见 sysmon.js listFiles 处 2026-10-29 的真机崩溃记录）—— 所以 close 放 finally，
  // next_file 抛异常也要关。
  try {
    try {
      while (true) {
        var entry = en.next_file(null);
        if (entry === null) break;
        var name = '';
        try { name = entry.get_name(); } catch (e) { continue; }
        if (!name) continue;
        if (prefix && name.indexOf(prefix) !== 0) continue;
        names.push(name);
      }
    } catch (e) {
      // 枚举中途出错（驱动热插拔、设备被拔走）不该让一次刷新整块崩掉：
      // 已经读到的名字仍然有效，缺的那几个按「不可用」处理。fd 照样在 finally 里关掉。
    }
  } finally {
    try { en.close(null); } catch (e) { /* 已经关了也无所谓 */ }
  }
  names.sort(byOrdinal);
  return names;
}

// ---------------------------------------------------------------- 温度

// thermal_zone 优先：它才是内核统一的温标（acpitz / x86_pkg_temp / iwlwifi）。
// 用 zone 的 type 文件（"x86_pkg_temp"）而不是目录名（"thermal_zone3"）：前者能直接说明是哪个探头，
// 后者对用户零信息量；type 读不到才退回目录名。
function readThermalZones(Gio) {
  var zones = [];
  var names = listDirNames(Gio, THERMAL_DIR, 'thermal_zone');
  for (var i = 0; i < names.length; i++) {
    var dir = THERMAL_DIR + '/' + names[i];
    var celsius = parseThermalZone(readTextOrNull(dir + '/temp'));
    if (celsius === null) continue;   // 单个 zone 读不到（驱动没注册好）：跳过，不拿 0 顶替
    zones.push({ name: parseTempLabel(readTextOrNull(dir + '/type'), names[i]), celsius: celsius });
  }
  return zones;
}

// hwmon 是兜底：没有 thermal_zone 的机器（老内核、部分 ARM 板）温度只在这里。
// 名字取 tempN_label，没有 label 就拼 "hwmon名/tempN" —— 裸 "temp1" 会在多块 hwmon 之间重名。
function readHwmonTemps(Gio) {
  var zones = [];
  var dirs = listDirNames(Gio, HWMON_DIR, 'hwmon');
  for (var i = 0; i < dirs.length; i++) {
    var dir = HWMON_DIR + '/' + dirs[i];
    var hwName = parseTempLabel(readTextOrNull(dir + '/name'), dirs[i]);
    var files = listDirNames(Gio, dir, 'temp');
    for (var k = 0; k < files.length; k++) {
      var m = /^temp(\d+)_input$/.exec(files[k]);
      if (!m) continue;                       // tempN_label / tempN_crit 之类不是读数
      var channel = m[1];
      var celsius = parseHwmonTemp(readTextOrNull(dir + '/' + files[k]));
      if (celsius === null) continue;
      var label = parseTempLabel(readTextOrNull(dir + '/temp' + channel + '_label'), '');
      zones.push({ name: label || (hwName + '/temp' + channel), celsius: celsius });
    }
  }
  return zones;
}

// 按温度降序取前 N 条（面板只展示最热的几个探头）。
function hottest(items, limit) {
  var copy = items.slice();
  copy.sort(function (a, b) { return b.celsius - a.celsius; });
  return copy.slice(0, limit);
}

/**
 * 整机温度。
 * source 语义：'thermal' = 内核温标读数；'hwmon' = 没有 thermal zone，退回 hwmon；
 * null = 这台机器一个温度通道都没有（虚拟机、容器、黑名单驱动），此时 celsius 也是 null。
 * @returns {{celsius:number|null, source:(string|null), zones:{name:string, celsius:number}[]}}
 */
function readThermal() {
  var Gio = gioModule();
  if (!Gio) return { celsius: null, source: null, zones: [] };

  var zones = readThermalZones(Gio);
  var source = 'thermal';
  if (!zones.length) {
    zones = readHwmonTemps(Gio);
    // thermal_zone 与 hwmon 会重复报同一个探头（coretemp 两边都注册），只取一路，避免最大值被同一个探头刷两遍。
    if (zones.length) source = 'hwmon';
    else return { celsius: null, source: null, zones: [] };
  }
  var celsius = zones[0].celsius;
  for (var i = 1; i < zones.length; i++) if (zones[i].celsius > celsius) celsius = zones[i].celsius;
  return { celsius: celsius, source: source, zones: hottest(zones, MAX_ZONES) };
}

// ---------------------------------------------------------------- 风扇

/**
 * 风扇转速。rpm 取所有 fan*_input 的最大值（多风扇机器上「有没有风在吹」看最大的那个）：
 * 一台机器只要有一个风扇在转就说明散热在工作，平均值会被停转的副风扇拖成误导性的低数。
 * @returns {{rpm:number|null, fans:{name: string, rpm: number}[]}}
 */
function readFan() {
  var Gio = gioModule();
  if (!Gio) return { rpm: null, fans: [] };
  var fans = [];
  var dirs = listDirNames(Gio, HWMON_DIR, 'hwmon');
  for (var i = 0; i < dirs.length; i++) {
    var dir = HWMON_DIR + '/' + dirs[i];
    var hwName = parseTempLabel(readTextOrNull(dir + '/name'), dirs[i]);
    var files = listDirNames(Gio, dir, 'fan');
    for (var k = 0; k < files.length; k++) {
      var m = /^fan(\d+)_input$/.exec(files[k]);
      if (!m) continue;
      var channel = m[1];
      var rpm = parseFanRpm(readTextOrNull(dir + '/' + files[k]));
      if (rpm === null) continue;
      var label = parseTempLabel(readTextOrNull(dir + '/fan' + channel + '_label'), '');
      fans.push({ name: label || (hwName + '/fan' + channel), rpm: rpm });
    }
  }
  if (!fans.length) return { rpm: null, fans: [] };
  var max = fans[0].rpm;
  for (var j = 1; j < fans.length; j++) if (fans[j].rpm > max) max = fans[j].rpm;
  fans.sort(function (a, b) { return b.rpm - a.rpm; });
  return { rpm: max, fans: fans.slice(0, MAX_FANS) };
}

// ---------------------------------------------------------------- 磁盘用量（Gio）

function clampPct(value) {
  if (!isFinite(value)) return 0;
  return value < 0 ? 0 : value > 100 ? 100 : value;
}

// 属性可能不存在（btrfs / overlay / fuse 只给一部分）：has_attribute 先探，缺哪个就整条跳过，
// 不拿 0 凑数 —— 0 字节可用空间会让 UI 弹出假的「磁盘已满」。
function attrBytes(info, name) {
  try {
    if (typeof info.has_attribute === 'function' && !info.has_attribute(name)) return null;
    var value = info.get_attribute_uint64(name);
    return isFinite(value) ? Number(value) : null;
  } catch (e) {
    return null;
  }
}

/**
 * 各挂载点的容量。
 * percent 用 used/size 而不是 (size-free)/size：btrfs 的 free 把未分配空间也算进去，
 * 用 used 才和 df 的 Use% 对得上；夹到 0..100，因为 quota / overlay 场景下 used 偶尔会略超 size。
 * @param {string[]=} paths 默认 ['/']
 * @returns {{mount:string, totalBytes:number, usedBytes:number, freeBytes:number, percent:number}[]}
 */
function diskUsage(paths) {
  var Gio = gioModule();
  if (!Gio || !Gio.File) return [];
  var list = Array.isArray(paths) && paths.length ? paths : ['/'];
  var out = [];
  try {
    for (var i = 0; i < list.length; i++) {
      var mount = String(list[i] === undefined || list[i] === null ? '/' : list[i]);
      // 同一路径传两次（比如 ['/', '/']）不该出两行重复卡片
      var dup = false;
      for (var d = 0; d < out.length; d++) if (out[d].mount === mount) { dup = true; break; }
      if (dup) continue;
      try {
        var info = Gio.File.new_for_path(mount).query_filesystem_info(DISK_ATTRS, null);
        if (!info) continue;
        var total = attrBytes(info, 'filesystem::size');
        var used = attrBytes(info, 'filesystem::used');
        var free = attrBytes(info, 'filesystem::free');
        // 任一项缺失，或 size 为 0（/proc、sysfs、tmpfs 这类没有容量概念的文件系统）→ 整条跳过
        if (total === null || used === null || free === null || total <= 0) continue;
        out.push({
          mount: mount,
          totalBytes: total,
          usedBytes: used,
          freeBytes: free,
          percent: clampPct((used / total) * 100)
        });
      } catch (e) {
        continue;   // 单个路径炸了（不存在、权限、NFS 超时）不拖累其它条目
      }
    }
  } catch (e) {
    return [];      // 整块失败（Gio 本身坏了）：给空数组让上层走「不可用」，别把半截数据当完整结果
  }
  return out;
}

// ---------------------------------------------------------------- 汇总

/**
 * 一次采集：磁盘 + 温度 + 风扇。
 * 任一块不可用都只影响自己那一项（disks [] / celsius null / rpm null），不影响其它字段。
 * @param {string[]=} paths 磁盘查询路径，默认 ['/']
 * @returns {{disks:Array, thermal:object, fan:object}}
 */
function collect(paths) {
  var list = Array.isArray(paths) && paths.length ? paths : ['/'];
  return { disks: diskUsage(list), thermal: readThermal(), fan: readFan() };
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseThermalZone: parseThermalZone,
    parseHwmonTemp: parseHwmonTemp,
    parseFanRpm: parseFanRpm,
    parseTempLabel: parseTempLabel,
    diskUsage: diskUsage,
    readThermal: readThermal,
    readFan: readFan,
    collect: collect
  };
}
