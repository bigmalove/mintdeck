// tests/tasks.test.js — lib/linux/tasks.js 的纯解析函数（parseAria2 / parseQbittorrent / parseDockerPs / parseFailedUnits），
// 外加两条「node 里没有 GI / 没有 imports 时不抛」的兜底断言。
// 夹具说明：
//   · aria2 的数字全是字符串（JSON-RPC 就这样），速度单位是 bytes/s；
//   · qBittorrent 的 progress 是 0–1 浮点，eta 用 8640000 表示「∞」；
//   · docker/podman 的输出按 --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}' 的真实投放，
//     另有一个 CRLF + 字面 \t 的变体（在 Windows 终端里跑过再粘回来就是那样）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const tasks = require('../mintdeck@bigmalove/lib/linux/tasks.js');

// ---------------------------------------------------------------- aria2 夹具

// 归一化后的形状：tellActive 的 active + getGlobalStat 的计数（本模块 fetchAria2 用 multicall 合成这一份）
const ARIA2_OK = {
  id: 'mintdeck',
  jsonrpc: '2.0',
  result: {
    numActive: 2,
    numWaiting: 1,
    numStopped: 3,
    downloadSpeed: '1536',
    active: [
      {
        gid: 'd3f1b7',
        downloadSpeed: '1024',
        totalLength: '4096',
        completedLength: '1024',
        status: 'active',
        files: [{ path: '/home/u/Downloads/a.iso' }]
      },
      {
        gid: 'aa10',
        // 故意写错字段名：拿不到速度就该是 null，不能因为「另一个任务有速度」就给它凑一个
        downlaodSpeed: '512',
        totalLength: '0',
        completedLength: '0',
        status: 'active',
        files: [{ path: '/home/u/Downloads/b.bin' }]
      }
    ]
  }
};

test('parseAria2：正常形状 → 每条任务的 gid/name/percent/speed/eta，以及 stopped/total/聚合速度', () => {
  const snap = tasks.parseAria2(JSON.stringify(ARIA2_OK));
  assert.equal(snap.active.length, 2);

  const first = snap.active[0];
  assert.equal(first.gid, 'd3f1b7');
  assert.equal(first.name, 'a.iso', 'name 取 files[0].path 的 basename，不是整条绝对路径');
  assert.equal(first.percent, 25);
  assert.equal(first.downBytesPerSec, 1024);
  assert.equal(first.etaSec, 3, '剩余 3072B / 1024B/s → 3s（从已知量算，不是编）');

  const second = snap.active[1];
  assert.equal(second.name, 'b.bin');
  assert.equal(second.percent, null, 'totalLength 0 时进度未知，不能给 0%');
  assert.equal(second.downBytesPerSec, null, '字段名拼错就是没有速度，不拿别的任务顶上');
  assert.equal(second.etaSec, null);

  assert.equal(snap.stopped, 3);
  assert.equal(snap.total, 6, 'numActive 2 + numWaiting 1 + numStopped 3');
  assert.equal(snap.speedBytesPerSec, 1536, '用 getGlobalStat 的 downloadSpeed');
});

test('parseAria2：裸 tellActive（{"result":[...]}）→ 没有计数，stopped 只能是 null，total 退化成活跃条数', () => {
  const snap = tasks.parseAria2(JSON.stringify({ jsonrpc: '2.0', result: ARIA2_OK.result.active }));
  assert.equal(snap.active.length, 2);
  assert.equal(snap.stopped, null, '响应里没有 numStopped：不知道就是 null，不是 0');
  assert.equal(snap.total, 2);
  assert.equal(snap.speedBytesPerSec, 1024, '没有全局计数时按活跃任务的已知速度求和（另一条速度未知就不参与）');
});

test('parseAria2：字段缺失不编造；completedLength 超过 totalLength 夹到 100%', () => {
  const snap = tasks.parseAria2(JSON.stringify({
    result: {
      numActive: 1,
      active: [{ gid: 'g1', totalLength: '100', completedLength: '250', downloadSpeed: '0' }]
    }
  }));
  assert.equal(snap.active.length, 1);
  assert.equal(snap.active[0].name, 'g1', '没有 files 就退回 gid：gid 是事实');
  assert.equal(snap.active[0].percent, 100, '250/100 夹到 100，不画 250% 的进度条');
  assert.equal(snap.active[0].etaSec, null, '速度为 0 算不出 eta，给 null 而不是 ∞');
  assert.equal(snap.total, 1);
  assert.equal(snap.stopped, null, '这一份 result 里没有 numStopped');
});

