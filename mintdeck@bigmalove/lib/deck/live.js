// lib/deck/live.js —— 两个「活」数据源：音乐（MPRIS）与系统监控（procfs）
//
// 为什么单独一层：它们都是定时器驱动的，且都能独立失败（没播放器、没 nvidia-smi）。
// applet.js 只负责 start/stop，不关心细节。
'use strict';

const GLib = imports.gi.GLib;

const Mpris = imports.lib.linux.mpris;
const Sysmon = imports.lib.linux.sysmon;
const Lyrics = imports.lib.linux.lyrics;
const Netinfo = imports.lib.linux.netinfo;
const Sysfs = imports.lib.linux.sysfs;

// 这三块是「可选数据源」：模块文件缺失或某个依赖没装时，宁可整块关掉，也不能让整个 applet 起不来。
let Calendar = null;
try { Calendar = imports.lib.linux.calendar; } catch (e) { Calendar = null; }
let Weather = null;
try { Weather = imports.lib.linux.weather; } catch (e) { Weather = null; }
let Tasks = null;
try { Tasks = imports.lib.linux.tasks; } catch (e) { Tasks = null; }

// ---------------------------------------------------------------- 音乐

function startMusic(applet, onChange) {
    let proxy = null;
    let playerName = null;
    let lastTrackKey = '';
    let lyricLines = null;
    let lyricIndex = -1;
    let positionUs = 0;
    let positionAt = 0;       // 拿 position 的墙钟时间（毫秒），用于本地插值
    let sourceCancel = null;
    let tickId = 0;

    const publish = () => {
        if (!proxy) { onChange(null); return; }
        let s;
        try { s = Mpris.state(proxy); } catch (e) { s = null; }
        if (!s || !s.title) { onChange(null); return; }

        // Position 不随 PropertiesChanged 推送（实测 3s 内 0 次），本地按时间插值
        const elapsedUs = s.status === 'Playing' ? (Date.now() - positionAt) * 1000 : 0;
        const nowUs = Math.min(s.lengthUs || Infinity, positionUs + elapsedUs);

        const key = s.title + '|' + s.artist + '|' + (s.lengthUs || 0);
        if (key !== lastTrackKey) {
            lastTrackKey = key;
            lyricLines = null;
            lyricIndex = -1;
            loadLyrics(s);
        }
        if (lyricLines && lyricLines.length) {
            lyricIndex = lyricIndexFor(lyricLines, nowUs / 1000);
        }

        onChange({
            title: s.title,
            artist: s.artist,
            album: s.album,
            // 播放态给布尔值，别给中文文案：UI 以前拿 '播放中' 做字符串比较，一换语言就失效
            playing: s.status === 'Playing',
            status: s.status,
            positionUs: nowUs,
            lengthUs: s.lengthUs,
            artUrl: s.artUrl,
            lyric: lyricIndex >= 0 ? lyricLines[lyricIndex].text : null,
            lyricLines: lyricLines,
            lyricIndex: lyricIndex,
            player: playerName
        });
    };

    const loadLyrics = (s) => {
        if (!s || !s.title) return;
        try {
            Lyrics.fetchRemote({
                title: s.title,
                artist: s.artist || '',
                album: s.album || '',
                durationSec: s.lengthUs ? Math.round(s.lengthUs / 1e6) : 0
            }, (err, lines) => {
                if (err || !lines || !lines.length) return;
                lyricLines = lines;
                publish();
            });
        } catch (e) { /* 没网就是没歌词，不影响播放信息 */ }
    };

    const pollPosition = () => {
        if (!proxy) return;
        try {
            const us = Mpris.getPosition(proxy);
            if (typeof us === 'number' && us >= 0) { positionUs = us; positionAt = Date.now(); }
        } catch (e) { /* ignore */ }
    };

    const attach = (name) => {
        if (!name) { proxy = null; playerName = null; onChange(null); return; }
        try {
            const conn = Mpris.attach(name);
            proxy = conn.proxy;
            playerName = conn.playerName || name;
            positionAt = Date.now();
            pollPosition();
            publish();
            // 属性变化（换歌/暂停）立即刷新，不必等下一拍
            proxy.connect('g-properties-changed', () => { pollPosition(); publish(); });
        } catch (e) {
            proxy = null; playerName = null; onChange(null);
        }
    };

    const pick = () => {
        let players = [];
        try { players = Mpris.listPlayers() || []; } catch (e) { players = []; }
        if (players.length === 0) { attach(null); return; }
        // 优先选正在播放的那个
        let chosen = players[0];
        for (const p of players) {
            try {
                const c = Mpris.attach(p);
                const st = Mpris.state(c.proxy);
                if (st && st.status === 'Playing') { chosen = p; break; }
            } catch (e) { /* 这个播放器不响应 */ }
        }
        attach(chosen);
    };

    try { sourceCancel = Mpris.watch((name, appeared) => { pick(); }); } catch (e) { sourceCancel = null; }

    pick();
    tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        pollPosition();
        publish();
        return true;
    });

    const stop = function () {
        if (tickId) { GLib.source_remove(tickId); tickId = 0; }
        if (sourceCancel) { try { sourceCancel(); } catch (e) { } sourceCancel = null; }
        proxy = null;
    };
    stop.playPause = () => { try { if (proxy) Mpris.playPause(proxy); } catch (e) { } };
    stop.next = () => { try { if (proxy) Mpris.next(proxy); } catch (e) { } };
    stop.previous = () => { try { if (proxy) Mpris.previous(proxy); } catch (e) { } };
    return stop;
}

