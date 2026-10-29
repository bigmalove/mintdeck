// tests/sysmon.test.js — lib/linux/sysmon.js 的纯解析函数。
// 这里只测不碰 GI 的部分（parseMeminfo / parseNetDev / pickNetworkInterface / sampleCpu），
// 因为 node 里没有 imports.gi；带 GI 的读文件与 GTop 由 cjs 实跑验收（见交付说明）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const sysmon = require('../mintdeck@bigmalove/lib/linux/sysmon.js');

// 真实 /proc/meminfo 的片段（本机 32GB + 8GB swap，实测 52.5%–54% 之间浮动）。
const MEMINFO = [
  'MemTotal:       32616532 kB',
  'MemFree:         1062256 kB',
  'MemAvailable:   15009492 kB',
  'Buffers:          136520 kB',
  'Cached:          9920196 kB',
  'SwapCached:       142332 kB',
  'SwapTotal:       8388604 kB',
  'SwapFree:        5214492 kB',
  ''
].join('\n');

// 真实 /proc/net/dev 的形状（本机）：lo + 一块 down 的 enp6s0 + wlp5s0 + 与 wlp5s0 流量重复的 Meta tun。
const NETDEV = [
  'Inter-|   Receive                                                |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
  '    lo: 4824512208 2665755    0    0    0     0          0         0 4824512208 2665755    0    0    0     0       0          0',
  'enp6s0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0',
  'wlp5s0: 9631352104 8881691    0   13    0     0          0         0 2487305768 3814720    0    0    0     0       0          0',
  '  Meta: 8134690754 3324526    0    0    0     0          0         0 2007003798 2747452    0    0    0     0       0          0',
  'docker0: 1234 10 0 0 0 0 0 0 5678 20 0 0 0 0 0 0',
  'virbr0: 4321 11 0 0 0 0 0 0 8765 21 0 0 0 0 0 0',
  'veth9a: 999 9 0 0 0 0 0 0 888 8 0 0 0 0 0 0',
  ''
].join('\n');

test('parseMeminfo：用 MemAvailable 算已用比例（PLAN.md §6.3 内存行）', () => {
  const m = sysmon.parseMeminfo(MEMINFO);
  assert.equal(m.totalKb, 32616532);
  assert.equal(m.availableKb, 15009492);
  assert.equal(m.usedKb, 32616532 - 15009492);
  // 100 * (1 - available/total)，与 §6.3 的公式一致
  assert.ok(Math.abs(m.usedPercent - 100 * (1 - 15009492 / 32616532)) < 1e-9);
  assert.ok(m.usedPercent > 50 && m.usedPercent < 56, '本机实测在 52%–54% 量级');
  assert.equal(m.swapTotalKb, 8388604);
  assert.equal(m.swapFreeKb, 5214492);
  assert.ok(Math.abs(m.swapUsedPercent - 100 * (1 - 5214492 / 8388604)) < 1e-9);
});

test('parseMeminfo：没有 MemTotal 就是无数据，返回 null 而不是 0', () => {
  assert.equal(sysmon.parseMeminfo(''), null);
  assert.equal(sysmon.parseMeminfo('MemFree: 123 kB\n'), null);
});

test('parseMeminfo：老内核没有 MemAvailable 时退回 free+buffers+cached', () => {
  const m = sysmon.parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 150 kB\n');
  assert.equal(m.availableKb, 300);
  assert.equal(m.usedPercent, 70);
  assert.equal(m.swapTotalKb, 0);
  assert.equal(m.swapUsedPercent, 0, '无 swap 时已用比例给 0，不做除法');
});

test('parseNetDev：默认排除 lo / Meta / veth* / docker* / br-* / virbr*（PLAN.md §6.3 网速行）', () => {
  const n = sysmon.parseNetDev(NETDEV);
  // 只有 enp6s0(0) 与 wlp5s0 计入
  assert.equal(n.rxBytes, 9631352104 + 0);
  assert.equal(n.txBytes, 2487305768 + 0);
  assert.deepEqual(n.ifaces, ['enp6s0', 'wlp5s0']);
  assert.ok(n.ifaces.indexOf('Meta') < 0, 'Meta tun 与 wlp5s0 流量重复，计入会翻倍');
  assert.ok(n.ifaces.indexOf('lo') < 0);
});

test('parseNetDev：白名单模式只认给的名字', () => {
  const n = sysmon.parseNetDev(NETDEV, ['wlp5s0']);
  assert.equal(n.rxBytes, 9631352104);
  assert.equal(n.txBytes, 2487305768);
  assert.deepEqual(n.ifaces, ['wlp5s0']);
});