test('parseAria2：非法数字（负数 / NaN / 空串）一律 null，不夹成 0', () => {
  const snap = tasks.parseAria2(JSON.stringify({
    result: {
      numActive: 1,
      downloadSpeed: 'NaN',
      active: [{
        gid: 'bad',
        totalLength: '-5',
        completedLength: '',
        downloadSpeed: '-1',
        files: [{ path: '' }]
      }]
    }
  }));
  assert.equal(snap.active[0].percent, null);
  assert.equal(snap.active[0].downBytesPerSec, null);
  assert.equal(snap.active[0].etaSec, null);
  assert.equal(snap.active[0].name, 'bad', '空 path 不给空名字，退回 gid');
  assert.equal(snap.speedBytesPerSec, null, '唯一的活跃任务速度未知 → 聚合速度也未知，不写成 0');
});

test('parseAria2：空活跃列表是「真的没有任务」，不是不可用', () => {
  const snap = tasks.parseAria2(JSON.stringify({ result: { numActive: 0, downloadSpeed: '0', active: [] } }));
  assert.deepEqual(snap.active, []);
  assert.equal(snap.total, 0);
  assert.equal(snap.stopped, null);
  assert.equal(snap.speedBytesPerSec, 0);
});

test('parseAria2：半截 JSON / 非 JSON / RPC error / 形状不认识 → null', () => {
  assert.equal(tasks.parseAria2('{"result":{"active":['), null);
  assert.equal(tasks.parseAria2('Ok.'), null);
  assert.equal(tasks.parseAria2(''), null);
  assert.equal(tasks.parseAria2(null), null);
  assert.equal(tasks.parseAria2(JSON.stringify({ error: { code: 1, message: 'Unauthorized' } })), null);
  assert.equal(tasks.parseAria2(JSON.stringify({ result: 'nope' })), null);
});

// ---------------------------------------------------------------- qBittorrent 夹具

const QBT_OK = [
  { hash: 'h1', name: 'ubuntu-24.04.iso', progress: 0.5, dlspeed: 2048, eta: 120, state: 'downloading' },
  { hash: 'h2', name: 'paused.iso', progress: 0.25, dlspeed: 0, eta: 8640000, state: 'pausedDL' },
  { hash: 'h3', name: 'done.iso', progress: 1, dlspeed: 0, eta: 0, state: 'uploading' }
];

test('parseQbittorrent：只把「下载中」放进 active，其余计入 stopped；total 是列表长度', () => {
  const snap = tasks.parseQbittorrent(JSON.stringify(QBT_OK));
  assert.equal(snap.active.length, 1);
  assert.equal(snap.active[0].gid, 'h1', 'gid 用 hash');
  assert.equal(snap.active[0].name, 'ubuntu-24.04.iso');
  assert.equal(snap.active[0].percent, 50, 'progress 0.5 → 50%');
  assert.equal(snap.active[0].downBytesPerSec, 2048);
  assert.equal(snap.active[0].etaSec, 120);
  assert.equal(snap.total, 3);
  assert.equal(snap.stopped, 2, 'pausedDL 不是下载中：名字里带 DL 也不算');
  assert.equal(snap.speedBytesPerSec, 2048);
});

test('parseQbittorrent：eta 8640000 是 qBittorrent 的「∞」，按未知处理；负 progress 也是未知', () => {
  const snap = tasks.parseQbittorrent(JSON.stringify([
    { hash: 'x', name: 'a', progress: 0.1, dlspeed: 0, eta: 8640000, state: 'stalledDL' },
    { hash: 'y', name: 'b', progress: -1, dlspeed: -5, eta: -1, state: 'downloading' }
  ]));
  assert.equal(snap.active.length, 2, 'stalledDL 仍在下载队列里（速度 0 但状态是下载中）');
  assert.equal(snap.active[0].etaSec, null, '8640000 显示成 100 天是假信息');
  assert.equal(snap.active[1].percent, null, 'progress -1 是老版本的「未知」，不画 0%');
  assert.equal(snap.active[1].downBytesPerSec, null);
  assert.equal(snap.speedBytesPerSec, 0, '负速度不参与求和');
});

test('parseQbittorrent：缺 hash / 缺 name 的兜底，以及空数组是「真的没有种子」', () => {
  const snap = tasks.parseQbittorrent(JSON.stringify([
    { name: 'no-hash.iso', progress: 0.5, dlspeed: 10, eta: 5, state: 'downloading' },
    { hash: 'only-hash', progress: 0.5, dlspeed: 10, eta: 5, state: 'downloading' },
    null,
    { name: '', hash: '', progress: 0.5 }
  ]));
  assert.equal(snap.active[0].gid, 'no-hash.iso', '没有 hash 时用 name 顶 gid，别让 UI 拿到空 key');
  assert.equal(snap.active[1].name, 'only-hash', '没有 name 时用 hash 显示');
  assert.equal(snap.total, 4, '解析不出来的行也算任务，总数不能缩水');
  assert.equal(snap.stopped, 2);

  const empty = tasks.parseQbittorrent('[]');
  assert.deepEqual(empty.active, []);
  assert.equal(empty.stopped, 0);
  assert.equal(empty.total, 0);
  assert.equal(empty.speedBytesPerSec, 0);
});

