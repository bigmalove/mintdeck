# MintDeck 代码约定（子代理必读）

目标产物：Cinnamon applet，uuid `mintdeck@bigmalove`，装在 `~/.local/share/cinnamon/applets/mintdeck@bigmalove/`。
上游参照实现：`/mnt/E/vibecode/mintdeck/src_upstream/`（C# / WPF，只读）。
方案：`/mnt/E/vibecode/mintdeck/docs/PLAN.md`。

## 1. 模块格式（唯一允许的写法）

Cinnamon 用 **cjs 115.2**（SpiderMonkey 115），applet 通过旧式 `imports.*` 加载模块，而单元测试用 **node v24** 跑。
所以每个文件必须是「两栖」写法：

```js
// lib/core/foo.js
'use strict';

const SomeConst = 32;                      // 模块内私有，const/let 均可

function resolve(a, b) { /* ... */ }        // 需要对外暴露的函数用 function 声明

// 必须对外暴露的名字：末尾显式挂到 module.exports（node）与全局（cjs 旧式 imports 用文件名当模块名）
if (typeof module !== 'undefined') module.exports = { SomeConst, resolve };
```

规则：

- **不要用 `export` / `import` 语句**。cjs 的 ESM 支持与 Cinnamon 的 `imports.*` 加载器不兼容，混用会炸。
- **不要 `require()`**。node 侧测试文件才 `require`。
- **不要碰 `imports.gi.*`**。`lib/core/**` 必须是纯 JS（无 GI、无文件系统），这样 node 能直接跑。
- 需要文件/网络/DBus 的代码放 `lib/linux/**`，那边可以用 GI，但同样要 `if (typeof module !== 'undefined')` 保护。
- 中文注释，讲「为什么」，不要复述代码。

## 2. 文件命名与职责

| 目录 | 职责 | 允许依赖 |
| --- | --- | --- |
| `lib/core/**` | 纯逻辑：几何、主题、解析、计费 | 只能 require 同目录文件 |
| `lib/linux/**` | Linux 通道：procfs、MPRIS、Soup、子进程 | `imports.gi.*` |
| `lib/deck/**` | St/Clutter UI | `imports.gi.St`、`lib/core`、`lib/linux` |
| `lib/ui/**` | 自绘控件（环、柱、缓动条） | `imports.gi.St`、`St.DrawingArea` + cairo |

资源约定（真的会把 cinnamon 弄崩，不是洁癖）：

- **Gio 的 `FileEnumerator` 用完必须 `close(null)`**，放在 `finally` 里。每个枚举器持有一个 dirfd，
  GJS 靠 GC 回收 —— 一次刷新枚举几百个目录就会把 cinnamon 的 1024 个 fd 用完
  （`GLib-ERROR: Creating pipes for GWakeup: 打开的文件过多`）。回归见 `tests/list-files.test.js`。
- **外部命令一律走 `lib/linux/exec.js`**（`Gio.Subprocess` + `communicate_utf8_async`）：argv 形式、
  不经 shell、按 PATH 解析、全程异步。同步 spawn（名字里带 sync 的那几个）会把 shell 主线程按住 ——
  nvidia-smi 冷启动三百毫秒起，面板期间完全不响应；而且 `cinnamon-settings` 的源码扫描
  （`ExtensionCore.py:32` 的 `UNSAFE_ITEMS`）会给整个 applet 挂黄三角。回归见 `tests/exec-safety.test.js`。
- 批量文件（zstd 解压几百个会话）靠 `data.js` 的「缓存命中先跳过 + 同时只跑一个子进程」那套，
  别为了快就并发起一堆进程。
- 定时器、`GLib.idle_add` 的 source id 要存下来，销毁时 `source_remove`（applet 里 `_clockTimer` /
  `_refreshTimer` / `_openTimer` 都是这个模式）。

## 3. 视觉常量必须与上游逐值一致

一切尺寸、圆角、颜色键名以 `src_upstream/src/BrimDeck.Core/CollapsedGeometry.cs`、`Themes/*.json` 为准。
**不要自行「优化」数值**，也不要引入 4px 栅格之类的新规则。上游写 238×32 就是 238×32。

## 4. 测试

- 测试文件放 `/mnt/E/vibecode/mintdeck/tests/`，命名 `*.test.js`，用 `node:test` + `node:assert/strict`。
- 跑法：`cd /mnt/E/vibecode/mintdeck && node --test tests/`
- 断言必须带**上游出处**（如 `// CollapsedGeometry.cs:11`），失败信息写人话。

## 5. 界面文案（i18n）

- **所有用户可见的文字走 `lib/core/i18n.js`**：`const _ = I18n.t;` + `_(`中文原文`)`；复数用 `I18n.tn(单数, 复数, n)`。
  msgid 就是简体中文原文，不另造 key 表。细则见 `docs/I18N.md`。
- **占位符只用 `%s` / `%d`**，参数按顺序代入；`po/*.po` 的 msgstr 必须保留同样数量。
- **不要拿译文做逻辑判断**。状态用状态码（`statusCode: 'error' | 'loading'`），播放态用布尔 `playing`；
  `statusText.indexOf('读取失败')` 这种写法一换语言就失效。
- **不要在模块顶层写已翻译常量**：`imports` 在 applet 构造前执行，此时 locale 还没定。
  要么在绘制/调用时 `_()`，要么用函数包一层（多余的顶层表见 `panel.js` 的注释）。
- **列宽/行高按译文实测**，不要按汉字数写死（`今日/七日` 曾用 `12×2.7` 的常量，英文会压字）。
- 改完文案：`tools/i18n.sh update` → 填 msgstr → `tools/i18n.sh build` → `node --test tests/`。

## 6. 禁止

- 不改 `/mnt/E/vibecode/mintdeck/src_upstream/`（只读参照）。
- 不装 npm 包、不动 git、不写 `/mnt/E/vibecode/mintdeck/mintdeck@bigmalove/lib/deck/**`（那部分由主线程负责）。
- 不输出真实 token / cookie / 邮箱；测试夹具用假数据。
