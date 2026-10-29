// lib/deck/data.js —— 把本机真实数据接进面板
//
// 两个源（本机确实存在的）：
//   · Claude Code      → ~/.claude/projects/**/*.jsonl（assistant 行的 usage + cost-state 的 totalCostUSD）
//   · DeepSeek Harness → ~/.dsh-desktop/sessions/**/session.v4.jsonl.zstd（zstd -dc 后取 assistant/message 的 data.usage）
// 解析逻辑在 lib/core/providers/*.js（纯 JS，node 可测），这里只负责「找文件 → 读 → 汇总 → 喂给 UI」。
//
// 两条性能约束（实测）：218 个 DSH 会话逐个起 zstd 要 5.6s，所以
//   1) zstd / python3 全部异步跑（lib/linux/exec），主线程从不等待子进程；
//   2) 解析结果按 (path, mtime) 缓存到 ~/.cache/mintdeck/usage-cache.json，第二次启动只处理新增会话（实测 18ms）。
'use strict';

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

const Draw = imports.lib.ui.draw;
const Exec = imports.lib.linux.exec;
const I18n = imports.lib.core.i18n;
const Claude = imports.lib.core.providers.claude;
const Dsh = imports.lib.core.providers.dsh;
const WorkBuddy = imports.lib.core.providers.workbuddy;

// 列里的文字是「刷新那一刻」的译文：换语言时 applet 会重新 refresh()，不需要在这里监听
const _ = I18n.t;
const tn = I18n.tn;

const HOME = GLib.get_home_dir();
const CLAUDE_DIR = GLib.build_filenamev([HOME, '.claude', 'projects']);
const DSH_DIR = GLib.build_filenamev([HOME, '.dsh-desktop', 'sessions']);
const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'mintdeck']);
const CACHE_FILE = GLib.build_filenamev([CACHE_DIR, 'usage-cache.json']);
const CACHE_VERSION = 1;

const DSH_MAX_FILES = 400;

// 趋势页的窗口：含今天在内最近 14 个自然日。providers 的 daily() 用同一个口径切桶。
const TREND_DAYS = 14;

const _files = { claude: {}, dsh: {} };   // path -> {mtime, parsed}
let _diskLoaded = false;
let _dirty = false;

// ---------------------------------------------------------------- 磁盘缓存

function loadDiskCache() {
    if (_diskLoaded) return;
    _diskLoaded = true;
    try {
        const [ok, bytes] = GLib.file_get_contents(CACHE_FILE);
        if (!ok || !bytes) return;
        const data = JSON.parse(new TextDecoder('utf-8').decode(bytes));
        if (!data || data.version !== CACHE_VERSION) return;
        for (const kind of ['claude', 'dsh']) {
            const src = data[kind] || {};
            for (const path in src) {
                if (src[path] && typeof src[path].mtime === 'number') _files[kind][path] = src[path];
            }
        }
    } catch (e) { /* 缓存坏了就当没有 */ }
}

function saveDiskCache() {
    if (!_dirty) return;
    try {
        GLib.mkdir_with_parents(CACHE_DIR, 0o700);
        GLib.file_set_contents(CACHE_FILE, JSON.stringify({ version: CACHE_VERSION, claude: _files.claude, dsh: _files.dsh }));
        _dirty = false;
    } catch (e) { global.logError(e); }
}

// ---------------------------------------------------------------- 文件

function listFiles(dirPath, suffix, out) {
    out = out || [];
    let en;
    try {
        en = Gio.File.new_for_path(dirPath).enumerate_children(
            'standard::name,standard::type,time::modified', Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        return out;
    }
    // 枚举器一直持有一个 dirfd，必须显式关掉：
    //   · GJS 靠 GC 回收，等 GC 的时候这些 fd 全开着；
    //   · 一次刷新要枚举 ~233 个会话目录 → 一次刷新就吃掉 ~250 个 fd，
    //     连续几次（切语言 / 连点刷新 / 并行刷新）就撞上 cinnamon 的 1024 上限，
    //     进程直接 abort（GLib-ERROR: Creating pipes for GWakeup: 打开的文件过多）。
    try {
        let info;
        while ((info = en.next_file(null)) !== null) {
            const name = info.get_name();
            const child = en.get_child(info);
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                listFiles(child.get_path(), suffix, out);
            } else if (name.length > suffix.length && name.slice(-suffix.length) === suffix) {
                const mt = info.get_modification_time();
                out.push({
                    path: child.get_path(),
                    mtime: (mt ? mt.tv_sec : 0) * 1000 + (mt ? Math.floor(mt.tv_usec / 1000) : 0)
                });
            }
        }
    } finally {
        try { en.close(null); } catch (e) { /* 已经关了也无所谓 */ }
    }
    return out;
}

