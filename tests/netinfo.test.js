// tests/netinfo.test.js — lib/linux/netinfo.js 的纯解析函数。
// 只测不碰 GI / 不起子进程的部分（parsePing / parseIfaces / parsePublicIp / publicIpRequest），
// 外加两条「node 里没有 GI 时不抛」的兜底断言。
// 夹具取自本机实测输出（iputils 2.40），busybox 那份按 busybox 的 round-trip 格式手写。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const netinfo = require('../mintdeck@bigmalove/lib/linux/netinfo.js');

// 本机 `ping -c 3 -W 1 -n 127.0.0.1` 的原样输出
const PING_IPUTILS_OK = [
  'PING 127.0.0.1 (127.0.0.1) 56(84) bytes of data.',
  '64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.027 ms',
  '64 bytes from 127.0.0.1: icmp_seq=2 ttl=64 time=0.023 ms',
  '64 bytes from 127.0.0.1: icmp_seq=3 ttl=64 time=0.018 ms',
  '',
  '--- 127.0.0.1 ping statistics ---',
  '3 packets transmitted, 3 received, 0% packet loss, time 2035ms',
  'rtt min/avg/max/mdev = 0.018/0.022/0.027/0.003 ms',
  ''
].join('\n');

// 本机 `ping -c 2 -W 1 -n 192.0.2.1`（TEST-NET-1，必然全丢）的原样输出
const PING_IPUTILS_LOSS = [
  'PING 192.0.2.1 (192.0.2.1) 56(84) bytes of data.',
  '',
  '--- 192.0.2.1 ping statistics ---',
  '2 packets transmitted, 0 received, 100% packet loss, time 1028ms',
  ''
].join('\n');

// busybox：只有 round-trip 行，且 received 前面带 "packets"
const PING_BUSYBOX = [
  'PING 8.8.8.8 (8.8.8.8): 56 data bytes',
  '64 bytes from 8.8.8.8: seq=0 ttl=117 time=18.432 ms',
  '',
  '--- 8.8.8.8 ping statistics ---',
  '2 packets transmitted, 2 packets received, 0% packet loss',
  'round-trip min/avg/max = 18.432/20.155/21.879 ms',
  ''
].join('\n');

test('parsePing：iputils 统计行 → avg 延迟、0% 丢包、transmitted 3', () => {
  const p = netinfo.parsePing(PING_IPUTILS_OK);
  assert.equal(p.rttMs, 0.022, 'rtt 取 min/avg/max 的 avg');
  assert.equal(p.lossPercent, 0);
  assert.equal(p.transmitted, 3);
});

test('parsePing：busybox 的 round-trip 行同样能取到 avg，且认 "packets received"', () => {
  const p = netinfo.parsePing(PING_BUSYBOX);
  assert.equal(p.rttMs, 20.155);
  assert.equal(p.lossPercent, 0);
  assert.equal(p.transmitted, 2);
});

test('parsePing：全丢包 → 没有 rtt 行，rttMs 为 null 但 lossPercent 是 100', () => {
  const p = netinfo.parsePing(PING_IPUTILS_LOSS);
  assert.equal(p.rttMs, null, '不能拿 0 冒充延迟');
  assert.equal(p.lossPercent, 100);
  assert.equal(p.transmitted, 2);
});

test('parsePing：部分丢包 33.3333% 原样保留（两位小数），延迟照给', () => {
  const text = [
    '--- 10.0.0.9 ping statistics ---',
    '3 packets transmitted, 2 received, +1 errors, 33.3333% packet loss, time 2004ms',
    'rtt min/avg/max/mdev = 12.345/14.100/16.000/1.234 ms',
    ''
  ].join('\n');
  const p = netinfo.parsePing(text);
  assert.equal(p.lossPercent, 33.33);
  assert.equal(p.rttMs, 14.1);
  assert.equal(p.transmitted, 3);
});

