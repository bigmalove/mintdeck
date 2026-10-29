# MintDeck

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-E5A385?style=flat-square)](LICENSE)
[![Cinnamon](https://img.shields.io/badge/Cinnamon-5.8%20%7C%206.0%20%7C%206.2%20%7C%206.4%20%7C%206.6-32A852?style=flat-square)](mintdeck@local/metadata.json)
[![Tests](https://img.shields.io/badge/tests-138%20passing-2E8B57?style=flat-square)](tests)

A Linux Mint / Cinnamon port of [BrimDeck](https://github.com/MoFeng2223/BrimDeck) (Windows 11, C# + WPF):
a Dynamic-Island-style strip that floats at the top of the screen, expands on hover, and shows
**AI coding-tool quota & usage**, **now playing** (MPRIS) and **system monitoring** in one place.

Porting rule: geometry, theme-file format and data models are 1:1 with upstream, while every
Windows-only transport (SMTC, DPAPI, PDH, CDP) is replaced by a Linux standard interface
(MPRIS, procfs, JSONL, libsoup).

<p align="center">
  <img src="docs/images/collapsed.png" alt="collapsed" width="820">
  <br>
  <sub>Collapsed: cover, quota rings, title, visualiser and clock — width hugs the content</sub>
</p>

| AI usage (expanded) | Music | System monitor |
| --- | --- | --- |
| ![usage](docs/images/usage.png) | ![music](docs/images/music.png) | ![monitor](docs/images/monitor.png) |

| Notch | Capsule | Line |
| --- | --- | --- |
| ![notch](docs/images/style-notch.png) | ![capsule](docs/images/style-capsule.png) | ![line](docs/images/style-line.png) |

中文说明见 [README.md](README.md)（更详细，包含设置、多语言与实现取舍）。

## Install

```bash
git clone https://github.com/bigmalove/mintdeck.git ~/mintdeck && cd ~/mintdeck
tools/install.sh     # symlinks the applet into ~/.local/share/cinnamon/applets/ and installs fonts
tools/enable.sh      # adds it to the panel (or: System Settings → Applets → Add → MintDeck)
```

Cinnamon rescans applets only on startup: log out and back in, or press `Alt+F2`, type `r`, Enter.

Uninstall: `tools/uninstall.sh`.

## Features

| Page | What it shows | Source |
| --- | --- | --- |
| AI usage | per tool: name + plan badge, quota slots (5h / weekly / context), today's and 7-day tokens or credits | Claude Code `~/.claude/projects/**/*.jsonl`; DeepSeek Harness `~/.dsh-desktop/sessions/**/*.jsonl.zstd`; WorkBuddy `~/.workbuddy/workbuddy.db` (`session_usage`, read-only python bridge) |
| Music | title, artist, play state; collapsed mode shows the title or the current lyric line | MPRIS (any D-Bus media player) |
| System monitor | CPU total, memory, GPU, up/down throughput | `/proc/stat`, `/proc/meminfo`, `/proc/net/dev`, `nvidia-smi` |

Size modes: **auto** (the strip's height and content scale follow how many segments are actually
drawn), plus fixed `compact` / `standard` / `large` tiers. Auto 3 segments equals standard, 5 equals
large, and both geometry and content (fonts, cover, rings, visualiser) scale together.

Interface languages: Simplified Chinese, Traditional Chinese, English, Japanese — switchable at
runtime in the applet settings (the island is drawn with St/cairo, so no shell restart is needed).

## Layout

```
mintdeck@local/            # the applet (symlinked into ~/.local/share/cinnamon/applets/)
├── applet.js              # lifecycle, hover state machine, settings binding
├── settings-schema.json   # settings (Cinnamon renders the config UI)
├── lib/core/              # pure JS: geometry, theme, log parsing, providers, pricing, i18n (node-testable)
├── lib/linux/             # MPRIS, procfs, lyrics HTTP
├── lib/deck/              # St/Clutter: collapsed strip, panel, data wiring
├── lib/ui/                # cairo rings, colour helpers
├── themes/                # 8 themes (same format as BrimDeck, interchangeable)
└── fonts/                 # 4 OFL fonts used by the clock styles

po/                        # translation source: mintdeck@local.pot + en / zh_TW / ja
tools/                     # install / enable / uninstall / dev-reload / i18n pipeline
tests/                     # node --test: geometry, auto-size, themes, logs, providers, procfs, lyrics, i18n
```

## Development

```bash
node --test tests/*.test.js     # 138 tests
tools/dev-reload.sh             # hot-reload the applet after editing code
tools/i18n.sh build             # regenerate i18nData.js and .mo after touching strings/po
```

Cinnamon's `imports` cache does not invalidate when files change; after editing `lib/**` either run
`tools/dev-reload.sh` or restart the shell with `Alt+F2` → `r`.

## Screenshots

All shots live in [`docs/images/`](docs/images) and were taken from a running Cinnamon desktop at 2x DPI:
collapsed strip, three styles (notch / capsule / line), the three panel pages, the size settings,
the four languages, and the drop shadow on dark and light wallpapers.

## License

Apache-2.0, as a derivative work of BrimDeck (Apache-2.0). See [LICENSE](LICENSE) and [NOTICE](NOTICE).
Bundled fonts are SIL OFL 1.1; the system-monitor palette is adapted from
[ftop](https://github.com/Nongfsq/ftop) (MIT).
