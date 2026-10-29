// applet.js —— MintDeck 入口
//
// 生命周期：Cinnamon 加载本文件 → main() 返回实例 → on_applet_added_to_panel 里挂浮层。
// 浮层用 Main.layoutManager.addChrome()（官方 API），它负责：
//   · 把 actor 放到 chrome 层（普通窗口之上）
//   · 把它加进 stage 输入区域（所以只有它自己的矩形会吃掉点击）
//   · 全屏时按所在显示器自动隐藏（visibleInFullscreen）
// 详见 /usr/share/cinnamon/js/ui/layout.js:543-560 与 :833-864。
'use strict';

const Applet = imports.ui.applet;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Extension = imports.ui.extension;

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;

const UUID = 'mintdeck@bigmalove';

// 快捷键在 KeybindingManager 里的名字（同一 uuid 下唯一即可）
const HOTKEY_NAME = 'toggle-island';

// gettext 域与 Cinnamon 的惯例一致：Spices 安装时会把 po 编成 .mo 放到 ~/.local/share/locale。
// 悬浮岛/面板的文案不走 gettext（自绘 UI 需要「换语言立即生效」，见 lib/core/i18n.js），
// 但设置窗口与「小程序」列表由 xlet-settings 用 gettext 渲染，域必须是 uuid。
const Gettext = imports.gettext;
Gettext.bindtextdomain(UUID, GLib.build_filenamev([GLib.get_user_data_dir(), 'locale']));

// 本 applet 的目录：优先问 Cinnamon（支持任意安装位置），退回用户目录
let BASE = null;
try {
    const ext = Extension.getExtension(UUID);
    if (ext && ext.meta && ext.meta.path) BASE = ext.meta.path;
} catch (e) { /* Extension 在极早期可能还没就绪 */ }
if (!BASE) BASE = GLib.build_filenamev([GLib.get_user_data_dir(), 'cinnamon', 'applets', UUID]);
imports.searchPath.unshift(BASE);

const I18n = imports.lib.core.i18n;
const I18nData = imports.lib.core.i18nData;

const IslandMod = imports.lib.deck.island;
const PanelMod = imports.lib.deck.panel;
const Store = imports.lib.deck.store;
const Data = imports.lib.deck.data;
const Live = imports.lib.deck.live;
const Alerts = imports.lib.core.alerts;
const Pomo = imports.lib.core.pomodoro;

// 界面文案：msgid 是中文原文，t() 按当前 locale 查词典（词典在构造函数里注入）
const _ = I18n.t;

let Themes = null;
try { Themes = imports.lib.core.theme; } catch (e) { Themes = null; }

// 天气分组（lib/linux/weather.js 的 kindOf）→ 界面上的名字
function kindLabel(kind) {
    if (kind === 'clear') return _('晴');
    if (kind === 'partly') return _('多云');
    if (kind === 'cloud') return _('阴');
    if (kind === 'fog') return _('雾');
    if (kind === 'drizzle') return _('细雨');
    if (kind === 'rain') return _('雨');
    if (kind === 'snow') return _('雪');
    if (kind === 'storm') return _('雷雨');
    return '—';
}

// 尺寸档位表在这里：档位 → 七个收起尺寸值
let Geo = null;
try { Geo = imports.lib.core.geometry; } catch (e) { Geo = null; }