test('parseNetDev：排除虚拟前缀但保留裸名字（br0 与 br-* 都是虚拟）', () => {
  assert.equal(sysmon.isExcludedIface('br0'), false, 'br0 不在默认前缀表里，按实测本机没有该接口');
  assert.equal(sysmon.isExcludedIface('br-abc123'), true);
  assert.equal(sysmon.isExcludedIface('veth9a'), true);
  assert.equal(sysmon.isExcludedIface('docker0'), true);
  assert.equal(sysmon.isExcludedIface('virbr0'), true);
  assert.equal(sysmon.isExcludedIface('Meta'), true, '大小写不敏感');
  assert.equal(sysmon.isExcludedIface('wlp5s0'), false);
});

test('parseNetDev：真实 /proc/net/dev 求和 == 独立累加（证明没有多算 Meta）', () => {
  const text = fs.readFileSync('/proc/net/dev', 'utf8');
  const parsed = sysmon.parseNetDev(text);
  // 测试自己再解析一遍，避免用被测函数的判断当标准答案
  let rx = 0;
  let tx = 0;
  for (const row of text.split('\n')) {
    const cut = row.indexOf(':');
    if (cut < 0) continue;
    const name = row.slice(0, cut).trim();
    if (!name || name === 'lo' || name === 'Meta' || /^(veth|docker|br-|virbr)/.test(name)) continue;
    const f = row.slice(cut + 1).trim().split(/\s+/);
    rx += Number(f[0]);
    tx += Number(f[8]);
  }
  assert.equal(parsed.rxBytes, rx);
  assert.equal(parsed.txBytes, tx);
  assert.ok(parsed.ifaces.indexOf('Meta') < 0);
  assert.ok(parsed.ifaces.indexOf('lo') < 0);
  assert.ok(parsed.rxBytes > 0, '本机 wlp5s0 有流量');
});

test('pickNetworkInterface：选 up 且非虚拟的那张（真实 /proc/net/dev + 假 operstate 读取器）', () => {
  const states = { enp6s0: 'down', wlp5s0: 'up' };
  const read = (path) => {
    const m = /\/sys\/class\/net\/([^/]+)\/operstate$/.exec(path);
    return m && states[m[1]] !== undefined ? states[m[1]] : null;
  };
  assert.equal(sysmon.pickNetworkInterface(NETDEV, read), 'wlp5s0');
});

test('pickNetworkInterface：operstate 文件不存在就当 up', () => {
  const read = () => null;
  const text = 'lo: 1 2 0 0 0 0 0 0 3 4 0 0 0 0 0 0\neth9: 1 2 0 0 0 0 0 0 3 4 0 0 0 0 0 0\n';
  assert.equal(sysmon.pickNetworkInterface(text, read), 'eth9', 'lo 仍被排除，缺失 operstate 视为 up');
});

test('pickNetworkInterface：全 down 返回 null（不给编造的默认网卡）', () => {
  const text = 'eth9: 1 2 0 0 0 0 0 0 3 4 0 0 0 0 0 0\n';
  assert.equal(sysmon.pickNetworkInterface(text, () => 'down'), null);
  assert.equal(sysmon.pickNetworkInterface('', () => 'up'), null);
});

// /proc/stat 夹具：cpu 行 8 个字段，核心各一行（顺序故意写乱，函数应按 index 排好）。
function statLine(name, user, nice, system, idle, iowait, irq, softirq, steal) {
  return [name, user, nice, system, idle, iowait, irq, softirq, steal].join(' ');
}

const STAT_A = [
  statLine('cpu', 1000, 0, 500, 8000, 100, 0, 50, 0),
  statLine('cpu1', 100, 0, 50, 800, 10, 0, 5, 0),
  statLine('cpu0', 200, 0, 100, 700, 20, 0, 10, 0),
  ''
].join('\n');

const STAT_B = [
  // 总：user +100 system +100 iowait +0 → Δtotal=200 Δidle=0 → 100%
  statLine('cpu', 1100, 0, 600, 8000, 100, 0, 50, 0),
  // cpu1：Δtotal=100，Δidle=50+0 → 50%
  statLine('cpu1', 150, 0, 50, 850, 10, 0, 5, 0),
  // cpu0：Δtotal=100，Δ(idle+iowait)=70 → 30%
  statLine('cpu0', 230, 0, 100, 760, 30, 0, 10, 0),
  ''
].join('\n');