test('parsePing：耗时行的小数逗号（12,3 ms）能读；统计行不认识时丢包率给 null 不猜', () => {
  // 德语 locale 下整行都是德语（Paketverlust），本模块只认英文关键字：
  // 那就把「不知道」如实交出去（lossPercent null），而不是从别处凑一个数出来。
  const german = '3 Pakete übertragen, 2 empfangen, 33,3333% Paketverlust\n' +
    'rtt min/avg/max/mdev = 12,3/14,1/16,0/1,2 ms\n';
  const g = netinfo.parsePing(german);
  assert.equal(g.rttMs, 14.1, 'rtt 行是格式化的数字，逗号小数点照收');
  assert.equal(g.lossPercent, null, '关键字不认识就不猜');
  assert.equal(g.transmitted, null);

  const mixed = '3 packets transmitted, 3 received, 0,0% packet loss\n';
  const m = netinfo.parsePing(mixed);
  assert.equal(m.lossPercent, 0, '关键字在、小数点被本地化成逗号时照样解析');
  assert.equal(m.transmitted, 3);
});

test('parsePing：乱码 / 空串 / 只有报错信息 → null（不是全字段 null 的对象）', () => {
  assert.equal(netinfo.parsePing(''), null);
  assert.equal(netinfo.parsePing('   \n\t '), null);
  assert.equal(netinfo.parsePing(null), null);
  assert.equal(netinfo.parsePing(undefined), null);
  assert.equal(netinfo.parsePing('ping: connect: Network is unreachable'), null);
  assert.equal(netinfo.parsePing('\u0000\u0001garbage'), null);
});

// 真实 /proc/net/dev（本机）：lo + down 的 enp6s0 + wlp5s0 + 与 wlp5s0 流量重复的 Meta + 三个虚拟接口
const NETDEV = [
  'Inter-|   Receive                                                |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
  '    lo: 5372377524 1819088    0    0    0     0          0         0 5372377524 1819088    0    0    0     0       0          0',
  'enp6s0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0',
  'wlp5s0: 9631352104 8881691    0   13    0     0          0         0 2487305768 3814720    0    0    0     0       0          0',
  '  Meta: 8134690754 3324526    0    0    0     0          0         0 2007003798 2747452    0    0    0     0       0          0',
  'docker0: 1234 10 0 0 0 0 0 0 5678 20 0 0 0 0 0 0',
  'virbr0: 4321 11 0 0 0 0 0 0 8765 21 0 0 0 0 0 0',
  'veth9a: 999 9 0 0 0 0 0 0 888 8 0 0 0 0 0 0',
  ''
].join('\n');

test('parseIfaces：排除 lo / Meta / veth* / docker* / br-* / virbr*，保留文件顺序与 rx/tx 列', () => {
  const list = netinfo.parseIfaces(NETDEV);
  assert.deepEqual(list, [
    { name: 'enp6s0', rxBytes: 0, txBytes: 0 },
    { name: 'wlp5s0', rxBytes: 9631352104, txBytes: 2487305768 }
  ]);
  assert.ok(list.every((i) => i.name !== 'Meta'), 'Meta tun 与 wlp5s0 流量重复，列出来会被误选');
});

test('parseIfaces：表头 / 空串 / 字段不足的行一律跳过，不产生 NaN', () => {
  assert.deepEqual(netinfo.parseIfaces(''), []);
  assert.deepEqual(netinfo.parseIfaces(null), []);
  assert.deepEqual(netinfo.parseIfaces('eth0: 1 2 3\n'), [], '9 列不全就是残行');
  const list = netinfo.parseIfaces('eth0: 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16\n');
  assert.deepEqual(list, [{ name: 'eth0', rxBytes: 1, txBytes: 9 }]);
});

test('readLinkState：注入读文件，up/速率/MTU 三项各按 sysfs 语义取值', () => {
  const files = {
    '/sys/class/net/wlp5s0/operstate': 'up\n',
    '/sys/class/net/wlp5s0/speed': null,      // 无线网卡读 speed 是 EINVAL
    '/sys/class/net/wlp5s0/mtu': '1500\n',
    '/sys/class/net/enp6s0/operstate': 'down\n',
    '/sys/class/net/enp6s0/speed': '-1\n',    // down 时的内核输出
    '/sys/class/net/enp6s0/mtu': '1500\n',
    '/sys/class/net/Meta/operstate': 'unknown\n',
    '/sys/class/net/Meta/speed': '10000\n',
    '/sys/class/net/Meta/mtu': '9000\n'
  };
  const read = (p) => (p in files ? files[p] : null);
  assert.deepEqual(netinfo.readLinkState('wlp5s0', read),
    { iface: 'wlp5s0', operstate: 'up', speedMbps: null, mtu: 1500 });
  assert.deepEqual(netinfo.readLinkState('enp6s0', read),
    { iface: 'enp6s0', operstate: 'down', speedMbps: null, mtu: 1500 }, 'speed=-1 是未知，不是 0');
  assert.deepEqual(netinfo.readLinkState('Meta', read),
    { iface: 'Meta', operstate: 'unknown', speedMbps: 10000, mtu: 9000 });
  assert.deepEqual(netinfo.readLinkState('nope0', read),
    { iface: 'nope0', operstate: null, speedMbps: null, mtu: null }, '文件读不到就是 null');
  assert.deepEqual(netinfo.readLinkState('', read),
    { iface: null, operstate: null, speedMbps: null, mtu: null });
});