test('parseQbittorrent：非数组 / 半截 JSON / 登录失败文本 → null', () => {
  assert.equal(tasks.parseQbittorrent('Fails.'), null);
  assert.equal(tasks.parseQbittorrent(JSON.stringify({ error: 'Forbidden' })), null);
  assert.equal(tasks.parseQbittorrent('[{"hash":"h1","name"'), null);
  assert.equal(tasks.parseQbittorrent(undefined), null);
});

// ---------------------------------------------------------------- docker / podman

test('parseDockerPs：tab 分隔 + CRLF，running 只认 state=running（paused 不算在跑）', () => {
  const text = [
    'a1b2c3d4e5f6\tweb\tnginx:1.27\trunning\r',
    'b2c3d4e5f6a7\tdb\tpostgres:16\texited\r',
    'c3d4e5f6a7b8\tcache\tredis:7\tpaused\r',
    ''
  ].join('\n');
  const list = tasks.parseDockerPs(text);
  assert.equal(list.length, 3);
  assert.deepEqual(list[0], { id: 'a1b2c3d4e5f6', name: 'web', image: 'nginx:1.27', state: 'running', running: true });
  assert.equal(list[1].running, false, 'exited 不在跑');
  assert.equal(list[2].running, false, 'paused 是活着但不干活，算进 running 会把「在服务」报大');
});

test('parseDockerPs：字面 \\t（有的版本不解释模板转义）同样能切；空输出 → []', () => {
  const list = tasks.parseDockerPs('d4e5f6a7b8c9\tworker\tmy/app:dev\trunning\n');
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'worker');
  assert.equal(list[0].running, true);
  assert.deepEqual(tasks.parseDockerPs(''), []);
  assert.deepEqual(tasks.parseDockerPs('   \n\n'), []);
  assert.deepEqual(tasks.parseDockerPs(null), []);
});

test('parseDockerPs：缺列 / 单列垃圾行不猜', () => {
  const list = tasks.parseDockerPs('e5f6a7b8c9d0\tlonely\nCannot connect to the Docker daemon\n');
  assert.equal(list.length, 1, '单列行不是这个格式的输出');
  assert.deepEqual(list[0], { id: 'e5f6a7b8c9d0', name: 'lonely', image: '', state: '', running: false });
});

// ---------------------------------------------------------------- systemd

test('parseFailedUnits：--plain 五列取 UNIT + ACTIVE，描述里的空格不影响', () => {
  const text = [
    'foo.service loaded failed failed Foo service with spaces in description',
    'bar.timer loaded failed failed Bar timer',
    ''
  ].join('\n');
  const list = tasks.parseFailedUnits(text);
  assert.deepEqual(list, [
    { unit: 'foo.service', active: 'failed' },
    { unit: 'bar.timer', active: 'failed' }
  ]);
});

test('parseFailedUnits：空输出是「一个失败单元都没有」（[]），不是不可用；项目符号与表头都能吃掉', () => {
  assert.deepEqual(tasks.parseFailedUnits(''), []);
  assert.deepEqual(tasks.parseFailedUnits('  \n\t\n'), []);
  assert.deepEqual(tasks.parseFailedUnits(null), []);
  const list = tasks.parseFailedUnits('● broken.service loaded failed failed Broken\n');
  assert.deepEqual(list, [{ unit: 'broken.service', active: 'failed' }]);
});

// ---------------------------------------------------------------- 无 GI 的兜底

test('node 里没有 imports/GI：collectAsync 给一帧全 null，不抛；abort 可以调用两次', () => {
  const frames = [];
  const handle = tasks.collectAsync({ aria2: null, qbittorrent: null, containers: false }, (s) => frames.push(s));
  assert.equal(typeof handle.abort, 'function');
  assert.ok(frames.length >= 1);
  const last = frames[frames.length - 1];
  assert.deepEqual(Object.keys(last).sort(), ['containers', 'downloads', 'downloadsSource', 'failedUnits']);
  assert.equal(last.downloads, null, '没配置下载源：null（不是空对象）');
  assert.equal(last.downloadsSource, null);
  assert.equal(last.failedUnits, null, 'node 里没有 Exec：systemd 那一路不可用 → null');
  handle.abort();
  handle.abort();   // 重复 abort 不该炸
});

test('opts 里只要 containers:true 就走子进程那一路；node 下没有 Exec → null', () => {
  let last = null;
  tasks.collectAsync({ containers: true }, (s) => { last = s; });
  assert.equal(last.containers, null, '没有 Exec 就是不可用，不是 0 个容器');
});