test('sampleCpu：100*(1-Δ(idle+iowait)/Δtotal)，总 100% / 核 50% 与 30%（PLAN.md §6.3 CPU 行）', () => {
  const s = sysmon.sampleCpu(STAT_A, STAT_B);
  assert.ok(Math.abs(s.total - 100) < 1e-9, 'total 应为 100%，实得 ' + s.total);
  assert.equal(s.perCore.length, 2, '按 cpu0、cpu1 的 index 排序');
  // 浮点：100*(1-70/100) 会给出 30.000000000000004，按 1e-9 比较
  assert.ok(Math.abs(s.perCore[0] - 30) < 1e-9, 'cpu0 应为 30%，实得 ' + s.perCore[0]);
  assert.ok(Math.abs(s.perCore[1] - 50) < 1e-9, 'cpu1 应为 50%，实得 ' + s.perCore[1]);
});

test('sampleCpu：iowait 计入 idle（iowait 期间核心没干活，算忙会虚高）', () => {
  const a = statLine('cpu', 0, 0, 0, 0, 0, 0, 0, 0) + '\n';
  const b = statLine('cpu', 0, 0, 0, 0, 100, 0, 0, 0) + '\n';   // 只有 iowait 增长
  const s = sysmon.sampleCpu(a, b);
  assert.equal(s.total, 0, '纯 iowait 不该显示成 100% 忙');
});

test('sampleCpu：首帧无基线返回 {total:0, perCore:[]}', () => {
  assert.deepEqual(sysmon.sampleCpu('', STAT_A), { total: 0, perCore: [] });
  assert.deepEqual(sysmon.sampleCpu(undefined, STAT_A), { total: 0, perCore: [] });
});

test('sampleCpu：计数回退（休眠/热插拔）不产生负数或 NaN', () => {
  const s = sysmon.sampleCpu(STAT_B, STAT_A);
  assert.equal(s.total, 0);
  for (const v of s.perCore) assert.ok(Number.isFinite(v) && v >= 0 && v <= 100);
});

test('sampleCpu：真实 /proc/stat 两帧，total 与 16 核都在 0–100', async () => {
  const a = fs.readFileSync('/proc/stat', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const b = fs.readFileSync('/proc/stat', 'utf8');
  const s = sysmon.sampleCpu(a, b);
  assert.ok(Number.isFinite(s.total) && s.total >= 0 && s.total <= 100, 'total 越界: ' + s.total);
  assert.ok(s.perCore.length >= 1, '至少要有一个核');
  for (const v of s.perCore) assert.ok(Number.isFinite(v) && v >= 0 && v <= 100, '核占用越界: ' + v);
});

test('readCpuText/readMeminfoText/readNetDevText：node 里没有 GI，一律返回空串（不抛）', () => {
  assert.equal(sysmon.readCpuText(), '');
  assert.equal(sysmon.readMeminfoText(), '');
  assert.equal(sysmon.readNetDevText(), '');
});

// ---------------------------------------------------------------- GPU（nvidia-smi 异步采样）

test('parseNvidia：本机实测输出 "41, 2547, 10240" 解析成 util/MiB/MiB', () => {
  // 实测：nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits
  const g = sysmon.parseNvidia('41, 2547, 10240\n');
  assert.deepEqual(g, { source: 'nvidia', utilization: 41, memUsedMiB: 2547, memTotalMiB: 10240 });
});

test('parseNvidia：拿不到三列 / total 为 0 / 空输出，一律 null（无数据不编造 0）', () => {
  assert.equal(sysmon.parseNvidia(''), null);
  assert.equal(sysmon.parseNvidia(null), null);
  assert.equal(sysmon.parseNvidia('41, 2547'), null, '缺 total 列');
  assert.equal(sysmon.parseNvidia('41, 2547, 0'), null, 'total=0 视为不可用');
  assert.equal(sysmon.parseNvidia('N/A, N/A, N/A'), null);
});

test('parseNvidia：占用率越界被夹到 0–100', () => {
  assert.equal(sysmon.parseNvidia('140, 100, 1024').utilization, 100);
  assert.equal(sysmon.parseNvidia('-3, 100, 1024').utilization, 0);
});

test('gpuText：node 里没有 GI，非阻塞返回 source:none（不再同步 spawn）', () => {
  const g = sysmon.gpuText();
  assert.equal(g.source, 'none');
  assert.equal(g.utilization, null);
  assert.doesNotThrow(() => sysmon.releaseGpu());
});
