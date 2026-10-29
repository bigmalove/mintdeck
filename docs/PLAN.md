# MintDeck — BrimDeck 的 Cinnamon 复刻方案

> 目标：把 [BrimDeck](https://github.com/MoFeng2223/BrimDeck)（Windows 11 灵动岛，C#/WPF，29,732 行）复刻成 **Linux Mint / Cinnamon 插件**，装进「系统设置 → 小程序」即用。
> 状态：**M0–M3 已完成并在本机运行**（2026-10-28）；**多语言（简体/繁體/en/日）已完成**（2026-10-29）。
> 方案里的路线已按实测校正，实施记录见文末 §14。
> 所有「已核验」条目都来自本机实测或上游源码，带证据。

---

## 0. 结论摘要

| 决策 | 结论 |
| --- | --- |
| 形态 | **Cinnamon Applet**（`mintdeck@bigmalove`），不是 Desklet（桌面层会被窗口盖住）、不是 Electron（内存与插件身份都不对） |
| 渲染 | 单进程 **CinnamonJS（cjs 115.2）+ St/Clutter 自绘**，浮层用官方 `Main.layoutManager.addChrome()` 挂到 chrome 层；GTK3 独立进程只作为降级备选（已实测可行） |
| 数据层 | 上游 `BrimDeck.Core` 的业务模型（Quota / TokenEntry / ProviderSnapshot / 主题 JSON / 几何参数）**原样移植语义**，Win32 通道换成 procfs + MPRIS + 本地 JSONL + HTTPS |
| 视觉 | 主题文件格式与上游 **完全兼容**（同一份 `theme.json` 两边都能读），几何常数逐值照抄（notch 238×32 / inset 30 / 肩 16 / 角 12 …） |
| 字体 | 直接复用上游 4 个 OFL 字体（Orbitron / Bebas Neue / Unbounded / Instrument Serif），时钟九种样式才有还原度 |
| 规模 | C# 29.7k 行 → JS 约 10–12k 行；分 6 个里程碑（M0–M5），约 **23–27 人日**（含 30% 余量约 5–6 周单人） |

三条硬约束先摆出来，它们决定整个架构：

1. **Cinnamon 的 applet 跑在 `cinnamon` 进程里**，UI 只能用 St/Clutter 画；GTK 的主循环不能在这个进程里跑（要么纯 St，要么另起进程）。
2. **上游 90% 的复杂度来自 Win32 通道**（SMTC 媒体会话、DPAPI/os_crypt 解 Chromium 令牌、PDH 采样、CDP 抓网易云、QQ 命名管道）。这些在 Linux 上**不移植**，换成标准接口，代码量直接砍掉一半。
3. **上游视觉是代码建树 + 自绘**（`IslandBorder` 用路径画「肩」，`MonitorView` 自绘图表），不是声明式 XAML 绑定 —— 这意味着移植到 St 时不能用 CSS 拼，必须走 Cairo/Pango 自绘，反而比 XAML 更好对齐。

---

## 1. 已核验的环境事实

| 项 | 值 | 证据 |
| --- | --- | --- |
| 发行版 | Linux Mint 22.3 (Zena) | `/etc/os-release` |
| 桌面 | Cinnamon 6.6.9，X11 会话（`XDG_SESSION_TYPE=x11`，`DISPLAY=:0`） | `cinnamon --version` |
| JS 引擎 | `/usr/bin/cjs` → `cjs-console`，cjs **115.2**（SpiderMonkey 115） | `cjs --version` |
| GI 可用 | `Soup-3.0`、`Soup-2.4`、`Gtk-3.0`、`Gdk-3.0`、`GdkX11-3.0`、`Clutter-1.0`、`ClutterX11-1.0`、`GTop-2.0`、`Gst-1.0`、`Pango` | `girepository-1.0` 列表 |
| GI 缺失 | **无 `Gtk-4.0` typelib**（`libgtk-4.so.1` 在，但 `gir1.2-gtk-4.0` 未装）→ GTK4 路线不通 | 同上 |
| HTTPS（进程内） | cjs + `Soup-3.0` 发 `GET https://api.anthropic.com/v1/models` → **401**（连通，141 字节响应） | 本轮实测 |
| 无边框置顶窗（备选路线） | cjs + GTK3 建窗 → `_NET_WM_STATE = SKIP_PAGER, SKIP_TASKBAR, ABOVE`，`IsViewable`，undecorated + RGBA | `xprop -id` 实测 |
| **浮层官方 API** | `Main.layoutManager.addChrome(actor, {visibleInFullscreen, affectsStruts, affectsInputRegion})` —— 自动加入 chrome 层、自动扩展输入区域、按所在显示器的全屏状态自动隐藏 | `/usr/share/cinnamon/js/ui/layout.js:543-560`（签名与语义）、`:833-864`（`_updateVisibility`） |
| **动画 API** | `actor.ease({duration, mode, onComplete})` 是 **Cinnamon 给 Clutter 打的补丁**（只在 cinnamon 进程内可用）+ `Clutter.AnimationMode.EASE_OUT_BACK(27)` | `environment.js:409-419` |
| 设置存储 | `settings-schema.json` 运行时解析，**不编译 GSettings schema**；落盘 `~/.config/cinnamon/spices/<uuid>/<instance>.json` | `settings.js:690-700, 741-748, 928` |
| 开发热重载 | 装新 applet 无需重启；改代码后走 DBus `org.Cinnamon.ReloadXlet` | `cinnamonDBus.js:96, 352` |
| 无 fetch | cjs 里 `fetch` 与 `structuredClone` 均为 `undefined`；HTTP 只能走 Soup（Cinnamon 强制 pin `Soup 3.0`，实测 3.4） | 运行时探测 + `environment.js:3-8` |
| CLI | `zstd`、`python3`(gi 3.48.2)、`jq`、`curl` 有；**`sqlite3` 无**、**`playerctl` 无** | `which` |

上游侧关键事实（读源码得出，全量报告见 §5 表）：

- 入口 `Program.Main` → `App.OnStartup` → 单实例 Mutex → `UsageService` → `Deck.Show()`；
- 窗口是 layered + `WS_EX_NOACTIVATE`（0x08000000）+ 400ms 轮询守护 z-order（`WindowsHost.cs:214`、`:67-107`）；
- 收起态三种形态由 `CollapsedLimits`（`CollapsedGeometry.cs:6-40`）参数化，`Resolve()` 出 `CollapsedShape`；
- 展开了三个页面：`DeckPage.Usage | Music | Monitor`（`DeckPages.cs:9`），页面切换是 `PageHandover` 五种转场（`None/Dissolve/Morph/Forward/Back`）；
- 数据面：`UsageService.FetchCoreAsync`（`:213`）一个分派中心，输出 `ProviderResult(List<UsageMetric>, Plan, Scope, Details, Warnings)`；
- 网络端点只有 7 类：`claude.ai/api/oauth/usage`、`chatgpt.com/backend-api/wham/usage`、`api2.cursor.sh`（gRPC-web）、`api.kimi.com|coding/v1`、`zcode.z.ai`、`openrouter.ai/api/v1/models`（价目表）、`lrclib.net` + `music.163.com` + `u.y.qq.com`（歌词）；
- 主题是带注释的 JSON（40+ 颜色键 + apps + clock + 效果），运行时 `Build.Resolve` 强制对比度后再派生 `PanelPalette`。

---

## 2. 复刻范围（裁剪表）

### 做（MVP → 完整）

| 模块 | 内容 |
| --- | --- |
| 收起形态 | 刘海 / 胶囊 / 指示条三种；宽度高度偏移可调；自动宽度（跟随内容）；屏幕边缘对齐（刘海贴顶） |
| 展开面板 | hover 展开 / 移开收起、Esc 收起、点击穿透处理、五个方向的手动缩放（上游 `ResizeGrips`） |
| AI 用量页 | 每列：工具名 + 套餐 chip + 配额环/条 + 重置倒计时 + 今日/7 日 token 与费用；最多 7 列 |
| 音乐页 | 封面、歌名/歌手、同步歌词、进度条拖动、播放/暂停/上下曲/循环模式、多播放器切换 |
| 系统监控页 | CPU 总值 + 每核心柱、内存、GPU、上下行网速、TOP 进程列表、6 色配色方案 |
| 收起态附加 | 配额环、时间（9 种样式）、音乐/歌词预览、系统读数、预警/告警 5 秒提醒 |
| 主题 | 内置 8 套（dark/light/one-dark-pro/github-dark/github-light/dracula/night-owl/cyberpunk）+ 自定义 JSON 文件；对比度强制 |
| 设置 | 精简版（见 §8）：外观、配额与统计、音乐、监控、行为、热键 |
| 行为 | 全屏自动隐藏、最大化切换指示条、多显示器选择、开机自启（`~/.config/autostart`） |

### 缓做（第二阶段）

- 模型明细页（按模型 × 日期范围统计、费用表）
- 主题编辑器 GUI（颜色选择器 + 实时预览 + 保存为新主题）
- 自定义脚本源（`fetchUsage(ctx)`，需进程隔离沙盒，见 §10-R3）
- 价格表自动同步（openrouter 目录 → 本地 cache）
- WSL 跨系统读取（Linux 上改为「读取容器 / 其他用户 home」）

### 不做（写进 README 的差异说明）

`SMTC`、`DPAPI`、`Chromium os_crypt`、`QQ 命名管道`、`网易云 CDP 注入`、`ProcessLoopbackCapture`（律动条改为读 PulseAudio/PipeWire 的 sink monitor，可选）、`Inno Setup`、`GitHub 自更新器`、`AvalonEdit` 脚本编辑器、托盘图标（applet 本身就是常驻入口）。

---

## 3. 技术路线

### 候选对比

| 路线 | 优点 | 硬伤 | 判定 |
| --- | --- | --- | --- |
| **A. 纯 Applet + `Main.uiGroup` 浮层** | 真插件身份（系统设置里可装可卸）；零 IPC；Clutter 直接跑在合成器里，动画最顺；内存 ≈ cinnamon 进程增量几 MB | applet 崩了要保证不连累 shell；全屏隐藏要靠 shell 的 chrome 机制配合；St 的 CSS 子集比 WPF 弱，复杂形状要 Cairo | **选它** |
| B. Applet 外壳 + GTK3 浮层进程 | UI 自由度最高（GTK CSS/任意控件）；调试独立、崩溃隔离 | 两进程 + DBus；GTK3 无 `Gtk-4` 时阴影/模糊受限；X11 input shape 才能做局部穿透；多 60–90MB 常驻 | 降级备选（已实测窗口状态 OK） |
| C. Desklet | 安装更简单 | Desklet 在桌面层，任何窗口都会盖住它，做不了「始终置顶」 | 排除 |
| D. Electron / Tauri | 用 Web 复刻视觉最快 | 200MB+ 常驻，与上游「原生低占用」的立身之本相反；且不是 Cinnamon 插件 | 排除 |

### A 路线要点（关键 API 已实证）

```js
// applet.js 骨架：用官方 chrome API 挂浮层，而不是裸 uiGroup.add_child
const St = imports.gi.St;
const Main = imports.ui.main;
const Applet = imports.ui.applet;

class MintDeck extends Applet.Applet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);
        this._island = new St.Bin({ style_class: 'mintdeck-island', reactive: true, track_hover: true });
        this._island.set_size(238, 32);              // CollapsedLimits.NotchWidthDefault/HeightDefault
        Main.layoutManager.addChrome(this._island, {
            visibleInFullscreen: false,              // 全屏时随所在显示器自动隐藏 = 上游「全屏免打扰」
            affectsStruts: false,                    // 不占工作区，不挤压其它窗口
            affectsInputRegion: true,                // 只有自身矩形进入输入区域 → 天然不挡下方点击
        });
        this._expandPanel = new St.BoxLayout({ visible: false });
        Main.layoutManager.addChrome(this._expandPanel, { visibleInFullscreen: false, affectsInputRegion: true });
    }
    on_applet_removed_from_panel() {
        Main.layoutManager.removeChrome(this._island);   // 必须移除，否则卸载后残留在 chrome 层
        Main.layoutManager.removeChrome(this._expandPanel);
    }
}
```

- **输入区域**：`addChrome` 把 actor 加进 stage input region，且「尺寸/位置/可见性变化会自动更新输入区域」（`layout.js:552-556`）→ 只有岛/面板矩形参与命中测试，其余区域点击直达下方窗口。上游用 `WS_EX_TRANSPARENT` + `GetCursorPos` 轮询解决的同一问题，这里免费得到。
- **全屏隐藏**：`visibleInFullscreen: false` 时，`_updateVisibility()` 只在 **actor 所在显示器** 有全屏窗口时 `set_skip_paint(actor, true)`（`layout.js:855-861`）→ 多显示器下另一个屏幕照常显示，比重写策略更准确。
- **全屏隐藏 & hover 互斥（上游没有的矛盾）**：`visibleInFullscreen: false` 时 actor 被 `set_skip_paint` 的同时也被移出 stage input region（`layout.js:857-862` + `:1037-1055`）→ **全屏下连 hover 事件都收不到**。上游「全屏免打扰」本来就是「看不见也不响应」，语义一致；如果之后想加「全屏也能鼠标唤出」，只能把该 actor 设为 `visibleInFullscreen: true`，此时它会在全屏影片/游戏上方常显 —— 做成设置项（默认关）。
- **输入区域是矩形并集，不跟随圆角**：刘海的下圆角 12px 处仍会吃掉点击（`layout.js:1072` 的矩形 region）。可接受；若在意，用 `affectsInputRegion: false` + `trackChrome(小矩形)` 只登记环与按钮。
- 需要「点穿但保留 hover」时用 `affectsInputRegion: false` + 在浮层内用 `trackChrome()` 精确登记可点区域（对应上游 `ResizeGripLayer` 用 1/255 alpha 抢点击的技巧）。
- 多显示器：`Main.layoutManager.monitors[]` 给 `Monitor{x, y, width, height}`（`layout.js:351`），按上游 `DisplayLayout`/`ScreenPolicy` 的策略选监视器。
- 动画：`actor.ease({duration, mode, onComplete})`（Cinnamon 补丁，`environment.js:409-419`）+ `Clutter.AnimationMode.EASE_OUT_BACK`；没有真 spring，弹性感靠 `EASE_OUT_BACK/EASE_OUT_ELASTIC` 近似，上游默认 360ms（`DeckSettings.AnimationDuration`），曲线抄 `Easing.cs`。
- 形状：刘海「肩」与 12px 下圆角用 `St.DrawingArea` + cairo 路径（对应上游 `IslandBorder` 的 `Geometry`），阴影用 St CSS `box-shadow`（Cinnamon 自带主题 `cinnamon.css` 里已在用，18 处）。
- **调试**：装新 applet 不需重启 Cinnamon；改代码用 DBus `org.Cinnamon.ReloadXlet` 热重载（`cinnamonDBus.js:352`），开发循环几秒一次。

### M0 需要一次实测的 3 件事（其余已确认）

1. 浮层与展开面板同时存在时，hover 进入/离开的边界判定（两块矩形相邻，需要合并的 hover 桥接，对应上游 `CollapsedHover.HasBridge`）。
2. 自定义 `@font-face` 能否在 applet 的 `stylesheet.css` 里生效（决定 9 种时钟样式是走字体还是 Cairo 绘制）；不生效就把 4 个 ttf 装进 `~/.local/share/fonts/` + `fc-cache`，用字体族名。
3. `GTop` / `/proc` 采样在 cjs 里单次耗时是否 < 5ms（决定 1s 刷新是否可行）。

---

## 4. 目录结构（Cinnamon spice 规范）

```
mintdeck@bigmalove/                 # uuid 目录，装到 ~/.local/share/cinnamon/applets/
├── metadata.json               # uuid/name/description/icon/max-instances
├── applet.js                   # 入口：Applet 子类 + 生命周期
├── settings-schema.json        # GSettings 键（applet 框架自动编译）
├── stylesheet.css              # 主题无关的基础样式（颜色全部由 JS 注入）
├── po/                         # zh_CN / en
├── lib/
│   ├── deck/                   # 面板与页面
│   │   ├── island.js           # 收起态（三形态 + 配额环 + 时钟 + 音乐预览）
│   │   ├── panel.js            # 展开容器 + 转场
│   │   ├── usage-page.js       # AI 用量
│   │   ├── music-page.js       # 音乐
│   │   └── monitor-page.js     # 监控
│   ├── core/                   # 纯逻辑，零 St 依赖（可 node 单测）
│   │   ├── quota.js            # Quota/ProviderResult/UsageMetric 等价类型
│   │   ├── providers/          # 每源一个文件：claude.js codex.js cursor.js dsh.js kimi.js zcode.js manual.js
│   │   ├── logs.js             # JSONL 读取 + 增量偏移 + 去重
│   │   ├── pricing.js          # 价目表 + 费用估算
│   │   ├── geometry.js         # CollapsedGeometry 逐函数移植
│   │   ├── theme.js            # 主题 JSON 解析 + 对比度强制 + 派生
│   │   └── store.js            # 设置读写（GSettings 包装）
│   ├── linux/                  # Linux 通道
│   │   ├── mpris.js            # DBus 播放器
│   │   ├── lyrics.js           # lrclib + 网易云
│   │   ├── sysmon.js           # /proc + /sys + GTop + nvidia-smi
│   │   └── secret.js           # 可选 keyring（libsecret，缺失则文件 600）
│   └── ui/                     # 复用控件：环、柱、缓动条、色块、圆角面板
├── themes/                     # 8 套内置 theme.json（直接搬上游 BrimDeck.Core/Themes/）
├── fonts/                      # 4 个 OFL 字体（上游 Assets/Fonts/）
└── icons/
```

安装与打包：

```bash
# 开发期：软链到 applet 目录，改完按 Alt+F2 → r 重启 Cinnamon
ln -s "$PWD/mintdeck@bigmalove" ~/.local/share/cinnamon/applets/mintdeck@bigmalove
# 发布：打 zip，用户拖进「系统设置 → 小程序 → 添加」
```

---

## 5. 模块映射表（C# → JS）

| 上游（C#） | 行数 | MintDeck（JS） | 处理方式 |
| --- | --- | --- | --- |
| `Program.cs` / `App.xaml.cs` | 307 | `applet.js` | 单实例 Mutex 不需要（applet 天然单例）；启动流程改为 `on_applet_added_to_panel` |
| `Native/WindowsHost.cs` | 243 | `lib/deck/island.js` | `WS_EX_NOACTIVATE` / z-order 守护 / 光标轮询 → 全部删除，Clutter 原生提供 |
| `Native/MediaSessions.cs` | 651 | `lib/linux/mpris.js`（~250 行） | SMTC → MPRIS，接口语义一一对应（见 §6.2） |
| `Native/SystemSampler.cs` + `PdhQuery` | 707 | `lib/linux/sysmon.js`（~200 行） | PDH/WMI → procfs + GTop + nvidia-smi |
| `UsageService.cs` | 1051 | `providers/*.js` + `quota.js` | 分派中心保留；`IProviderSecrets` → `secret.js`；`HttpClient` → `Soup.Session` |
| `LogReader.cs` | 307 | `logs.js` | 增量偏移 + 去重算法照搬（按行偏移 + requestId 去重） |
| `Pricing.cs` | 499 | `pricing.js` | 价目表结构与 OpenRouter 拉取照搬 |
| `Settings.cs` / `SettingsMigrations.cs` | 631 | `store.js` + `settings-schema.json` | 90 项 → 精简 30 项（§8） |
| `CollapsedGeometry.cs` | 211 | `geometry.js` | **逐函数 1:1 移植**（含 `SnapToDevicePixels`、`OffsetXRange`） |
| `PanelThemes.*` (7 文件) | ~950 | `theme.js` | JSON 解析 + `base` 继承 + 对比度强制照搬；编辑器 GUI 缓做 |
| `Easing.cs` / `DotMotion.cs` / `EqualizerSignal.cs` | 148+130+153 | `lib/ui/easing.js` | 缓动曲线与律动算法直接移植（律动数据源可先关） |
| `MonitorLayout.cs` / `CompactMonitor.cs` | 432 | `lib/deck/monitor-page.js` | 布局阶梯与「核心柱」算法移植 |
| `Music.cs` / `Lyrics.cs` / `QqLyrics.cs` | 247+226+~100 | `lib/linux/mpris.js` + `lyrics.js` | 只留 lrclib + 网易云两条源 |
| `MainWindow.xaml` + 36 个分部类 | 18.5k | `lib/deck/*.js`（~6k 行） | 代码建树 → 代码建树，反而直接；XAML 里 1.2k 行样式改 CSS 子集 |
| `Native/*` 其余 18 个 | ~2.5k | — | 不移植（Windows 专有） |

### 5.1 测试策略（刻意分层，避免 UI 拖累逻辑）

| 层 | 跑法 | 覆盖 |
| --- | --- | --- |
| `lib/core/**` | **node v24 直接跑**（本机已装，纯 JS 无 `imports.gi` 依赖），用 `node --test` | 几何常数与上游逐值对齐（把 `CollapsedGeometry` 的输入/输出表当夹具）、JSONL 解析与去重、主题派生与对比度、费用计算 |
| `lib/linux/**` | `cjs` + `GI_TYPELIB_PATH=/usr/lib/x86_64-linux-gnu/{cinnamon,muffin}` + `imports.gi.versions.Soup='3.0'`（裸 cjs 不设会 `Typelib not found`） | MPRIS 连接、procfs 采样、Soup 请求 |
| `lib/deck/**` | 装进 Cinnamon 后 `org.Cinnamon.ReloadXlet` 热重载 + 手工核对 | 浮层几何、hover、页面切换 |

`lib/core` 只暴露纯函数与数据结构，任何窗口/St 相关的东西都不许进去 —— 这条纪律决定了一半的返工量。

---

## 6. 数据源（Linux 侧）

### 6.1 AI 配额与用量

| 源 | 本地读取 | 在线配额 | 本机状态（实测） |
| --- | --- | --- | --- |
| **Claude Code** | `~/.claude/projects/**/*.jsonl`：`type:"assistant"` 行的 `message.usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}`、`message.model`；`type:"cost-state"` 行的 `totalCostUSD` + `modelUsage.<model>.{inputTokens,…,costUSD}` | `GET https://claude.ai/api/oauth/usage`，头 `Authorization: Bearer`、`anthropic-beta: oauth-2025-04-20`、`x-app: cli`；返回 `five_hour/seven_day/seven_day_sonnet` 的 `_percentage` + `_reset_time`，`extra_usage{used_credits,monthly_limit,resets_at}` | **有会话数据**（8 个 jsonl，含 cost-state）；`.credentials.json` **缺失** → 配额走 `CLAUDE_CODE_OAUTH_TOKEN` 环境变量，否则降级为「仅本地用量 + 旧数据」 |
| **DeepSeek Harness** | `~/.dsh-desktop/sessions/**/session.v4.jsonl.zstd`：解压后 `type:"assistant/message"` 的 `data.usage.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens}`、`data.message.source.{provider,model}` | `https://platform.deepseek.com`（账户余额/赠送余额/累计消费） | **本机最活跃源**（215 个会话，最新 225KB/当日）→ **第一优先级** |
| Codex | `$CODEX_HOME/auth.json`（`tokens.access_token` + `chatgpt_account_id`）、`sessions/**/rollout-*.jsonl` 的 `token_count` 事件 | `GET https://chatgpt.com/backend-api/wham/usage` | **未安装**（`~/.codex` 仅 1 个 9B 标记文件）→ 显示「未安装」而不是 0 |
| Cursor | `~/.config/Cursor/User/globalStorage/state.vscdb`（需 sqlite） | `api2.cursor.sh` gRPC-web | 未安装；且本机无 `sqlite3` CLI → 只有装了 Cursor 才需要解决 sqlite 读取（用 `python3 -c` 只读桥或用 `sqlite3` 绑定） |
| Kimi Code | `~/.kimi*/`、VS Code 扩展目录 | `api.kimi.com/coding/v1` | 未安装 |
| ZCode | 本地账户库 | `zcode.z.ai/api/v1/{mcp/usage,zcode-plan/billing/balance}` | 未安装 |
| 手动源（GLM / DeepSeek / New API / Sub2API） | 设置里填 key（用 keyring 或 600 权限文件） | 各自接口 | 可选，M4 再做 |

读取实现要点：

```js
// 增量读 jsonl（对应上游 LogReader）：记住 (path, size, offset)，只 parse 新增行
const [ok, bytes] = GLib.file_get_contents(path);          // 或 Gio.File.load_contents
// zstd 会话（DSH）：不能直读，走子进程解流，避免把 200MB 解压进内存
const [res, out] = GLib.spawn_command_line_sync(`zstd -dc ${quote(path)}`);
```

### 6.2 音乐（SMTC → MPRIS）

| 上游 SMTC | Linux MPRIS |
| --- | --- |
| `TryGetMediaPropertiesAsync` → Title/Artist/Album/Thumbnail | `org.mpris.MediaPlayer2.Player` 的 `Metadata`: `xesam:title`、`xesam:artist[]`、`xesam:album`、`mpris:artUrl`、`mpris:length` |
| `PlaybackStatus` | `PlaybackStatus`（Playing/Paused/Stopped） |
| `TimelineProperties.Position` | `Position`（微秒，**不推送变化** → 本地按时间插值，上游 `MusicTimelineHold` 同思路） |
| `TryPlayAsync/TryPauseAsync/TrySkipNextAsync` | `Play()` / `Pause()` / `Next()` / `Previous()` / `Seek(offset)` / `SetPosition(trackId, pos)` |
| `MediaPropertiesChanged` 事件 | `PropertiesChanged` 信号（DBus） |
| 播放器列表（多源切换） | `ListNames` 里所有 `org.mpris.MediaPlayer2.*` |

封面：`artUrl` 为 `file://` 时直接 `St.TextureCache.load_uri_async`（运行时确认存在，范式见 `notificationDaemon.js:144`；实测 Chrome 的 artUrl 就是 `file:///tmp/...` 的 256×256 RGBA PNG，可直接加载），`http(s)://` 时先 `Soup` 下到 `~/.cache/mintdeck/cover/` 再加载，并做 32 项 LRU。
歌词：`lrclib.net/api/get`（精确）+ `lrclib.net/api/search`（模糊）→ 网易云 `music.163.com/api/song/lyric` 兜底；本地 `*.lrc` 优先。上游就是这两条源（`Lyrics.cs:193/201/206`）。实测：LRCLIB 200 / 0.65s / 7.4KB（含 `syncedLyrics`），网易云 200 / 0.10s。

**实测踩到的 4 个坑（都已在 cjs 里复现）**：

1. `Metadata` 是 `a{sv}`，内层还是 variant → **必须 `deepUnpack()` 两次**，否则拿到 `[object variant of type "s"]`。
2. **`Position` 不会随时间推送**（3 秒窗口 0 次 `PropertiesChanged`，值恒 3600158µs）→ 播放中要 1s 轮询 `Properties.Get(Position)`，或在本地按 `PlaybackStatus` + 时间戳累加，两者取其一（推荐轮询，简单且准）。
3. Chrome 的 MPRIS 实现**不提供 introspection XML**（`gdbus introspect --xml` 返回空 `<node>`，cjs 里 `get_interface_info()` 为 `null`）→ 方法签名只能按 MPRIS 规范硬编码，不能靠反射。
4. 元数据可能不规范（Chrome 内嵌播放时 `xesam:artist` 是 `['']` 空字符串数组）→ UI 层要做空值兜底，别让 artist 行占位。

```js
// 连接 + 读取（cjs 内验证过的最小骨架）
const { Gio, GLib } = imports.gi;
const OBJ = '/org/mpris/MediaPlayer2', IFACE = 'org.mpris.MediaPlayer2.Player';
const unwrap = v => { const d = v ? v.deepUnpack() : null; return (d && typeof d.get_type_string === 'function') ? d.deepUnpack() : d; };
let proxy = Gio.DBusProxy.new_sync(Gio.DBus.session, Gio.DBusProxyFlags.NONE, null,
    'org.mpris.MediaPlayer2.<player>', OBJ, IFACE, null);   // 一次缓存全部 Properties
proxy.connect('g-properties-changed', () => refresh());       // 自动转发 PropertiesChanged
const md = unwrap(proxy.get_cached_property('Metadata')) || {};  // 注意要两次 unpack
const title = md['xesam:title'] ? String(unwrap(md['xesam:title'])) : '';
proxy.call('PlayPause', null, Gio.DBusCallFlags.NONE, -1, null, null);  // Next/Previous 同形
```

### 6.3 系统监控（PDH/WMI → procfs）

| 指标 | 上游 | Linux（本机实测值/坑） |
| --- | --- | --- |
| CPU 总值 + 每核心 | PDH `\Processor(_Total)\% Processor Time` | `/proc/stat` 两次差分：`pct = 100 * (1 - Δ(idle+iowait) / Δtotal)`；本机 `nproc=16` → `cpu` + `cpu0..cpu15` 共 17 行 |
| 内存 | `GlobalMemoryStatusEx` | `/proc/meminfo` → `100 * (1 - MemAvailable/MemTotal)`（本机 32GB，实测 52.5%） |
| 网速 | `NetworkInterface` 字节计数 | `/proc/net/dev` 差分（rx = 第 1 个数字，tx = 第 9 个）；**必须排除 `lo` 与本机那个 `Meta` 虚拟 tun（198.18.0.1/30，流量与 `wlp5s0` 完全重复，不排除就翻倍）** |
| GPU | PDH GPU Engine 计数器 | NVIDIA: `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv`（本机 RTX 3080，实测 `38%, 2540/10240 MiB`）；AMD: `/sys/class/drm/card*/device/gpu_busy_percent`；Intel: 无占用率接口，读 `/sys/class/drm/card*/gt_cur_freq_mhz` |
| TOP 进程 | `Process` + 采样差分 | `GTop.glibtop_get_proclist(new GTop.glibtop_proclist(), GTop.GLIBTOP_KERN_PROC_ALL, 0)` **直接返回 pid 数组**（写回 `pl.pid` 会 `items is undefined`）；进程名用 `glibtop_proc_state.cmd`（`Uint8Array`，需解码），`comm` 是 `undefined` |
| 刷新 | 1s（可调 1–5s） | `GLib.timeout_add_seconds`；**实测一次全量采样（cpu + 16 核 + mem + net）≈ 2.07ms**，单文件 0.09–0.31ms → 1s 刷新毫无压力 |

采样频率建议（与上游一致的量级）：CPU/网速 1s、内存 2–5s、GPU 2–3s（`nvidia-smi` 是外部进程，别 1s 拉一次）、MPRIS 走信号 + Position 1s 轮询。

**GTop 的额外坑**：`glibtop_*` 结构体带自引用，`JSON.stringify` 会直接失败 → applet 里只读字段，别序列化整个结构体（影响日志与快照功能的设计）。

---

## 7. 视觉与交互规格（照抄上游）

### 收起态几何（`CollapsedLimits`，单位 DIP）

| 形态 | 默认尺寸 | 位置 | 关键常数 |
| --- | --- | --- | --- |
| 刘海 Notch | 238 × 32 | 贴监视器顶边（`y = 0`），水平居中 + `NotchOffsetX` | 内容高 24、上下各 1（内容盒 26×scale）、`Inset 30`、下圆角 `12`、肩 `16`、宽度 180–8000、高 24–64 |
| 胶囊 Capsule | 196 × 32 | 工作区顶 + `CapsuleTop 5` | `Inset 16`、上下圆角 = H/2；`CapsuleTop` 0–4000 |
| 指示条 Line | 56 × 4 | 工作区顶 + `LineTop 4` | 长 24–600、厚 2–8（半步进）、圆角 = 厚/2 |

- `scale = 高 / 32`（0.75–2）；`Inset` 随 scale 放大；刘海内容还要额外避开 `shoulder + corner = 28`。
- 展开面板：默认 520×200，限制 440–1200 × 140–400；`FloatingHeaderExtra = 6`、`CapsulePanelReach = 22`。
- 动画：`AnimationDuration = 360ms`，`OpenDelay/CloseDelay` 可调；预警 70%、告警 90% 触发 5 秒提醒。
### 尺寸档位（本移植的简化）

收起态不再暴露 7 个像素级设置，只留 `collapsedSize`（`lib/core/geometry.js` 的 `SizePresets` / `AutoLimits`）。
默认 **`auto`**：没有固定矩形，尺寸由「当前真的画出来的段数」决定（封面、每个配额环、文字、律动条、时钟各一段）：

| 段数 | 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- |
| 高 / contentScale | 24 / 0.75 | 28 / 0.875 | 32 / 1.0 | 36 / 1.125 | 40 / 1.25 |

- 3 段 = 标准档、5 段 = 大档，所以自动档与三档能一一对上（两侧宽度另算，见下）。
- 自动档宽度 `= 内容宽 + 2 × (shoulder 16 + 10 × scale)`，`inset` 就用这个值；
  固定档位仍按上游的 `max(Inset30×scale, shoulder+corner=28)` 留白、`notchWidthMin 180` 兜底 ——
  两个环加时钟这种稀疏内容在固定档位上会剩两边一片死白，自动档不会。
- 高度与缩放同源：`scale = 高 / BaseHeight`，`island.js` 的字体、封面、配额环、律动条、间隙全部乘它。
  初版把这些内容尺寸写死，于是「把刘海拉到 40 高」只会多出一圈黑边，改了等于没改。
- 内容一撤就要重排：`island.js` 用 `_contentKey() = contentUnits + '|' + contentWidthEstimate()`
  在 `setQuotas / setNowPlaying / setClockText` 里比较，变了才回调 `onContentChanged → _layout`。
  以前 `setNowPlaying(null)` 直接 return，音乐停了岛还保持播放时的宽度，只剩中间几个环，两边空着。

也可以固定成三档之一（与上游默认逐值一致）：

| 档位 | 刘海 | 胶囊 | 指示条 | contentScale |
| --- | --- | --- | --- | --- |
| 小 compact | 200×26 | 172×26 | 44×3 | 0.8125 |
| 标准 standard | 238×32（= 上表默认） | 196×32 | 56×4 | 1.0 |
| 大 large | 282×40 | 232×40 | 72×5 | 1.25 |

`contentScale = 高 / BaseHeight`（指示条按 `厚 / 4`）。固定档位的宽度也仍按内容自动计算，
所以大档的岛天然更宽。


### 主题（直接复用上游 JSON）

```json
{ "id": "midnight-teal", "name": "午夜青", "base": "dark",
  "colors": { "surface": "#04161A", "accent": "#2DD4BF", "clock": "#5EEAD4" } }
```

- 40+ 颜色键：`surface / textPrimary / textSecondary / textTertiary / accent / hairline / track / ringTrack / fill / hover / popup / shadow / rim / indicator …`
- `apps`：`claude #E5A385 / codex #98DBB0 / antigravity #9CB9FF / cursor #D4D5DF / zcode #4A64A6 / dsh #6081DA / kimi #68CDEB / manual #CC9EED / warning #E5C890 / critical #E78284`
- `clock`：9 种样式（minimal/stacked/digits/dots/segment/neon/serif/wide/condensed）× 7 种配色（default/amber/cyan/pink/lime/custom/gradient/cover）
- 解析时允许 `//` 注释与尾逗号，未知键忽略，`base` 继承 → **用户现有的 BrimDeck 主题文件可以直接拷进来用**
- 关键派生：文字对比度不足时沿色相提亮/压暗（`PanelThemes.Build.Resolve`），监控配色可从主题 accent + 备选色自动取（`MonitorColors.FromTheme`）

### 排版

- 标题/数字：`Segoe UI Variable Text` → Linux 用 **Noto Sans**（本机已有；中文自动回落 **Noto Sans CJK SC**，同样已有）；想要更接近原版的窄体可在安装脚本里可选装 **Inter**（本机当前没有）
- 时钟专用：Orbitron（数码管）、Bebas Neue（condensed）、Unbounded（wide）、Instrument Serif（serif italic）—— 4 个都随上游以 OFL 1.1 分发，可直接打包
- 尺寸：正文 12、行高 24 栅格；图标 16/24

---

## 8. 设置（90 项 → 30 项）

保留（`settings-schema.json`）：

```
外观：style, collapsedSize（自动 / 小 / 标准 / 大，见 §7 尺寸档位）, panelTheme, animationDuration, animations
收起内容：notchSummary, notchMusic, notchClock, notchMonitor, compactMonitorItems, compactWarningColor
用量：columns[]（source, statsSource, displayName, color, quotaOnline）, includeLocal, quotaAlerts
音乐：musicPage, lyricsEnabled, musicText, musicCoverColor, preferredPlayer
监控：monitorPage, monitorPalette, monitorInterval, monitorProcesses, monitorMain
行为：defaultPage, openDelay, closeDelay, hideFullscreen, maximizedBehavior, display, hotkeyExpand, hotkeyHide
其它：language, launchAtStartup
```

- **设置界面不用自己画**：Cinnamon 的 `Settings.AppletSettings(this, uuid, instance_id)` + `settings-schema.json`（`layout → page → section → keys`，控件类型 `checkbox/spinbutton/colorchooser/combobox/scale/textentry`）会自动生成 applet 配置对话框（系统参考 `/usr/share/cinnamon/applets/settings-example@cinnamon.org`）。上游 1114 行的 `SettingsWindow.cs` 只有「主题编辑器 / 列编辑器 / 价格表编辑」这三块需要自绘。
- 存储：**Cinnamon 自己的机制** —— `settings-schema.json` 运行时解析，值落 `~/.config/cinnamon/spices/mintdeck@bigmalove/<instance>.json`（`settings.js:928`），`Settings.AppletSettings.bind()` 双向绑定。不需要 `glib-compile-schemas`，也不需要 GSettings schema 安装步骤。
- 我自己只额外维护 `~/.config/mintdeck/`：`columns.json`（列配置，schema 表达不了嵌套对象）、`themes/`（用户主题文件）、`cache/`（封面、价目表）、`secrets.json`（600 权限）
- 密钥：优先 `libsecret`（`Secret.Schema`），不可用时写 600 权限文件并在 UI 标注「明文保存」

---

## 9. 里程碑（每项含验收）

| 里程碑 | 内容 | 验收（可判定） | 估时 |
| --- | --- | --- | --- |
| **M0 骨架** | applet 装上、浮层可见、三种形态几何、hover 展开/收起、Esc、主题加载 | 系统设置里能启用；三种形态尺寸与 §7 表逐值一致（截图 + `xwininfo` 尺寸核对）；切换主题颜色立即变化 | 3–4 d |
| **M1 用量** | Claude + DSH 两源（本地 JSONL）+ 配额在线（有 token 时）+ 费用估算 + 列 UI | 面板显示两列，今日/7 日 token 与 `cost-state` 手工核对一致；无 token 时显示「旧数据/未登录」而非 0 | 5–6 d |
| **M2 音乐** | MPRIS 连接、封面、歌词、进度拖动、控制按钮、多播放器 | 用任意 MPRIS 播放器播放时，歌名/封面在 1s 内出现（实测 `PropertiesChanged` 会立即触发）；暂停/播放/切歌生效；拖进度后 `Position` 在 1 个轮询周期内对齐；歌词命中率用网易云 3 条已知曲目验证 | 4 d |
| **M4 音乐页封面** | 文件型与 URL 型两种 `artUrl` 都要处理（实测两种都出现过） | 两种 scheme 都能出图，缓存目录可清理 | — |
| **M3 监控** | procfs 采样 + 每核心柱 + GPU + 网速 + TOP 进程 + 收起态读数 | CPU/内存与 `htop` 偏差 < 3%（实测采样误差本身 < 1%）；1s 刷新时 cinnamon 进程 CPU 增量 < 2%；网速与 `nload`/`ifstat` 一致（验证 Meta 网卡已被排除） | 3 d |
| **M4 设置** | `settings-schema.json`（30 项，自动配置界面）+ 主题切换 + 热键 + 自绘的主题/列编辑器（可选） | 改任一设置无需重启即生效；设置持久化跨会话；schema 生成的配置页无空白/错位 | 3 d |
| **M5 打磨** | 转场动画、全屏隐藏、多显示器、配额提醒、i18n、打包 zip | 全屏视频时自动隐藏；双屏切换正确；安装包在纯净 Mint 22.3 上可用 | 5–6 d |
| 合计 | — | — | **23–27 d**（不含缓做项） |

风险余量：+30% → **约 6 周单人**。

---

## 10. 风险与降级

| # | 风险 | 影响 | 对策 |
| --- | --- | --- | --- |
| R1 | 浮层与展开面板的 hover 桥接判定出错（抖动/无法展开） | 交互不可用 | M0 实测；用「合并矩形」判定（上游 `CollapsedHover.HashBridge` 同思路），必要时给两块 actor 之间加透明连接区 |
| R2 | St 的 CSS 子集画不出刘海「肩」与柔和阴影 | 视觉降级 | 肩用 cairo 路径自绘；阴影用 `box-shadow` 或预渲染 PNG 九宫格 |
| R3 | 自定义脚本源需要沙盒，cjs 内无法真正隔离 | 安全边界 | **另起 `cjs` 子进程**跑脚本，限时 10s、限请求数、stdout 只回 JSON；与主进程零共享 |
| R4 | applet 异常拖垮 shell | 整桌面崩 | 所有入口 try/catch + `logError`；定时器与信号在 `on_applet_removed_from_panel` 全部断开；不在 `Main.uiGroup` 留残留 actor |
| R5 | 本机 Claude 无 `.credentials.json` | 配额不可读 | 支持 `CLAUDE_CODE_OAUTH_TOKEN`；否则只显示本地用量并标注来源时间 |
| R6 | 无 `sqlite3` CLI（Cursor/ZCode 需要） | 那两个源不可用 | 有 Cursor 时用 `python3 -c` 只读桥或 `Gda`/`Sqlite` 绑定；当前本机未装 Cursor，不阻塞 |
| R7 | Cinnamon 版本差异（5.8/6.0/6.4/6.6） | API 不兼容 | `metadata.json` 声明 `cinnamon-version`；用 capability 探测（存在则用，不存在降级） |
| R8 | 高分屏缩放（DIP vs 物理像素） | 模糊/错位 | **已实现**：`_dpr` 取 `scale_factor`（本机实测 2），线宽走 `_lw()` 对齐物理像素网格、坐标走 `_snap()` |
| R9 | Soup 未 pin 版本 → 静默落到 2.4，`send_and_read` 不存在 | 网络层全挂 | 文件首行 `imports.gi.versions.Soup = '3.0'`；Cinnamon 进程内已强制，单独测试 cjs 时必须显式写 |
| R10 | 网卡重复计入（本机 `Meta` tun 与 `wlp5s0` 流量完全重复） | 网速显示翻倍 | 白名单/黑名单：排除 `lo`、`veth*`、`docker*`、`Meta`，或只统计 `operstate=up` 且非虚拟的设备 |
| R11 | Chrome 等非专业播放器的 MPRIS 元数据不规范（`artist = ['']`、无 introspection） | 界面出现空白行/反射失败 | 空值兜底；方法签名硬编码 MPRIS 规范，不用 `get_interface_info()` |

---

## 11. 许可与合规

- BrimDeck 为 **Apache-2.0**：保留 `LICENSE`、`ThirdPartyNotices.txt`、`NOTICE`（若有），README 中注明「基于 BrimDeck 的衍生作品」并列出修改点。
- 4 个字体为 **OFL-1.1**：随包分发需带各自的许可证文本（上游 `ThirdPartyNotices.txt` 已含）。
- 内置 VS Code 主题（One Dark Pro / GitHub / Dracula / Night Owl）按各自 MIT 许可移植，保留出处说明。
- 系统监控页的配色方案改编自 [ftop](https://github.com/Nongfsq/ftop)（MIT），保留致谢。

---

## 12. 下一步（等确认后开工）

1. 先做 **M0 的 3 项实测**（§3 末尾），把两处不确定钉死（hover 桥接、`@font-face`、GTop 耗时）；
2. 拉 `mintdeck@bigmalove` 骨架 + `lib/core/geometry.js`（纯逻辑，可 node 断言对齐上游常数）；
3. 用你本机真实数据跑通 Claude + DSH 两列的端到端（M1 的一半）。

**你自己就能验证的三条命令**（不装任何东西）：

```bash
# 1) cjs 能不能在进程内发 HTTPS（预期 401）
cat > /tmp/p.js <<'EOF'
imports.gi.versions.Soup = "3.0";
const S = imports.gi.Soup, L = imports.gi.GLib, loop = L.MainLoop.new(null, false);
const s = new S.Session(); const m = S.Message.new("GET", "https://api.anthropic.com/v1/models");
s.send_and_read_async(m, L.PRIORITY_DEFAULT, null, (o, r) => { print("status " + m.get_status()); loop.quit(); });
loop.run();
EOF
cjs /tmp/p.js

# 2) 当前有没有播放器在放（MPRIS）
gdbus call --session -d org.freedesktop.DBus -o /org/freedesktop/DBus \
  -m org.freedesktop.DBus.ListNames | tr ',' '\n' | grep -i mpris

# 3) 你的 DSH 用量记录（面板第一优先级数据源；本机实测 215 个会话）
find ~/.dsh-desktop/sessions -name 'session.v4.jsonl.zstd' | wc -l
zstd -dc "$(find ~/.dsh-desktop/sessions -name 'session.v4.jsonl.zstd' -printf '%T@ %p\n' \
  | sort -rn | head -1 | cut -d' ' -f2-)" | grep -m1 '"usage"'
```

---

## 13. 一句话取舍（如果只想听结论）

做：**Cinnamon applet + St 自绘 + 官方 `addChrome` 浮层 + 主题 JSON 原样复用**。
不做：SMTC/DPAPI/CDP/PDH 那一整套 Windows 通道，以及 Electron。
先做：M0（骨架 + 几何 + 主题）→ M1（Claude + DSH 两列真实数据），这两步就能看出「值不值得继续」。


---

## 14. 实施记录（M0–M3 已完成）

| 里程碑 | 状态 | 实测结果 |
| --- | --- | --- |
| M0 骨架 | ✅ | applet 装上即用；三种形态几何按 `CollapsedGeometry` 逐值输出（notch 238×32 / inset 30 / 角 12 / 肩 16）；主题切换即时生效 |
| M1 用量 | ✅ | Claude 与 DeepSeek Harness 两列真实数据上屏；DSH 218 会话首跑 5.6s（分片不卡 shell），缓存后 18ms |
| M2 音乐 | ✅ | MPRIS 自动发现播放器、歌名/状态、收起态显示标题；`Position` 1s 轮询 + 本地插值 |
| M3 监控 | ✅ | CPU/内存/GPU/网速实时刷新（1s / 2s 分级），`Meta` 虚拟网卡已排除 |
| M4 设置 | ⬜ | `settings-schema.json` 已就位（Cinnamon 自动出配置界面），主题/列编辑器未做 |
| i18n | ✅ | 四语（zh_CN 源 / zh_TW / en / ja）：画布文字即时切换（po → `i18nData.js`），设置窗口与小程序列表走 `.mo`（gettext domain = uuid）；`tests/i18n.test.js` 守漏译、占位符、裸中文与 po/词典同步 |
| M5 打磨 | ⬜ | 转场动画、配额提醒、多显示器切换、打包 zip（i18n 已完成） |

### 实施中踩到并修掉的 6 个坑（前 5 个会让 applet 起不来）

1. **GJS 的旧式 imports 不导出 `class`**：只能导出 `var`/`function`。`class Foo {}` 在 module 上根本不存在 → 全部改成 `var Foo = class Foo {}`。
2. **`imports` 有缓存**：改了 `lib/` 下的模块，`ReloadXlet` 只重新 eval `applet.js`，模块还是旧的 → 必须 `global.reexec_self()`（`Alt+F2 → r`）才能真正生效。
3. **主题文件带 `//` 注释**：8 套随包主题全部有注释，裸 `JSON.parse` 必抛 → 走 `theme.parseTheme()`（上游就是容忍注释的）。
4. **`#AARRGGBB` 不是 CSS**：`textSecondary = #9EEBEBF5` 这类 8 位十六进制 St 不认 → 统一经 `Draw.cssColor()` 转 `rgba()`。
5. **`BoxLayout` 的 `get_preferred_height()` 返回分配值**：面板高度不能靠它算（实测恒返回当前高度），按页给实测值（usage 236 / music 150 / monitor 290）。
6. **Gio 的 `FileEnumerator` 不 close 会吃光 fd**：一次刷新枚举 ~233 个 DSH 会话目录，每个枚举器持有一个 dirfd；GJS 靠 GC 回收，刷新叠几次就撞上 cinnamon 的 1024 fd 上限，进程以 `GLib-ERROR: Creating pipes for GWakeup: 打开的文件过多` abort 并落回回退模式（2026-10-29 复现：3 次刷新峰值 **788** fd，修复后 **62**）。改法：`listFiles` 里 `try/finally { en.close(null) }`；刷新加代号 `_scanToken`，旧的异步扫描链看到代号变了就作废；设置里的连点用 120ms 去抖合并。回归测试见 `tests/list-files.test.js`。