// 外部命令一律走 argv 形式（lib/linux/exec → Gio.Subprocess），不拼 shell 字符串：
//   · 路径里出现空格、引号、$ 也不用转义，不会被 shell 解释；
//   · 可执行文件按 PATH 解析，不存在时回调直接给 code:'missing'，调用方按「不可用」处理；
//   · 全异步：zstd 解压大会话动辄几十上百毫秒，同步等会把 shell 主线程按住（面板定住），
//     也会被 cinnamon-settings 的安全扫描判成「可能卡死」并挂黄三角。

// 单文件同步读的上限由调用方控制：解析按 (path, mtime) 缓存，只在新文件出现时才真的读盘。
function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok || !bytes) return null;
        return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
        return null;
    }
}

// 异步解压：onText(文本 | null)
function readZstd(path, onText) {
    Exec.run(['zstd', '-dc', '--', path], (text) => {
        onText(text || null);
    });
}

function newestMtime(list) {
    let newest = 0;
    for (const f of list) if (f.mtime > newest) newest = f.mtime;
    return newest;
}


// ---------------------------------------------------------------- WorkBuddy

// WorkBuddy 的用量在 SQLite 里，而本机没有 sqlite3 CLI —— 用 python3 只读桥（~19ms）。
// mode=ro 让 sqlite 自己处理 -wal，不会锁库、不会写回。
// python3 同样是子进程，一样异步跑：读到就缓存 30s。UI 先拿上一帧顶上，回调来了再重画一帧。
const WB_DB = GLib.build_filenamev([HOME, '.workbuddy', 'workbuddy.db']);
const WB_SNAPSHOT = GLib.build_filenamev([HOME, '.workbuddy', 'storage', 'skeleton', 'account-snapshot.json']);
const WB_TTL_MS = 30000;
let _wbCache = null;        // {at, data}
let _wbWaiters = null;      // 同一时刻只跑一条 python3，后来的调用排队等这一次的结果

function workbuddyScript() {
    return [
        'import sqlite3,json,os',
        'p=' + JSON.stringify(WB_DB),
        'c=sqlite3.connect("file:"+p+"?mode=ro",uri=True)',
        'rows=[{"sid":r[0],"used":r[1],"size":r[2],"upd":r[3],"credit":(sum(json.loads(r[4]).values()) if r[4] else 0)}',
        '      for r in c.execute("select session_id,used,size,updated_at,credit_json from session_usage")]',
        'snap={}',
        'try:',
        '    snap=json.load(open(' + JSON.stringify(WB_SNAPSHOT) + ')).get("primary",{})',
        'except Exception: pass',
        'print(json.dumps({"rows":rows,"snapshot":snap}))'
    ].join('\n');
}

// 缓存里的那一份（可能已经过期）：给「先出帧」用。
function workbuddySnapshot() {
    return _wbCache ? _wbCache.data : null;
}

function workbuddyFresh() {
    return !!(_wbCache && (Date.now() - _wbCache.at) < WB_TTL_MS);
}

// 异步取一次，onData(数据 | null)
function fetchWorkbuddy(onData) {
    if (_wbWaiters) { _wbWaiters.push(onData); return; }
    _wbWaiters = [onData];
    Exec.run(['python3', '-c', workbuddyScript()], (text) => {
        const waiters = _wbWaiters || [];
        _wbWaiters = null;
        let data = null;
        if (text) {
            try { data = JSON.parse(text); } catch (e) { data = null; }
        }
        if (data) _wbCache = { at: Date.now(), data: data };
        for (const fn of waiters) {
            try { fn(data); } catch (e) { /* 单个回调坏了不影响别的 */ }
        }
    });
}

// ---------------------------------------------------------------- 解析

function parseClaudeFile(f) {
    const hit = _files.claude[f.path];
    if (hit && hit.mtime === f.mtime) return hit.parsed;
    const text = readText(f.path);
    if (!text) return null;
    const parsed = Claude.parseSession(text, { sessionKey: f.path, mtime: f.mtime });
    _files.claude[f.path] = { mtime: f.mtime, parsed: parsed };
    _dirty = true;
    return parsed;
}