test('parsePublicIp：ipify 的 {"ip":"..."} 与裸文本都接受', () => {
  assert.equal(netinfo.parsePublicIp('{"ip":"1.2.3.4"}'), '1.2.3.4');
  assert.equal(netinfo.parsePublicIp('{"ip":"1.2.3.4"}\n'), '1.2.3.4');
  assert.equal(netinfo.parsePublicIp('1.2.3.4\n'), '1.2.3.4');
  assert.equal(netinfo.parsePublicIp('  1.2.3.4  '), '1.2.3.4');
  assert.equal(netinfo.parsePublicIp('1.2.3.4\nsecond line'), '1.2.3.4', '只认第一行');
  assert.equal(netinfo.parsePublicIp('"1.2.3.4"'), '1.2.3.4', '裸 JSON 字符串');
  assert.equal(netinfo.parsePublicIp('[{"ip":"1.2.3.4"}]'), '1.2.3.4', '数组包一层也认');
  assert.equal(netinfo.parsePublicIp('2001:db8::1'), '2001:db8::1', 'IPv6 粗校验通过');
});

test('parsePublicIp：空 / 非 JSON / 无 ip 字段 / 越界 IPv4 / 垃圾文本 → null', () => {
  assert.equal(netinfo.parsePublicIp(''), null);
  assert.equal(netinfo.parsePublicIp(null), null);
  assert.equal(netinfo.parsePublicIp('not an ip'), null);
  assert.equal(netinfo.parsePublicIp('{"foo":1}'), null);
  assert.equal(netinfo.parsePublicIp('{"ip":""}'), null);
  assert.equal(netinfo.parsePublicIp('{"ip":'), null, '半截 JSON');
  assert.equal(netinfo.parsePublicIp('999.1.1.1'), null, '每组必须 ≤ 255');
  assert.equal(netinfo.parsePublicIp('1.2.3'), null);
  assert.equal(netinfo.parsePublicIp('<html>502</html>'), null);
});

test('publicIpRequest：只描述请求（GET / ipify / UA MintDeck），不发请求', () => {
  assert.deepEqual(netinfo.publicIpRequest(), {
    method: 'GET',
    url: 'https://api.ipify.org?format=json',
    headers: { 'User-Agent': 'MintDeck' }
  });
  assert.equal(netinfo.DEFAULT_PING_HOST, '1.1.1.1', '默认探测目标是常量，方便改');
});

test('node 里没有 GI / 没有 ping：probePing 立刻 cb(null)，collectAsync 不抛且按步回调', () => {
  let probed = null;
  assert.doesNotThrow(() => {
    netinfo.probePing('1.1.1.1', (sample) => { probed = sample; });
  });
  assert.equal(probed, null, '没有 Exec 就是不可用，不是 0 延迟');

  const frames = [];
  let handle = null;
  assert.doesNotThrow(() => {
    handle = netinfo.collectAsync((sample) => frames.push(sample));
  });
  assert.ok(frames.length >= 1, '至少同步出第一帧（link）');
  const last = frames[frames.length - 1];
  assert.deepEqual(Object.keys(last).sort(), ['latency', 'link', 'publicIp']);
  assert.equal(last.latency, null);
  assert.equal(last.publicIp, null);
  assert.equal(last.link, null, 'node 里没有 GLib，/proc/net/dev 读不到 → 不编造网卡');
  assert.doesNotThrow(() => handle.abort());
});