function lyricIndexFor(lines, seconds) {
    const ms = seconds * 1000;
    let lo = 0, hi = lines.length - 1, found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].timeMs <= ms) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return found;
}

// ---------------------------------------------------------------- 系统监控

function startMonitor(applet, onChange) {
    let prevCpu = '';
    let prevNet = null;
    let prevNetAt = 0;
    let memPercent = null;
    let gpu = null;
    let topProcs = [];
    const iface = (() => {
        try {
            const text = Sysmon.readNetDevText();
            const picked = Sysmon.pickNetworkInterface(text);
            return picked || null;
        } catch (e) { return null; }
    })();

    let fastId = 0, slowId = 0;

    const sampleFast = () => {
        try {
            const cur = Sysmon.readCpuText();
            const cpu = Sysmon.sampleCpu(prevCpu, cur);
            prevCpu = cur;

            const netText = Sysmon.readNetDevText();
            const net = Sysmon.parseNetDev(netText, iface ? [iface] : undefined);
            const now = GLib.get_monotonic_time() / 1000;
            let rxKbps = null, txKbps = null;
            if (prevNet && prevNetAt) {
                const dt = Math.max(0.2, (now - prevNetAt) / 1000);
                rxKbps = Math.max(0, (net.rxBytes - prevNet.rxBytes) / dt);
                txKbps = Math.max(0, (net.txBytes - prevNet.txBytes) / dt);
            }
            prevNet = net;
            prevNetAt = now;

            onChange({
                cpu: cpu.total,
                perCore: cpu.perCore,
                memPercent: memPercent,
                gpu: gpu,
                processes: topProcs,
                rxKbps: rxKbps === null ? null : fmtRate(rxKbps),
                txKbps: txKbps === null ? null : fmtRate(txKbps),
                iface: iface
            });
        } catch (e) { /* 单次失败保留上一帧 */ }
    };

    const sampleSlow = () => {
        try {
            const mem = Sysmon.parseMeminfo(Sysmon.readMeminfoText());
            memPercent = mem ? mem.usedPercent : memPercent;
        } catch (e) { }
        try {
            // 非阻塞：gpuText() 只回上一帧缓存，nvidia-smi 由它自己异步采样（见 sysmon.js refreshGpu）
            const g = Sysmon.gpuText();
            gpu = g && g.source !== 'none' && Number.isFinite(g.utilization) ? Math.round(g.utilization) + '%' : null;
        } catch (e) { }
        try {
            topProcs = (Sysmon.topProcesses(6) || []).map(p => ({ name: p.name, cpuPercent: p.cpuPercent }));
        } catch (e) { }
    };

    sampleSlow();
    sampleFast();
    fastId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => { sampleFast(); return true; });
    slowId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => { sampleSlow(); return true; });

    return function stop() {
        if (fastId) { GLib.source_remove(fastId); fastId = 0; }
        if (slowId) { GLib.source_remove(slowId); slowId = 0; }
        // 停监控时把还在跑的 nvidia-smi 收掉，别让旧实例的子进程赖着
        try { Sysmon.releaseGpu(); } catch (e) { }
    };
}

// ---------------------------------------------------------------- 网络质量

// 30 秒一轮：链路状态是同步读的，先出一帧；延迟（ping）与公网 IP 各自异步，回来再补帧。
// 两轮之间 UI 用上一帧顶着 —— 面板上最忌讳「每 30 秒闪成一片 —」。
function startNetQuality(onChange) {
    let last = { latency: null, publicIp: null, link: null };
    let handle = null;

    const refresh = () => {
        try {
            handle = Netinfo.collectAsync((sample) => {
                last = sample;
                try { onChange(sample); } catch (e) { /* 单个回调坏了不影响下一轮 */ }
            });
        } catch (e) { /* 采集层整个起不来 → 保持上一帧，由 UI 的「不可用」兜底 */ }
    };

    refresh();
    const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => { refresh(); return true; });
    return function stop() {
        if (id) GLib.source_remove(id);
        try { if (handle && handle.abort) handle.abort(); } catch (e) { }
    };
}