function collectClaudeSync(now) {
    loadDiskCache();
    const files = listFiles(CLAUDE_DIR, '.jsonl', []);
    const parsed = [];
    for (const f of files) {
        try {
            const p = parseClaudeFile(f);
            if (p) parsed.push(p);
        } catch (e) { /* 单文件坏了不影响整列 */ }
    }
    // daily 是趋势页要的逐日桶（14 天），与 summary 同一套归日规则，在这里一起算掉：
    // parsed 已经在手里，再开一次扫描纯属浪费。
    return {
        summary: Claude.summarize(parsed, now),
        daily: Claude.daily(parsed, now, TREND_DAYS),
        count: files.length,
        newest: newestMtime(files)
    };
}

// 刷新代号：每调一次 refresh 就 +1，旧的异步扫描看到代号变了就自己收手。
// 没有这个，连点「重新读取数据」或连切语言会同时跑好几条扫描链（每条都枚举 233 个目录）。
let _scanToken = 0;

// DSH 文件多：zstd 一个个异步解压（同一时刻只跑一个，别几十个进程一起起），
// 缓存命中的文件在同一个 tick 里直接跳过。onDone(summary, meta, daily)
function collectDshAsync(now, onDone, token) {
    loadDiskCache();
    const all = listFiles(DSH_DIR, '.zstd', []);
    all.sort((a, b) => b.mtime - a.mtime);
    const files = all.slice(0, DSH_MAX_FILES);
    const parsed = [];
    let i = 0;

    const stale = () => token !== undefined && token !== _scanToken;

    const finish = () => {
        if (stale()) return;
        const summary = Dsh.summarize(parsed, now);
        const daily = Dsh.daily(parsed, now, TREND_DAYS);
        saveDiskCache();
        onDone(summary, { parsed: files.length, total: all.length, newest: newestMtime(files) }, daily);
    };

    const step = () => {
        if (stale()) return;                 // 已有更新的一次刷新，这条链作废
        while (i < files.length) {
            const f = files[i];
            const hit = _files.dsh[f.path];
            if (hit && hit.mtime === f.mtime) {
                i++;
                if (hit.parsed) parsed.push(hit.parsed);
                continue;
            }
            i++;
            // 真的要解压：让出主循环，回调里接着走下一格
            readZstd(f.path, (text) => {
                if (stale()) return;
                let p = null;
                try { p = text ? Dsh.parseSession(text) : null; } catch (e) { p = null; }
                if (p) {
                    _files.dsh[f.path] = { mtime: f.mtime, parsed: p };
                    _dirty = true;
                    parsed.push(p);
                }
                step();
            });
            return;
        }
        finish();
    };
    step();
}

function workbuddyColumn(applet, s) {
    const pct = s.contextPercent;
    return {
        name: 'WorkBuddy',
        plan: s.plan ? String(s.plan) : '',
        color: appColor(applet, 'other'),
        quotas: [{
            title: _('上下文'),
            percent: pct,
            context: true,          // 上下文占用不是「配额」，不参与预警（见 lib/core/alerts.js）
            valueText: pct === null ? '—' : Math.round(pct) + '%',
            resetText: s.latest ? _('最近：%s', agoText(s.latest.upd) || _('无')) : null
        }],
        statusText: null,
        todayTokens: _('%s 积分', WorkBuddy.fmtCredits(s.today.credits)),
        weekTokens: _('%s 积分', WorkBuddy.fmtCredits(s.week.credits)),
        todayUsd: null,
        weekUsd: null,
        footer: _('%s 个会话 · 累计 %s 积分', s.total.sessions, WorkBuddy.fmtCredits(s.total.credits))
    };
}

// ---------------------------------------------------------------- 展示

function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return String(Math.round(v));
}

function fmtUsd(v) {
    if (v === null || v === undefined) return null;
    const n = Number(v) || 0;
    if (n >= 100) return '$' + n.toFixed(0);
    if (n >= 1) return '$' + n.toFixed(2);
    if (n > 0) return '$' + n.toFixed(3);
    return '$0';
}

function agoText(ms) {
    if (!ms) return null;
    const days = Math.floor((Date.now() - ms) / 86400000);
    if (days <= 0) return _('今天');
    if (days === 1) return _('昨天');
    if (days < 30) return tn('%s 天前', '%s 天前', days);
    return tn('%s 个月前', '%s 个月前', Math.floor(days / 30));
}

