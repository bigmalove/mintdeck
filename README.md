# MintDeck

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-E5A385?style=flat-square)](LICENSE)
[![Cinnamon](https://img.shields.io/badge/Cinnamon-5.8%20%7C%206.0%20%7C%206.2%20%7C%206.4%20%7C%206.6-32A852?style=flat-square)](mintdeck@local/metadata.json)
[![Tests](https://img.shields.io/badge/tests-138%20passing-2E8B57?style=flat-square)](tests)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?style=flat-square&logo=node.js&logoColor=white)](tests)

Cinnamon 桌面上的「灵动岛」：屏幕顶部一条悬浮的小黑条，鼠标移上去展开，集中显示 **AI 编程工具的额度与用量**、**正在播放的音乐**、**系统监控**。

<p align="center">
  <img src="docs/images/collapsed.png" alt="收起态" width="820">
  <br>
  <sub>收起态：封面 / 配额环 / 标题 / 律动条 / 时钟，宽度贴着内容自动伸缩</sub>
</p>

这是 [BrimDeck](https://github.com/MoFeng2223/BrimDeck)（Windows 11 / C# + WPF）的 Linux Mint 复刻：几何参数、主题文件格式、数据模型都按上游 1:1 移植，Windows 专有的通道（SMTC、DPAPI、PDH、CDP）换成 Linux 的标准接口（MPRIS、procfs、JSONL、Soup）。

英文说明：[README.en.md](README.en.md)（同样的安装步骤，简述功能与目录）

| AI 用量（展开面板） | 音乐 | 系统监控 |
| --- | --- | --- |
| ![AI 用量](docs/images/usage.png) | ![音乐](docs/images/music.png) | ![系统监控](docs/images/monitor.png) |

三种外观（同一份内容，只换「外观」设置）：

| 刘海 notch | 胶囊 capsule | 指示条 line |
| --- | --- | --- |
| ![刘海](docs/images/style-notch.png) | ![胶囊](docs/images/style-capsule.png) | ![指示条](docs/images/style-line.png) |

深色壁纸上的收起态与投影：

| 深色 | 浅色 |
| --- | --- |
| ![深色](docs/images/shadow-dark.png) | ![浅色](docs/images/shadow-light.png) |

## 安装

```bash
git clone https://github.com/bigmalove/mintdeck.git ~/mintdeck && cd ~/mintdeck
tools/install.sh          # 软链到 ~/.local/share/cinnamon/applets/，并装字体
tools/enable.sh           # 加进面板（也可用「系统设置 → 小程序 → 添加 → MintDeck」）
```

装完屏幕顶部中央就会出现刘海。首次添加 applet 需要 Cinnamon 重新扫描一次：注销重登，或按 `Alt+F2` 输入 `r` 回车。

卸载：`tools/uninstall.sh`

## 现在能做什么

| 页面 | 内容 | 数据来源 |
| --- | --- | --- |
| AI 用量 | 每列：工具名 + 套餐徽章、配额槽（5 小时 / 每周 / 上下文）、今日与七日的 Token 或积分 | Claude Code：`~/.claude/projects/**/*.jsonl`；DeepSeek Harness：`~/.dsh-desktop/sessions/**/*.jsonl.zstd`；WorkBuddy：`~/.workbuddy/workbuddy.db` 的 `session_usage`（经 python3 只读桥）+ `storage/skeleton/account-snapshot.json` |
| 音乐 | 歌名、歌手、播放状态；收起态显示标题或当前歌词 | MPRIS（任何支持 D-Bus 媒体控制的播放器） |
| 系统监控 | CPU 总值、内存、GPU、上下行网速（收起态可显示读数） | `/proc/stat`、`/proc/meminfo`、`/proc/net/dev`、`nvidia-smi` |

费用按会话累计的 `totalCostUSD`（Claude 的 `cost-state` 行）取**每个会话最后一条**，按文件 mtime 归入今日/本周，不跨状态相加。

## 设置

系统设置 → 小程序 → MintDeck → 配置。收起态尺寸默认 **自动**：岛的高矮和内容（字体、封面、配额环、律动条、间隙）
跟着「当前真的画出来的段数」走 —— 只有时钟时是一枚 24 高的小刘海，封面 / 配额环 / 标题 / 律动 / 时钟齐全才长到 40 高；
宽度永远贴着内容，两侧只留 `16 + 10×缩放`，不会再出现内容缩在中间、两边一片空的情况。
不喜欢它变来变去，可以固定成三档之一：

| 档位 | 刘海 | 胶囊 | 指示条 | 内容缩放 |
| --- | --- | --- | --- | --- |
| 自动 auto | 高 24–40，宽 = 内容 + 2×(16 + 10×缩放) | 同上（留白 10 而非 16） | 长 44–72、厚 3–5 | 0.75 / 0.875 / 1 / 1.125 / 1.25（1–5 段） |
| 小 compact | 200×26 | 172×26 | 44×3 | 0.8125（字 9.5px、封面 16px、环 14.6px） |
| 标准 standard | 238×32 | 196×32 | 56×4 | 1.0（与上游默认逐值一致） |
| 大 large | 282×40 | 232×40 | 72×5 | 1.25（字 14.5px、封面 25px、环 22.5px） |

自动档的 3 段正好等于标准档、5 段等于大档；三档同时驱动表面几何和内容（字体、封面、配额环、律动条、间隙），
宽度都按内容自动计算 —— 所以换成大档时字和图标会真的跟着变大，而不是只多出一圈黑边。像素级微调已移除：
它们以前只改矩形、不改内容，改了等于没改。

![收起尺寸设置](docs/images/settings-size.png)

三档实际效果（同一份内容：封面 + 两个配额环 + 标题 + 律动条 + 时钟）：

![三档对比](docs/images/size-tiers.png)

> Cinnamon 的 `imports` 缓存不随文件变化失效：改完 `lib/**` 要么 `tools/dev-reload.sh`，
> 要么 `Alt+F2` → `r`；只重载 xlet 时 `lib/deck/island.js` 仍是旧版。

## 多语言

界面支持 **简体中文 / 繁體中文 / English / 日本語**，默认跟随系统语言，也可以在
`系统设置 → 小程序 → MintDeck → 外观 → 界面语言` 里单独指定。

- 悬浮岛、展开面板、右键菜单是 applet 自己用 St/cairo 画的，译文查 `lib/core/i18nData.js`，
  **在设置里换语言立即生效**，不用重启 Cinnamon，也不用改系统 locale。
- 设置窗口与小程序列表里的名字/简介由 Cinnamon 的 `xlet-settings`（Python）渲染，走 gettext：
  同一批 po 编出的 `.mo` 由 `tools/install.sh` 装到 `~/.local/share/locale/<locale>/LC_MESSAGES/mintdeck@local.mo`。
- 文案只有一份来源 `po/*.po`：msgid 就是简体中文原文，`tools/i18n-build.py` 一次生成
  `i18nData.js`（画布用）与 `.mo`（gettext 用）。细节与「加一门语言」的步骤见
  [docs/I18N.md](docs/I18N.md)。

| 简体中文 | English |
| --- | --- |
| ![简体中文](docs/images/i18n-zh_CN.png) | ![English](docs/images/i18n-en.png) |

| 繁體中文 | 日本語 |
| --- | --- |
| ![繁體中文](docs/images/i18n-zh_TW.png) | ![日本語](docs/images/i18n-ja.png) |

> 状态文案不再按字符串判断：读数状态用 `statusCode`（`error` / `loading`），播放态用布尔 `playing`。
> 以前 `statusText.indexOf('读取失败')` 这种写法一换语言就失效。

> 设置窗口本身跟随系统语言（`xlet-settings` 是独立进程，gettext 在启动时绑定 locale）；
> 悬浮岛与面板则按上面的设置即时切换。

## 为什么这样实现

- **浮层用 Cinnamon 官方 API**：`Main.layoutManager.addChrome(actor, {visibleInFullscreen, affectsInputRegion})`。它自动把 actor 放到 chrome 层、把矩形并入 stage 输入区域（所以不会挡住下面窗口的点击）、并按所在显示器是否全屏自动隐藏 —— 上游用 `WS_EX_NOACTIVATE` + 400ms z-order 轮询 + `WS_EX_TRANSPARENT` 做的事，这里一行不用写。
- **单进程**：applet 跑在 `cinnamon` 进程里，UI 用 St/Clutter 自绘。另起 GTK 进程能换来视觉自由度，但要多 60–90MB 常驻，与上游「原生低占用」的取向相反。
- **纯逻辑与 UI 分离**：`lib/core/**` 不碰 GI，`node --test` 直接跑；UI 与 Linux 通道各一层，坏一个不影响另一个。
- **两栖模块写法**：Cinnamon 用 `imports.lib.xxx`（旧式加载器，只导出 `var`/`function`），测试用 `node` 的 `module.exports`。所以每个文件同时满足两边，不用构建步骤。

## 开发

```bash
node --test tests/*.test.js     # 测试：几何/自动尺寸/主题/日志/供应商/procfs 解析/歌词/多语言
tools/dev-reload.sh             # 改完代码热重载 applet
tools/i18n.sh build             # 改过文案或 po 之后：重生成 i18nData.js 与 .mo
```

改 `lib/` 里的模块后，Cinnamon 的 `imports` 缓存不会失效 —— 这时要 `Alt+F2 → r` 重启一次 shell，否则看到的还是旧代码。

目录：

```
mintdeck@local/            # applet 本体（安装时软链到 ~/.local/share/cinnamon/applets/）
├── applet.js              # 生命周期、hover 状态机、设置绑定
├── settings-schema.json   # 设置项（Cinnamon 自动生成配置界面）
├── lib/core/              # 纯 JS：几何、主题、日志解析、供应商、计价、i18n（node 可测）
├── lib/linux/             # MPRIS、procfs、歌词 HTTP
├── lib/deck/              # St/Clutter：收起态、面板、数据接线
├── lib/ui/                # cairo 画环、颜色工具
├── themes/                # 8 套主题（与 BrimDeck 同格式，可直接互换）
└── fonts/                 # 4 个 OFL 字体（时钟样式用）

po/                        # 翻译源：mintdeck@local.pot + en / zh_TW / ja
tools/i18n-*.py            # 抽 msgid → pot、pot → i18nData.js + .mo
```

## 已知限制

- **全屏与 hover 互斥**：`visibleInFullscreen: false` 时 actor 会被移出输入区域，全屏应用下鼠标唤不出来。这是上游「全屏免打扰」的同一取舍，暂时没有开关。
- **输入区域是矩形**：刘海底部的 12px 圆角处仍会吃掉点击（St 的 input region 只支持矩形并集）。
- **指示条**：用主题的 `indicator`/`indicatorProgress` 两色（上游同名字段）。浅色主题下底色 `#AEAEB2` 在浅色桌面上很淡，有播放时那截深色进度段才是它最显眼的部分。
- **CSD 阴影**：`box-shadow` 由 St 渲染，在极暗壁纸上几乎看不见。
- **高 DPI**：已按 `St.ThemeContext.scale_factor` 处理（本机 2x 实测），线宽对齐物理像素网格（`1/dpr` 的整数倍），不会出现 1px 描边糊掉。
- **Claude 配额**：本机没有 `~/.claude/.credentials.json` 时不请求在线配额，只显示本地用量（标「最近记录 N 天前」）。有 `CLAUDE_CODE_OAUTH_TOKEN` 时才会走 `api.anthropic.com/api/oauth/usage`。
- **WorkBuddy 配额**：5 小时 / 每周额度只在服务端（`/billing/meter/get-user-resource-summary` 等），本地没有任何缓存，也不解 Chromium 的加密 cookie —— 所以这一列只给「上下文占用 + 积分消耗」，配额槽显示 `—`。本地用量字段语义：`session_usage.used/size` 是**最近一次请求的上下文占用/窗口**（不是累计），`credit_json` 求和才是该会话消耗的积分。
- **DSH 首次启动慢**：218 个会话要逐个 `zstd -dc`，约 5.6s，分片跑不卡 shell；解析结果缓存在 `~/.cache/mintdeck/usage-cache.json`（3.8MB），第二次 18ms。
- 未移植：模型明细页、日期范围统计、主题编辑器 GUI、自定义脚本源、价格表自动同步、WSL 跨系统读取。

## 许可

本项目是 [BrimDeck](https://github.com/MoFeng2223/BrimDeck)（Apache-2.0）的衍生作品，同样以 [Apache License 2.0](LICENSE) 发布；上游版权与第三方声明见 [NOTICE](NOTICE)。
随包的 4 个字体（Orbitron / Bebas Neue / Unbounded / Instrument Serif）为 SIL Open Font License 1.1。
系统监控页的配色方案改编自 [ftop](https://github.com/Nongfsq/ftop)（MIT）。

本仓库不包含 `src_upstream/`（上游 C# / WPF 源码的只读参照克隆），只保留移植结果。

## 截图

全部截图在 [`docs/images/`](docs/images)，都是从运行中的 Cinnamon 桌面直接截的图（2x DPI）：

| 文件 | 内容 |
| --- | --- |
| `collapsed.png` / `collapsed-dark.png` | 收起态：内容自动伸缩的黑条 |
| `style-notch.png` / `style-capsule.png` / `style-line.png` | 三种外观：刘海 / 胶囊 / 指示条 |
| `usage.png` | 展开面板 → AI 用量页（配额槽 + 今日/七日 Token 或积分） |
| `music.png` | 展开面板 → 音乐页（MPRIS，含歌词） |
| `monitor.png` | 展开面板 → 系统监控页（CPU / 内存 / GPU / 网速） |
| `settings-size.png` / `size-tiers.png` | 设置里的尺寸档位与实际三档对比 |
| `i18n-zh_CN.png` / `i18n-zh_TW.png` / `i18n-en.png` / `i18n-ja.png` | 四种界面语言 |
| `shadow-dark.png` / `shadow-light.png` | 深色 / 浅色壁纸下的投影 |