// ---------------------------------------------------------------- 系统详情（监控页第二屏）

// 磁盘（statvfs）/ 温度 / 风扇 / 频率。10 秒一轮就够：这些量变化慢，而面板一次只展开几秒。
// 频率跟监控页同源（Sysmon.frequencyMhz 只读 procfs，同步且便宜），这里借过来不另起采样。
function startSysinfo(onChange) {
    const paths = ['/', GLib.get_home_dir()];

    const sample = () => {
        let out = {
            disks: [],
            thermal: { celsius: null, source: null, zones: [] },
            fan: { rpm: null, fans: [] },
            freqMhz: null
        };
        try {
            const s = Sysfs.collect(paths);
            if (s) {
                out.disks = s.disks || [];
                out.thermal = s.thermal || out.thermal;
                out.fan = s.fan || out.fan;
            }
        } catch (e) { /* 整块不可用就保持空结构，UI 会显示 — 而不是 0 */ }
        try {
            // frequencyMhz() 回的是 { avgMhz, perCore }（sysmon.js:355），不是裸数字；
            // 这里取各核平均，UI 只显示一个「3.68 GHz」。
            const f = Sysmon.frequencyMhz();
            const mhz = f && Number.isFinite(f.avgMhz) ? f.avgMhz
                : (Number.isFinite(f) ? f : null);
            if (mhz && mhz > 0) out.freqMhz = mhz;
        } catch (e) { /* 频率读不到就是 null */ }
        try { onChange(out); } catch (e) { /* 回调坏了不影响下一轮 */ }
    };

    sample();
    const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => { sample(); return true; });
    return function stop() {
        if (id) GLib.source_remove(id);
    };
}

// ---------------------------------------------------------------- 日程 / 天气 / 任务

// 日程：5 分钟扫一次（日历文件不会秒级变化）。collectAsync 已经不抛，这里只负责定时与停表。
function startCalendar(onChange) {
    let handle = null;
    const refresh = () => {
        if (!Calendar || typeof Calendar.collectAsync !== 'function') { onChange(null); return; }
        try {
            handle = Calendar.collectAsync((result) => {
                try { onChange(result || null); } catch (e) { /* 回调坏了不影响下一轮 */ }
            });
        } catch (e) { onChange(null); }
    };
    refresh();
    const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 300, () => { refresh(); return true; });
    return function stop() {
        if (id) GLib.source_remove(id);
        try { if (handle && handle.abort) handle.abort(); } catch (e) { }
    };
}

// 天气：城市留空 = 不发请求（不猜经纬度）。10 分钟一次，模块内部还有 10 分钟缓存。
function startWeather(city, onChange) {
    if (!city || !Weather || typeof Weather.fetchWeather !== 'function') {
        onChange(null);
        return function stop() { };
    }
    let dead = false;
    const refresh = () => {
        try {
            Weather.fetchWeather(city, (w) => {
                if (dead) return;
                try { onChange(w || null); } catch (e) { }
            });
        } catch (e) { if (!dead) onChange(null); }
    };
    refresh();
    const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 600, () => { refresh(); return true; });
    return function stop() {
        dead = true;
        if (id) GLib.source_remove(id);
    };
}

// 任务：10 秒一次（下载进度要动）。opts 是函数，每次采样前现读设置，改配置立刻生效。
function startTasks(opts, onSample) {
    let handle = null;
    const refresh = () => {
        if (!Tasks || typeof Tasks.collectAsync !== 'function') { onSample(null); return; }
        let options = null;
        try { options = typeof opts === 'function' ? opts() : opts; } catch (e) { options = null; }
        try {
            handle = Tasks.collectAsync(options || {}, (sample) => {
                try { onSample(sample || null); } catch (e) { }
            });
        } catch (e) { onSample(null); }
    };
    refresh();
    const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => { refresh(); return true; });
    return function stop() {
        if (id) GLib.source_remove(id);
        try { if (handle && handle.abort) handle.abort(); } catch (e) { }
    };
}

function fmtRate(bytesPerSec) {
    const v = Number(bytesPerSec) || 0;
    if (v >= 1024 * 1024) return (v / 1048576).toFixed(1) + ' MB/s';
    if (v >= 1024) return (v / 1024).toFixed(1) + ' KB/s';
    return Math.round(v) + ' B/s';
}

if (typeof module !== 'undefined') {
    module.exports = { startMusic: startMusic, startMonitor: startMonitor, startNetQuality: startNetQuality, startSysinfo: startSysinfo,
    startCalendar: startCalendar, startWeather: startWeather, startTasks: startTasks, lyricIndexFor: lyricIndexFor, fmtRate: fmtRate };
}