function appColor(applet, id) {
    try {
        const apps = applet._theme && applet._theme.apps;
        return apps && apps[id] ? Draw.cssColor(apps[id]) : null;
    } catch (e) {
        return null;
    }
}

function claudeColumn(applet, s, meta) {
    const empty = !s.today.tokens && !s.week.tokens;
    return {
        name: 'Claude',
        plan: '',
        color: appColor(applet, 'claude'),
        quotas: [
            { title: _('5 小时'), percent: null, resetText: null },
            { title: _('每周'), percent: null, resetText: null }
        ],
        statusText: _('未登录 · 仅本机用量'),
        todayTokens: fmtTokens(s.today.tokens),
        weekTokens: fmtTokens(s.week.tokens),
        todayUsd: fmtUsd(s.today.usd),
        weekUsd: fmtUsd(s.week.usd),
        footer: empty ? _('最近记录 %s', agoText(meta && meta.newest) || _('无')) : _('本机会话')
    };
}

function dshColumn(applet, s, meta) {
    return {
        name: 'DeepSeek Harness',
        plan: '',
        color: appColor(applet, 'dsh'),
        quotas: [],
        todayTokens: fmtTokens(s.today.tokens),
        weekTokens: fmtTokens(s.week.tokens),
        todayUsd: null,
        weekUsd: null,
        footer: meta ? _('%s/%s 个会话', meta.parsed, meta.total) : _('本机会话')
    };
}

// ---------------------------------------------------------------- 趋势

// 逐日序列的容器：一次 refresh 建一次，各源（同步的 Claude、异步的 DSH / WorkBuddy）各自往里塞自己那条。
// 窗口起点由 trendWindow() 现算，providers 的 daily() 用同一个「含今天 14 天」口径，下标才对得上。
let _trend = null;

function trendWindow(now) {
    const today = new Date(now instanceof Date ? now.getTime() : (Number(now) || Date.now()));
    today.setHours(0, 0, 0, 0);
    const days = [];
    for (let i = TREND_DAYS - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        d.setHours(0, 0, 0, 0);
        days.push(d.getTime());
    }
    return days;
}

function resetTrend(now) {
    _trend = { days: trendWindow(now), series: [] };
    return _trend;
}

function putSeries(series) {
    if (!_trend || !series) return;
    for (let i = 0; i < _trend.series.length; i++) {
        if (_trend.series[i].key === series.key) { _trend.series[i] = series; return; }
    }
    _trend.series.push(series);
}

function dropSeries(key) {
    if (!_trend) return;
    for (let i = 0; i < _trend.series.length; i++) {
        if (_trend.series[i].key === key) { _trend.series.splice(i, 1); return; }
    }
}

function paintTrend(applet) {
    try { applet._panel.setTrend(_trend); } catch (e) { global.logError(e); }
}

// ---------------------------------------------------------------- 入口

function render(applet, columns) {
    applet._panel.setUsage(columns);
    // 收起态的环：每个启用的源一个环（颜色是各自的工具色）。
    // 有配额百分比就填充，没有就只画轨道 —— 上游在「有该源但读不到配额」时也是这样留空的。
    const quotas = [];
    for (const c of columns) {
        if (c.statusCode === 'error') continue;
        const pct = Number.isFinite(c.percent) ? c.percent
            : (c.quotas || []).reduce((best, q) => (Number.isFinite(q.percent) ? Math.max(best, q.percent) : best), 0);
        quotas.push({ percent: pct, color: c.color });
    }
    // 记一份最近结果：设置里把「显示配额环」重新打开时，_reload 立刻拿它恢复，
    // 不用等下一次数据刷新（刷新只在启动 / 手动 / 换语言时发生）。
    applet._lastQuotas = quotas;
    applet._island.setQuotas(quotas, applet.v_showRing !== false);
    // 配额预警由 applet 判定（它才持有设置项与通知通道）；这里只在列更新后敲一下。
    if (typeof applet._onColumns === 'function') {
        try { applet._onColumns(columns); } catch (e) { global.logError(e); }
    }
}

// 列按 name 就地替换：异步源回来时只换自己那一列，不重排、不闪整块
function upsert(cols, col) {
    for (let i = 0; i < cols.length; i++) {
        if (cols[i].name === col.name) { cols[i] = col; return; }
    }
    cols.push(col);
}

