// tests/list-files.test.js
// 回归：listFiles() 必须显式关闭目录枚举器。
//
// 起因（2026-10-29 真机崩溃）：Cinnamon 进程以
//   GLib-ERROR: Creating pipes for GWakeup: 打开的文件过多
// abort，落回回退模式。原因是一次数据刷新要枚举 ~233 个 DSH 会话目录，每个
// Gio.FileEnumerator 都持有一个 dirfd，而代码没 close —— GJS 靠 GC 回收，
// 连续几次刷新（切语言 / 连点刷新）就把 1024 个 fd 用完。
//
// 这里用一套假 Gio 把 listFiles 拉进 node：断言每个目录的枚举器都被 close，
// 并且 next_file 抛异常时也要 close（finally）。

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// ---- 假文件系统：root/{a,b,c}/*.zstd + root/one.zstd + root/notes.txt
const TREE = {
  '/root': [['a', 'dir'], ['b', 'dir'], ['c', 'dir'], ['one.zstd', 'file'], ['notes.txt', 'file']],
  '/root/a': [['a1.zstd', 'file'], ['a2.zstd', 'file']],
  '/root/b': [['b1.zstd', 'file']],
  '/root/c': [['c1.zstd', 'file']],
};

const enumerators = [];          // 每次 enumerate_children 生成的枚举器，用来查 close
let throwOnDir = null;           // 测试用：让指定目录的枚举器在第二次 next_file 抛异常

function makeEnumerator(dir) {
  const rows = (TREE[dir] || []).slice();
  let i = 0;
  const en = {
    dir: dir,
    closed: false,
    throwAt: -1,                 // 测试用：第 N 次 next_file 抛异常
    calls: 0,
    next_file() {
      if (this.throwAt >= 0 && this.calls === this.throwAt) {
        this.calls++;
        throw new Error('boom');
      }
      this.calls++;
      if (i >= rows.length) return null;
      const [name, type] = rows[i++];
      return {
        get_name: () => name,
        get_file_type: () => (type === 'dir' ? 'DIR' : 'FILE'),
        get_modification_time: () => ({ tv_sec: 1000, tv_usec: 0 }),
      };
    },
    get_child: (info) => ({ get_path: () => dir + '/' + info.get_name() }),
    close() {
      this.closed = true;
      return true;
    },
  };
  if (dir === throwOnDir) en.throwAt = 1;
  enumerators.push(en);
  return en;
}

// ---- 桩：只够 data.js 顶层与 listFiles 用
const hadImports = 'imports' in global;
global.imports = {
  gi: {
    GLib: {
      get_home_dir: () => '/home/fake',
      get_user_cache_dir: () => '/tmp/fake-cache',
      build_filenamev: (parts) => parts.join('/'),
      file_get_contents: () => [false, null],
      spawn_command_line_sync: () => [false, null],
      PRIORITY_DEFAULT_IDLE: 0,
      PRIORITY_DEFAULT: 0,
      get_monotonic_time: () => 0,
      idle_add: () => 0,
      shell_quote: (s) => s,
      mkdir_with_parents: () => 0,
      file_set_contents: () => true,
    },
    Gio: {
      File: { new_for_path: (p) => ({ enumerate_children: () => makeEnumerator(p) }) },
      FileQueryInfoFlags: { NONE: 0 },
      FileType: { DIRECTORY: 'DIR', REGULAR: 'FILE' },
    },
  },
  lib: {
    ui: { draw: require(path.join(__dirname, '..', 'mintdeck@bigmalove', 'lib', 'ui', 'draw.js')) },
    core: {
      i18n: require(path.join(__dirname, '..', 'mintdeck@bigmalove', 'lib', 'core', 'i18n.js')),
      providers: {
        claude: { parseSession: () => null, summarize: () => ({}) },
        dsh: { parseSession: () => null, summarize: () => ({}) },
        workbuddy: { summarize: () => ({}), fmtCredits: (v) => String(v) },
      },
    },
    deck: {},
  },
};

const Data = require(path.join(__dirname, '..', 'mintdeck@bigmalove', 'lib', 'deck', 'data.js'));
if (!hadImports) delete global.imports;

test('listFiles 递归收集 .zstd，并且每个目录的枚举器都被 close', () => {
  enumerators.length = 0;
  const list = Data.listFiles('/root', '.zstd', []);

  assert.deepEqual(list.map((f) => f.path).sort(), [
    '/root/a/a1.zstd', '/root/a/a2.zstd', '/root/b/b1.zstd', '/root/c/c1.zstd', '/root/one.zstd',
  ]);
  // root + a + b + c 四个目录，一个都不能漏关
  assert.equal(enumerators.length, 4);
  assert.deepEqual(enumerators.map((e) => e.dir).sort(), ['/root', '/root/a', '/root/b', '/root/c']);
  assert.deepEqual(enumerators.filter((e) => !e.closed), [], '有枚举器没关：这些 dirfd 会一直占着，刷新几次就把 cinnamon 的 fd 用完');
});

test('next_file 抛异常时枚举器仍然被关闭（finally）', () => {
  enumerators.length = 0;
  throwOnDir = '/root/a';
  try {
    assert.throws(() => Data.listFiles('/root', '.zstd', []), /boom/);
  } finally {
    throwOnDir = null;
  }
  const broken = enumerators.find((e) => e.dir === '/root/a');
  assert.ok(broken, '假枚举器没生成');
  assert.equal(broken.closed, true, '抛异常时 finally 也要 close，否则一次失败的刷新就漏一个 dirfd');
});