class MintDeckApplet extends Applet.Applet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this._instanceId = instance_id;
        this._chrome = [];          // 已挂到 chrome 的 actor
        this._openTimer = 0;
        this._closeTimer = 0;
        this._clockTimer = 0;
        this._refreshTimer = 0;
        this._hoverOpen = false;
        this._liveStops = [];
        this._alertState = {};      // 配额预警的边沿状态：{ [来源名]: { level, at } }
        this._pomodoro = null;      // 番茄钟状态机（构造末尾 create）
        this._lastMonitor = null;   // 最近一帧系统监控（网络页要借用上下行）
        this._lastNet = null;       // 最近一帧网络质量采样
        this._sysinfo = null;       // 磁盘 / 温度 / 风扇 / 频率
        this._calendar = null;      // 日程采集结果 { events, sources, error }
        this._weather = null;       // 天气 { tempC, kind, highC, lowC, ... }
        this._tasks = null;         // 下载 / 容器 / systemd 失败单元
        this._extraStops = { calendar: null, weather: null, tasks: null };

        // ---- 设置 -------------------------------------------------------
        this._settings = new Settings.AppletSettings(this, UUID, instance_id);
        const s = this._settings;
        s.bind('language', 'v_language', () => this._applyLanguage());
        s.bind('style', 'v_style', () => this._reload());
        s.bind('animations', 'v_animations', () => this._reload());
        s.bind('animationDuration', 'v_animDuration', () => this._reload());
        s.bind('panelTheme', 'v_theme', () => this._reloadTheme());
        s.bind('clockStyle', 'v_clockStyle', () => this._reload());
        s.bind('clock24Hour', 'v_clock24', () => this._tick());
        s.bind('showQuotaRing', 'v_showRing', () => this._reload());
        s.bind('showClock', 'v_showClock', () => this._reload());
        s.bind('showMonitor', 'v_showMonitor', () => this._reload());
        // 收起尺寸：默认 auto（按当前画出来的段数自动缩放），也可以钉死成小/标准/大三档。
        // 像素级微调只改表面不改内容，已经收进 geometry 的预设表。
        s.bind('collapsedSize', 'v_collapsedSize', () => this._reload());
        s.bind('openDelay', 'v_openDelay', () => {});
        s.bind('closeDelay', 'v_closeDelay', () => {});
        s.bind('hotkeyToggle', 'v_hotkeyToggle', () => this._applyHotkey());
        s.bind('defaultPage', 'v_defaultPage', () => this._panel.setPage(this.v_defaultPage));
        s.bind('monitor', 'v_monitor', () => this._reload());
        s.bind('showPanelIcon', 'v_showPanelIcon', () => this._applyPanelIcon());
        s.bind('hideInFullscreen', 'v_hideFullscreen', () => this._rebuildChrome());
        // 三个数据源开关连点时会连续触发，合并成一次刷新（每次刷新要枚举 ~240 个目录）
        s.bind('sourceClaude', 'v_sourceClaude', () => this._scheduleRefresh(120));
        s.bind('sourceDsh', 'v_sourceDsh', () => this._scheduleRefresh(120));
        s.bind('sourceWorkbuddy', 'v_sourceWorkbuddy', () => this._scheduleRefresh(120));
        // 配额预警：这三项以前只写在 schema 里、代码里没人读，勾了也不会响。
        // 改了任一项就清空边沿状态，让新阈值立刻重新判一遍（否则要等下一次越线才生效）。
        // 专注计时（番茄钟）：四个数字改了要重建状态机的 cfg，但不清掉当前阶段（跑着的时候改时长，
        // 只影响下一段；这一段的剩余时间按旧值走完，不然倒计时会突然跳）。
        s.bind('focusWorkMinutes', 'v_focusWork', () => this._applyPomodoroConfig());
        s.bind('focusShortMinutes', 'v_focusShort', () => this._applyPomodoroConfig());
        s.bind('focusLongMinutes', 'v_focusLong', () => this._applyPomodoroConfig());
        s.bind('focusLongEvery', 'v_focusEvery', () => this._applyPomodoroConfig());
        s.bind('focusAutoAdvance', 'v_focusAuto', () => this._applyPomodoroConfig());
        s.bind('focusInIsland', 'v_focusIsland', () => this._tick());
        s.bind('focusNotify', 'v_focusNotify', () => {});
        // 日程 / 天气 / 任务：改了哪一路就只重启那一路（天气改城市要重新地理编码）
        s.bind('weatherCity', 'v_weatherCity', () => this._restartDay());
        s.bind('aria2Url', 'v_aria2Url', () => this._restartTasks());
        s.bind('aria2Secret', 'v_aria2Secret', () => this._restartTasks());
        s.bind('qbUrl', 'v_qbUrl', () => this._restartTasks());
        s.bind('qbUser', 'v_qbUser', () => this._restartTasks());
        s.bind('qbPass', 'v_qbPass', () => this._restartTasks());
        s.bind('showContainers', 'v_showContainers', () => this._restartTasks());
        s.bind('quotaAlerts', 'v_quotaAlerts', () => { this._alertState = {}; });
        s.bind('warningPercent', 'v_warnPct', () => { this._alertState = {}; this._scheduleRefresh(120); });
        s.bind('criticalPercent', 'v_critPct', () => { this._alertState = {}; this._scheduleRefresh(120); });

        // ---- 多语言 -----------------------------------------------------
        // 必须在 bind 之后：v_language 是 bind 时才用 defineProperty 挂到 this 上的，
        // 在 bind 之前读永远是 undefined（会被当成 auto → 跟随系统）。
        // 词典先注入，否则下面建菜单/画岛时 t() 只能拿到中文原文。
        I18n.setCatalog(I18nData && I18nData.CATALOG);
        I18n.setLocale(this._requestedLocale());

        // ---- 主题 -------------------------------------------------------
        this._themeStore = new Store.ThemeStore(BASE, Themes);
        this._theme = this._themeStore.get(this.v_theme);

        // ---- UI ---------------------------------------------------------
        this._island = new IslandMod.Island({ style: this.v_style, theme: this._theme });
        this._island.onContentChanged = () => this._layout();   // 内容变宽/变窄时重算形状
        this._panel = new PanelMod.Panel();
        this._panel.setSize(720, 268);
        this._panel.onAction = (action) => this._onPanelAction(action);
        this._panel.setTheme(this._theme);
        this._panel.setPage(this.v_defaultPage || 'usage');

        this._buildMenu();
        this._wireEvents();
        this._applyHotkey();
        this._rebuildChrome();
        this._reload();
        this._startClock();

        this.set_applet_tooltip('MintDeck');
        this._applyPanelIcon();

        this._pomodoro = Pomo.create(this._pomodoroOptions());
        this._publishFocus();

        // 首次读取延后 1.2s：DSH 要起 zstd 子进程，别拖慢 shell 启动
        Data.schedule(this, 1200);
        this._startLive();
    }

    // ------------------------------------------------------------ 面板图标

    // 面板上的小图标只是入口，默认隐藏；设置里勾上才显示。
    // 隐藏后用 is_visible 判断不成立，所以以设置值为准（Cinnamon 重排面板时可能把 actor show 回来，
    // on_applet_added_to_panel 里会再收一次）。
    _applyPanelIcon() {
        if (!this.actor) return;
        if (this.v_showPanelIcon) {
            this._ensurePanelIconActor();
            this.actor.show();
            this.set_applet_tooltip('MintDeck');
        } else {
            if (this._applet_tooltip) this._applet_tooltip.hide();
            this.actor.hide();
        }
    }

    // 这个 applet 本身没有面板图标，需要自己往 actor 里放一个（icon.png）
    _ensurePanelIconActor() {
        if (this._panelIconActor) return;
        let size = 24;
        try { size = this.getPanelIconSize(St.IconType.FULLCOLOR) || size; } catch (e) { /* 老版本没有 */ }
        const icon = new St.Icon({ icon_size: size, style_class: 'applet-icon' });
        try {
            icon.set_gicon(new Gio.FileIcon({
                file: Gio.file_new_for_path(GLib.build_filenamev([BASE, 'icon.png']))
            }));
        } catch (e) { global.logError(e); }
        this.actor.add(icon, { y_align: St.Align.MIDDLE, y_fill: false });
        this._panelIconActor = icon;
    }

    // ------------------------------------------------------------ 浮层挂载

    _rebuildChrome() {
        for (const actor of this._chrome) {
            try { Main.layoutManager.removeChrome(actor); } catch (e) { /* 已移除 */ }
        }
        this._chrome = [];

        const params = {
            visibleInFullscreen: !this.v_hideFullscreen,
            affectsStruts: false,
            affectsInputRegion: true
        };
        Main.layoutManager.addChrome(this._island.actor, params);
        Main.layoutManager.addChrome(this._panel.actor, params);
        this._chrome.push(this._island.actor, this._panel.actor);
        // addChrome 会把 actor 纳入 chrome 的显示管理，这里显式收一次，保证「默认收起」
        this._panel.actor.hide();
        this._reload();
    }

    _removeChrome() {
        for (const actor of this._chrome) {
            try { Main.layoutManager.removeChrome(actor); } catch (e) { /* ignore */ }
        }
        this._chrome = [];
    }

    // ------------------------------------------------------------ 布局

    _pickMonitor() {
        const lm = Main.layoutManager;
        if (this.v_monitor === 'cursor' && lm.currentMonitor) return lm.currentMonitor;
        return lm.primaryMonitor || lm.monitors[0];
    }

    // 工作区顶部：顶部面板占据的区域要避开，否则刘海会和面板图标叠在一起
    _workArea(monitor) {
        const box = Main.layoutManager.panelBox;
        let top = monitor.y;
        if (box && box.visible && box.y < monitor.y + monitor.height / 2) {
            top = Math.max(top, box.y + box.height);
        }
        return {
            x: monitor.x,
            y: top,
            width: monitor.width,
            height: Math.max(40, monitor.y + monitor.height - top)
        };
    }

    _scaleFactor() {
        try {
            return St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        } catch (e) {
            return 1;
        }
    }

    _currentSettings(units) {
        // 档位 → 七个尺寸值（标准档与上游默认逐值一致）。lineTop 不属于档位，保持 4。
        // auto 档这里按「当前画出来的段数」现算，所以内容一变整套尺寸就跟着变。
        const preset = (Geo && Geo.presetSettings) ? Geo.presetSettings(this.v_collapsedSize, units) : {};
        preset.lineTop = 4;
        return preset;
    }

    _layout() {
        const monitor = this._pickMonitor();
        if (!monitor) return;
        const work = this._workArea(monitor);
        const style = this.v_style || 'notch';
        // 自动宽度：把内容想要的宽度交给 geometry（上游 NotchAutoWidth / CapsuleAutoWidth 的同一套算法）。
        // 内容宽度按「当前档位」估，而不是按上一帧 shape 的 scale —— 切档时不会先窄后宽地跳一下。
        // auto 档还要把段数传下去：段数决定高度与内容缩放（1 段 24 高 … 5 段 40 高）。
        const units = (this._island && this._island.contentUnits) ? this._island.contentUnits() : 0;
        const k = (Geo && Geo.contentScale) ? Geo.contentScale(this.v_collapsedSize, style, units) : 1;
        const wanted = this._island.contentWidthEstimate(k);
        const shape = IslandMod.Island.computeShape(
            this._currentSettings(units), style, monitor, work, this._scaleFactor(), wanted);
        this._island.applyShape(shape);
        this._panel.place(shape, monitor);   // 尺寸由 panel 自己按页决定（_autosize）
        this._shape = shape;
    }

    _reload() {
        this._theme = this._themeStore.get(this.v_theme);
        this._island.setTheme(this._theme);
        this._panel.setTheme(this._theme);
        this._island.setClockStyle(this.v_clockStyle);
        this._layout();
        // 收起态内容开关
        if (this.v_showClock) this._tick(); else this._island.setClockText('');
        if (!this.v_showRing) this._island.setQuotas([]);
        return false;
    }

    _reloadTheme() {
        this._reload();
    }

    // ------------------------------------------------------------ 时钟

    _startClock() {
        this._tick();
        if (this._clockTimer) GLib.source_remove(this._clockTimer);
        this._clockTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._tick();
            return true;
        });
    }

    // 每秒一拍：先把番茄钟推进一格（到点要响），再决定收起态那一格写什么。
    // 顺序不能反 —— 先读 remaining 再 tick 的话，倒计时会晚一秒归零。
    _tick() {
        const now = Date.now();
        if (this._pomodoro) {
            const res = Pomo.tick(this._pomodoro, now);
            if (res.events.length) this._onPomodoroEvents(res.events);
            this._publishFocus();
        }
        let text = '';
        if (this._pomodoro && this.v_focusIsland !== false && this._pomodoro.phase !== 'idle') {
            // 专注/休息期间，岛上的那一格换成倒计时；时钟让位（这也是「灵动岛」该有的样子）
            text = Pomo.format(Pomo.remaining(this._pomodoro, now));
        } else if (this.v_showClock) {
            text = this._clockLabel(new Date(now));
        }
        this._island.setClockText(text);
        return false;
    }

    _clockLabel(now) {
        let h = now.getHours();
        const m = ('0' + now.getMinutes()).slice(-2);
        let suffix = '';
        if (!this.v_clock24) {
            suffix = h >= 12 ? ' PM' : ' AM';
            h = h % 12 || 12;
        } else {
            h = ('0' + h).slice(-2);
        }
        return h + ':' + m + suffix;
    }

    // ------------------------------------------------------------ 专注（番茄钟）

    _pomodoroOptions() {
        return {
            workMin: this.v_focusWork,
            shortMin: this.v_focusShort,
            longMin: this.v_focusLong,
            longEvery: this.v_focusEvery,
            autoAdvance: this.v_focusAuto !== false
        };
    }

    // 改设置不动当前阶段：跑着的时候改时长，只影响下一段（不然倒计时会突然跳几十分钟）
    _applyPomodoroConfig() {
        if (!this._pomodoro) return false;
        this._pomodoro.cfg = Pomo.config(this._pomodoroOptions());
        if (this._pomodoro.phase === Pomo.PHASE_IDLE) {
            this._pomodoro.durationMs = this._pomodoro.cfg.workMin * 60000;
        }
        this._publishFocus();
        this._tick();
        return false;
    }

    _publishFocus() {
        const p = this._pomodoro;
        if (!p || !this._panel) return;
        const now = Date.now();
        const idle = p.phase === Pomo.PHASE_IDLE;
        const totalMs = idle ? p.cfg.workMin * 60000 : p.durationMs;
        this._panel.setFocus({
            phase: p.phase,
            timeText: Pomo.format(idle ? totalMs : Pomo.remaining(p, now)),
            progress: idle ? 0 : Pomo.progress(p, now),
            rounds: p.rounds,
            longEvery: p.cfg.longEvery,
            running: p.running
        });
    }

    _focusToggle() {
        const p = this._pomodoro;
        const now = Date.now();
        if (p.running) Pomo.pause(p, now);
        else if (p.phase === Pomo.PHASE_IDLE) Pomo.start(p, now);
        else Pomo.resume(p, now);
        this._publishFocus();
        this._tick();
        return false;
    }

    _onPomodoroEvents(events) {
        const p = this._pomodoro;
        if (this.v_focusNotify === false) return;
        for (const ev of events) {
            try {
                if (ev === 'work-done') {
                    const mins = p.phase === Pomo.PHASE_LONG ? p.cfg.longMin : p.cfg.shortMin;
                    Main.notify('MintDeck · ' + _('番茄钟'), _('专注结束，休息 %s 分钟', mins));
                } else if (ev === 'break-done') {
                    Main.notify('MintDeck · ' + _('番茄钟'), _('休息结束，回来继续专注'));
                }
            } catch (e) { global.logError(e); }
        }
    }

    // ------------------------------------------------------------ 交互

    _wireEvents() {
        const islandActor = this._island.actor;

        islandActor.connect('enter-event', () => {
            this._hoverOpen = true;
            this._cancelClose();
            this._scheduleOpen();
            return false;
        });
        islandActor.connect('leave-event', () => {
            this._hoverOpen = false;
            this._scheduleClose();
            return false;
        });
        islandActor.connect('button-release-event', (actor, event) => {
            if (event.get_button() !== 1) return false;
            if (this._panel.actor.visible) this._closePanel(); else this._openPanel();
            return true;
        });

        this._panel.actor.connect('enter-event', () => {
            this._cancelClose();
            return false;
        });
        this._panel.actor.connect('leave-event', () => {
            this._scheduleClose();
            return false;
        });
    }

    // ------------------------------------------------------------ 快捷键

    // 设置里的「展开或收起面板」：Cinnamon 6 的 xlet 快捷键走 KeybindingManager.addXletHotKey。
    // 传空字符串时它自己会把旧绑定摘掉（_removeMatchingXletBindings），所以这里不用分支。
    // 值有两种形态：schema 默认是空串，xlet-settings 改过之后写的是加速键数组（["<Super>F9"]），
    // addXletHotKey 认的是 "::" 分隔的字符串，所以数组要先 join。
    _applyHotkey() {
        const km = Main.keybindingManager;
        if (!km) return false;      // Main 还没装好，on_applet_added_to_panel 里会再调一次
        const raw = this.v_hotkeyToggle;
        const accel = Array.isArray(raw)
            ? raw.filter(Boolean).join('::')
            : String(raw || '').trim();
        try {
            km.addXletHotKey(this, HOTKEY_NAME, accel, () => this._togglePanel());
        } catch (e) { global.logError(e); }
        return false;
    }

    _togglePanel() {
        if (this._panel && this._panel.actor && this._panel.actor.visible) this._closePanel();
        else this._openPanel();
    }

    _scheduleOpen() {
        this._cancelOpen();
        const delay = this.v_openDelay || 0;
        if (delay <= 0) { this._openPanel(); return; }
        this._openTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._openTimer = 0;
            if (this._hoverOpen) this._openPanel();
            return false;
        });
    }

    _cancelOpen() {
        if (this._openTimer) { GLib.source_remove(this._openTimer); this._openTimer = 0; }
    }

    _scheduleClose() {
        this._cancelClose();
        const delay = this.v_closeDelay === undefined ? 260 : this.v_closeDelay;
        this._closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, delay), () => {
            this._closeTimer = 0;
            // 指针可能已经回到岛或面板上
            if (this._island.actor.hover || this._panel.actor.hover) return false;
            this._closePanel();
            return false;
        });
    }

    _cancelClose() {
        if (this._closeTimer) { GLib.source_remove(this._closeTimer); this._closeTimer = 0; }
    }

    _openPanel() {
        this._cancelOpen();
        this._panel.setPage(this._panel.page || this.v_defaultPage || 'usage');
        this._panel.show(this.v_animations, this.v_animDuration);
    }

    _closePanel() {
        this._cancelClose();
        this._panel.hide(this.v_animations, Math.round((this.v_animDuration || 360) * 0.6));
    }

    // ------------------------------------------------------------ 语言

    // 设置的 language：'auto' 跟随系统（GLib.get_language_names() 的顺序就是优先级）
    _requestedLocale() {
        const want = this.v_language;
        if (want && want !== 'auto') return want;
        let names = [];
        try { names = GLib.get_language_names() || []; } catch (e) { names = []; }
        return I18n.pickLocale(names);
    }

    // 换语言：菜单要重建（菜单项是建菜单时写死的文字），画布上的字靠重画，
    // 面板里的列是 data.js 生成的字符串，所以还要重新读一遍数据。
    _applyLanguage() {
        I18n.setLocale(this._requestedLocale());
        // 构造早期（UI 还没建完）只换 locale，剩下的交给构造流程用新语言画一遍
        if (!this._panel || !this._menu) return false;
        this._rebuildMenu();
        this._tick();
        // 下拉框连点会连着触发几次，合并掉：列文字要重算，但不能每次都全量扫一遍磁盘
        this._scheduleRefresh(120);
        this._panel.actor.queue_repaint();
        return false;
    }

    // 合并短时间内的多次刷新请求（延迟 0 = 下一拍就刷）
    _scheduleRefresh(delayMs) {
        if (this._refreshTimer) { GLib.source_remove(this._refreshTimer); this._refreshTimer = 0; }
        this._refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, delayMs || 0), () => {
            this._refreshTimer = 0;
            this._refreshData();
            return false;
        });
    }

    // ------------------------------------------------------------ 菜单

    _buildMenu() {
        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._menu = new Applet.AppletPopupMenu(this, this.orientation);
        this._menuManager.addMenu(this._menu);
        this._fillMenu();
    }

    // 重建而不是每次新建：换语言时只需换掉菜单项，菜单对象与 manager 保留
    _rebuildMenu() {
        if (!this._menu) { this._buildMenu(); return; }
        this._menu.removeAll();
        this._fillMenu();
    }

    _fillMenu() {
        this._menu.addAction(_('专注计时'), () => {
            this._focusToggle();
            this._menu.close();        // 点完就收起，不然菜单还压着面板
        });
        this._menu.addAction(_('设置…'), () => this.configureApplet());
        this._menu.addAction(_('重新读取数据'), () => this._refreshData());
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._menu.addAction(_('关于 MintDeck'), () => {
            Main.notify('MintDeck', _('基于 BrimDeck（Apache-2.0）的 Cinnamon 复刻。'));
        });
    }

    // M1 接入真实数据；在此之前是空实现，避免菜单点了没反应
    _onPanelAction(action) {
        if (action === 'refresh') { this._refreshData(); return; }
        if (action === 'settings') { this.configureApplet(); return; }
        if (action === 'focus:toggle') { this._focusToggle(); return; }
        if (action === 'focus:skip') { Pomo.skip(this._pomodoro, Date.now()); this._publishFocus(); this._tick(); return; }
        if (action === 'focus:reset') { Pomo.stop(this._pomodoro); this._publishFocus(); this._tick(); return; }
        const music = this._liveStops.find(s => typeof s.playPause === 'function');
        if (!music) return;
        if (action === 'music:playpause') music.playPause();
        else if (action === 'music:next') music.next();
        else if (action === 'music:prev') music.previous();
    }

    _startLive() {
        this._stopLive();
        try {
            this._liveStops.push(Live.startMusic(this, (info) => {
                this._panel.setNowPlaying(info);
                this._island.setNowPlaying(info);
            }));
        } catch (e) { global.logError(e); }
        try {
            this._liveStops.push(Live.startMonitor(this, (sample) => {
                this._panel.setMonitor(sample);
                this._island.setMonitor(sample, this.v_showMonitor !== false);
                this._lastMonitor = sample;
                this._publishNetwork();          // 网络页的上下行借这一帧，不再单独采一次
            }));
        } catch (e) { global.logError(e); }
        try {
            this._liveStops.push(Live.startNetQuality((sample) => {
                this._lastNet = sample;
                this._publishNetwork();
            }));
        } catch (e) { global.logError(e); }
        try {
            this._liveStops.push(Live.startSysinfo((info) => {
                this._sysinfo = info;
                this._panel.setSysinfo(info);
            }));
        } catch (e) { global.logError(e); }
        this._restartDay();
        this._restartTasks();
    }

    // 网络页 = 链路/ping/IP（Live.startNetQuality）+ 上下行（监控采样的同一帧）。
    // 两路各自回来都重算一次，谁也等谁 —— 缺的那半显示 —，不拿 0 顶。
    _publishNetwork() {
        const n = this._lastNet;
        const m = this._lastMonitor || {};
        if (!n && !m.rxKbps) return;
        const link = n && n.link ? n.link : null;
        const lat = n && n.latency ? n.latency : null;
        this._panel.setNetwork({
            iface: link ? link.iface : null,
            operstate: link ? link.operstate : null,
            speedMbps: link ? link.speedMbps : null,
            rttMs: lat ? lat.rttMs : null,
            lossPercent: lat ? lat.lossPercent : null,
            publicIp: n ? n.publicIp : null,
            rxKbps: m.rxKbps || null,
            txKbps: m.txKbps || null,
            status: (link || lat) ? 'ok' : 'unavailable',
            intervalSec: 30
        });
    }

    // ------------------------------------------------------------ 日程 / 天气 / 任务

    _stopExtra(name) {
        const stop = this._extraStops[name];
        if (stop) { try { stop(); } catch (e) { } }
        this._extraStops[name] = null;
    }

    _restartDay() {
        this._stopExtra('calendar');
        this._stopExtra('weather');
        try {
            this._extraStops.calendar = Live.startCalendar((res) => {
                this._calendar = res;
                this._publishAgenda();
            });
        } catch (e) { global.logError(e); }
        try {
            this._extraStops.weather = Live.startWeather(this.v_weatherCity, (w) => {
                this._weather = w;
                this._publishAgenda();
            });
        } catch (e) { global.logError(e); }
    }

    _restartTasks() {
        try { this._liveStops.push(Live.startTasks(() => this._taskOptions(), (sample) => {
            this._tasks = sample;
            this._publishTasks();
        })); } catch (e) { global.logError(e); }
    }

    // 每一路「地址留空 = 关闭」，不猜本机有没有装；容器开关是显式的 checkbox
    _taskOptions() {
        const ariaUrl = (this.v_aria2Url || '').trim();
        const qbUrl = (this.v_qbUrl || '').trim();
        return {
            aria2: ariaUrl ? { url: ariaUrl, secret: (this.v_aria2Secret || '').trim() } : null,
            qbittorrent: qbUrl ? { url: qbUrl, user: (this.v_qbUser || '').trim(), pass: this.v_qbPass || '' } : null,
            containers: this.v_showContainers !== false
        };
    }

    _weekdayText(d) {
        const names = [_('周日'), _('周一'), _('周二'), _('周三'), _('周四'), _('周五'), _('周六')];
        return names[d.getDay()] || '';
    }

    _clockTextFor(ms) {
        const d = new Date(ms);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return hh + ':' + mm;
    }

    _buildAgenda() {
        const now = new Date();
        const month0 = now.getMonth();
        const year = now.getFullYear();
        const todayStart = new Date(year, month0, now.getDate()).getTime();
        const dayMs = 86400000;
        const events = (this._calendar && this._calendar.events) ? this._calendar.events : [];

        const today = [];
        const upcoming = [];
        const eventDays = {};
        const seenUpcoming = {};

        for (const ev of events) {
            const start = Number(ev.start);
            if (!Number.isFinite(start)) continue;
            const dayStart = new Date(start);
            dayStart.setHours(0, 0, 0, 0);
            const dayMs0 = dayStart.getTime();
            const dayDiff = Math.round((dayMs0 - todayStart) / 86400000);

            if (dayDiff === 0) {
                today.push({
                    timeText: ev.allDay ? _('全天') : this._clockTextFor(start),
                    summary: ev.summary || _('（无标题）'),
                    at: start
                });
                eventDays[dayStart.getDate()] = true;
            } else if (dayDiff > 0 && dayDiff <= 7) {
                const key = dayMs0 + '|' + (ev.summary || '');
                if (seenUpcoming[key]) continue;
                seenUpcoming[key] = true;
                upcoming.push({
                    dayText: dayDiff === 1 ? _('明天') : (dayStart.getMonth() + 1) + '/' + dayStart.getDate(),
                    summary: ev.summary || _('（无标题）'),
                    at: start
                });
            }
            // 月历上的点：本月任意一天有日程都标
            if (dayStart.getFullYear() === now.getFullYear() && dayStart.getMonth() === now.getMonth()) {
                eventDays[dayStart.getDate()] = true;
            }
        }

        today.sort((x, y) => (x.at || 0) - (y.at || 0));
        upcoming.sort((x, y) => (x.at || 0) - (y.at || 0));

        const w = this._weather;
        const weather = w ? {
            kind: w.kind || null,
            tempText: Number.isFinite(w.tempC) ? Math.round(w.tempC) + '°' : '—',
            kindText: kindLabel(w.kind),
            rangeText: (Number.isFinite(w.lowC) && Number.isFinite(w.highC))
                ? Math.round(w.lowC) + '°~' + Math.round(w.highC) + '°' : ''
        } : null;

        return {
            dateText: _('%s月%s日 · %s', now.getMonth() + 1, now.getDate(), this._weekdayName(now.getDay())),
            year: now.getFullYear(),
            month0: now.getMonth(),
            todayDay: now.getDate(),
            eventDays: Object.keys(eventDays).map(Number),
            today: today,
            upcoming: upcoming,
            weather: weather,
            weatherNote: (weather || !(this.v_weatherCity || '').trim()) ? null : _('设置里填城市后显示天气')
        };
    }

    _weekdayName(dow) {
        const names = [_('周日'), _('周一'), _('周二'), _('周三'), _('周四'), _('周五'), _('周六')];
        return names[dow] || '';
    }

    _publishAgenda() {
        if (!this._panel) return;
        this._panel.setAgenda(this._buildAgenda());
    }

    _publishTasks() {
        const t = this._tasks;
        if (!t) {
            this._panel.setTasks({ downloads: null, containers: null, failed: null, note: _('任务模块不可用') });
            return;
        }
        const speedText = (v) => {
            if (!Number.isFinite(v) || v <= 0) return null;
            return Live.fmtRate(v);
        };
        const downloads = t.downloads ? {
            source: t.downloadsSource || null,
            speedText: speedText(t.downloads.speedBytesPerSec),
            active: (t.downloads.active || []).map(a => ({
                name: a.name || _('（未命名）'),
                percent: Number.isFinite(a.percent) ? a.percent : null,
                meta: [speedText(a.downBytesPerSec), Number.isFinite(a.etaSec) ? _('剩余 %s', this._etaText(a.etaSec)) : null]
                    .filter(Boolean).join(' · ')
            })),
            stopped: t.downloads.stopped || 0,
            total: t.downloads.total || 0
        } : null;
        this._panel.setTasks({
            downloads: downloads,
            containers: t.containers ? {
                total: t.containers.total || 0,
                running: t.containers.running || 0,
                names: t.containers.names || []
            } : null,
            failed: Array.isArray(t.failedUnits) ? t.failedUnits : null,
            note: downloads ? null : _('未配置下载器')
        });
    }

    _etaText(sec) {
        const s = Math.max(0, Math.round(sec));
        if (s >= 3600) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
        if (s >= 60) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
        return s + 's';
    }

    _stopLive() {
        for (const stop of this._liveStops) { try { stop(); } catch (e) { } }
        this._liveStops = [];
    }

    _refreshData() {
        try {
            Data.refresh(this);
        } catch (e) {
            Main.notify('MintDeck', _('读取失败：%s', e.message));
        }
    }

    // ------------------------------------------------------------ 配额预警

    // data.js 每画完一屏列就会回调这里（列里带着各配额百分比）。
    // 判定本身在 lib/core/alerts.js（纯函数，node 可测），这里只负责「响了怎么发」。
    _onColumns(columns) {
        if (this.v_quotaAlerts === false) { this._alertState = {}; return false; }
        let result;
        try {
            result = Alerts.evaluate(columns, this._alertState, {
                warning: this.v_warnPercent,
                critical: this.v_critPct,
                cooldownMs: 30 * 60 * 1000        // 同一来源半小时内只响一次，来回拉阈值不会刷屏
            });
        } catch (e) { global.logError(e); return false; }
        this._alertState = result.state;
        for (const alert of result.alerts) this._notifyQuota(alert);
        return false;
    }

    _notifyQuota(alert) {
        const pct = Math.round(alert.percent) + '%';
        const title = _('配额预警');
        const body = alert.level === 'crit'
            ? _('%s 已达 %s，额度即将用完', alert.name, pct)
            : _('%s 已用 %s', alert.name, pct);
        try {
            if (alert.level === 'crit' && Main.criticalNotify) {
                // 告警线用 criticalNotify：不是一闪而过的 transient 通知，留在通知中心里等人看见
                let icon = null;
                try {
                    icon = new St.Icon({ icon_name: 'dialog-warning', icon_type: St.IconType.FULLCOLOR, icon_size: 36 });
                } catch (e2) { icon = null; }
                Main.criticalNotify('MintDeck · ' + title, body, icon);
            } else {
                Main.notify('MintDeck · ' + title, body);
            }
        } catch (e) { global.logError(e); }
    }

    // ------------------------------------------------------------ 生命周期

    on_applet_clicked() {
        if (this._panel.actor.visible) this._closePanel(); else this._openPanel();
    }

    on_applet_added_to_panel() {
        this._rebuildChrome();
        this._startClock();
        this._reload();
        this._applyPanelIcon();
        this._applyHotkey();   // 构造期 Main 可能还没装好 keybindingManager
        this._startLive();     // 构造期 session bus 可能未就绪，这里兜一次（_startLive 会先停旧的）
    }

    on_applet_removed_from_panel() {
        this._cancelOpen();
        this._cancelClose();
        // 异步子进程（zstd / python3 / nvidia-smi）也要一起收掉：reload 后旧实例不该留着进程
        try { imports.lib.linux.exec.cancelAll(); } catch (e) { /* 没有就跑不起来，无所谓 */ }
        if (this._clockTimer) { GLib.source_remove(this._clockTimer); this._clockTimer = 0; }
        if (this._refreshTimer) { GLib.source_remove(this._refreshTimer); this._refreshTimer = 0; }
        this._stopLive();
        this._removeChrome();
        try { Main.keybindingManager.removeXletHotKey(this, HOTKEY_NAME); } catch (e) { /* 没注册过 */ }
        try { this._menu.destroy(); } catch (e) { /* ignore */ }
        try { this._island.destroy(); } catch (e) { /* ignore */ }
        try { this._panel.destroy(); } catch (e) { /* ignore */ }
        try { this._settings.finalize(); } catch (e) { /* ignore */ }
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new MintDeckApplet(metadata, orientation, panel_height, instance_id);
}