function dropCol(cols, name) {
    for (let i = 0; i < cols.length; i++) {
        if (cols[i].name === name) { cols.splice(i, 1); return; }
    }
}

// 三段式：Claude 立刻出（文件少、同步读），DSH 与 WorkBuddy 各自异步跑完后替换自己那一列
function refresh(applet) {
    const token = ++_scanToken;
    const now = new Date();
    const cols = [];
    const live = () => token === _scanToken;
    const paint = () => { if (live()) render(applet, cols); };
    resetTrend(now);

    if (applet.v_sourceClaude !== false) {
        try {
            const r = collectClaudeSync(now);
            cols.push(claudeColumn(applet, r.summary, r));
            putSeries({
                key: 'claude', name: 'Claude', unit: 'tokens', order: 0,
                color: appColor(applet, 'claude'),
                values: (r.daily && r.daily.tokens) || [],
                usd: r.daily ? r.daily.usd : null
            });
        } catch (e) {
            cols.push({ name: 'Claude', color: appColor(applet, 'claude'), statusText: _('读取失败'), statusCode: 'error' });
        }
    }
    if (applet.v_sourceDsh !== false) {
        cols.push({ name: 'DeepSeek Harness', color: appColor(applet, 'dsh'), statusText: _('读取中…'), statusCode: 'loading' });
    }
    if (applet.v_sourceWorkbuddy !== false) {
        const cached = workbuddySnapshot();
        try {
            cols.push(cached
                ? workbuddyColumn(applet, WorkBuddy.summarize(cached, now))
                : { name: 'WorkBuddy', color: appColor(applet, 'other'), statusText: _('读取中…'), statusCode: 'loading' });
            if (cached) {
                putSeries({
                    key: 'workbuddy', name: 'WorkBuddy', unit: 'credits', order: 2,
                    color: appColor(applet, 'other'),
                    values: WorkBuddy.daily(cached, now, TREND_DAYS).credits
                });
            }
        } catch (e) {
            cols.push({ name: 'WorkBuddy', color: appColor(applet, 'other'), statusText: _('读取失败'), statusCode: 'error' });
        }
    }
    paintTrend(applet);
    paint();

    if (applet.v_sourceWorkbuddy !== false && !workbuddyFresh()) {
        fetchWorkbuddy((raw) => {
            if (!live()) return;
            if (!raw) { dropCol(cols, 'WorkBuddy'); dropSeries('workbuddy'); paintTrend(applet); paint(); return; }   // 读不到就不占位置
            try {
                upsert(cols, workbuddyColumn(applet, WorkBuddy.summarize(raw, now)));
                putSeries({
                    key: 'workbuddy', name: 'WorkBuddy', unit: 'credits', order: 2,
                    color: appColor(applet, 'other'),
                    values: WorkBuddy.daily(raw, now, TREND_DAYS).credits
                });
                paintTrend(applet);
            } catch (e) {
                upsert(cols, { name: 'WorkBuddy', color: appColor(applet, 'other'), statusText: _('读取失败'), statusCode: 'error' });
            }
            paint();
        });
    }

    if (applet.v_sourceDsh !== false) {
        collectDshAsync(now, (summary, meta, daily) => {
            if (!live()) return;
            try {
                upsert(cols, dshColumn(applet, summary, meta));
                putSeries({
                    key: 'dsh', name: 'DeepSeek Harness', unit: 'tokens', order: 1,
                    color: appColor(applet, 'dsh'),
                    values: (daily && daily.tokens) || []
                });
                paintTrend(applet);
            } catch (e) {
                upsert(cols, { name: 'DeepSeek Harness', statusText: _('读取失败'), statusCode: 'error' });
            }
            paint();
        }, token);
    }
}

function schedule(applet, delayMs) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs || 1500, () => {
        try { refresh(applet); } catch (e) { global.logError(e); }
        return false;
    });
}

if (typeof module !== 'undefined') {
    module.exports = {
        refresh: refresh,
        schedule: schedule,
        collectClaude: collectClaudeSync,
        collectDsh: collectDshAsync,
        fmtTokens: fmtTokens,
        fmtUsd: fmtUsd,
        listFiles: listFiles,
        TREND_DAYS: TREND_DAYS,
        trendWindow: trendWindow,
        _trend: function () { return _trend; },
        _resetCache: function () {
            _files.claude = {}; _files.dsh = {}; _diskLoaded = false; _dirty = true;
            _wbCache = null; _wbWaiters = null;
        }
    };
}
