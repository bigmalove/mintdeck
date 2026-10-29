'use strict';

// tests/exec-safety.test.js —— applet 目录的「危险调用」扫描回归。
//
// 出处：cinnamon-settings 打开后会对每个 applet 目录做一次源码扫描，
// /usr/share/cinnamon/cinnamon-settings/bin/ExtensionCore.py:32
//   UNSAFE_ITEMS = ['spawn_sync', 'spawn_command_line_sync', 'GTop', 'get_file_contents_utf8_sync']
// 只要任何 .js 里出现这些子串（注释也算），管理器就在该行右边挂一个黄色三角
// （xsi-dialog-warning-symbolic，"could potentially cause Cinnamon to crash or freeze"）。
//
// 同步 spawn 确实会冻结 shell —— 我们改用异步的 Gio.Subprocess（lib/linux/exec.js），
// 这条测试盯着别有人再把同步调用写回来。

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const APPLET = path.join(__dirname, '..', 'mintdeck@bigmalove');

// 与 ExtensionCore.py:32 逐字一致，不要「顺手扩充」——多一条就会和 cinnamon 的判定对不上
const UNSAFE_ITEMS = ['spawn_sync', 'spawn_command_line_sync', 'GTop', 'get_file_contents_utf8_sync'];

function collectJsFiles(dir, out) {
  out = out || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('applet 目录里没有任何会触发 cinnamon 黄三角的调用', () => {
  const hits = [];
  for (const file of collectJsFiles(APPLET)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const unsafe of UNSAFE_ITEMS) {
      let at = text.indexOf(unsafe);
      while (at >= 0) {
        const line = text.slice(0, at).split('\n').length;
        hits.push(path.relative(APPLET, file) + ':' + line + ' -> ' + unsafe);
        at = text.indexOf(unsafe, at + 1);
      }
    }
  }
  assert.deepEqual(hits, [],
    'ExtensionCore.py:32 的 UNSAFE_ITEMS 命中会挂黄三角；子进程请走 lib/linux/exec.js（Gio.Subprocess 异步）');
});

test('lib/linux/exec.js：没有 Gio 时立刻回调 missing，不抛、不挂', () => {
  const Exec = require(path.join(APPLET, 'lib', 'linux', 'exec.js'));
  let got = null;
  const handle = Exec.run(['definitely-not-a-real-binary-xyz'], (text, code) => { got = { text: text, code: code }; });
  assert.equal(handle, null, 'node 里没有 imports.gi，应当同步失败并返回 null');
  assert.deepEqual(got, { text: null, code: 'missing' });
});

test('lib/linux/exec.js：空 argv 直接 missing，不会去 spawn 东西', () => {
  const Exec = require(path.join(APPLET, 'lib', 'linux', 'exec.js'));
  let got = null;
  Exec.run([], (text, code) => { got = code; });
  assert.equal(got, 'missing');
  assert.doesNotThrow(() => Exec.cancelAll());
});
