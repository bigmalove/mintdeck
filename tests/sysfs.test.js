// tests/sysfs.test.js — lib/linux/sysfs.js 的解析与「不可用」分支。
//
// 分两段：
//   1. 纯解析（parseThermalZone / parseHwmonTemp / parseFanRpm / parseTempLabel）——
//      夹具全手造，不碰真机：作者本机的温度恰好都在正常区间，拿真机当唯一证据会漏掉哨兵值路径。
//   2. 假 Gio 拉进来跑 readThermal / readFan / diskUsage —— GI 分支在 node 里没有实现，
//      但「属性缺失就整条跳过」「枚举器必须 close」这些判断逻辑值得断死（照 tests/list-files.test.js 的做法）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sysfs = require('../mintdeck@bigmalove/lib/linux/sysfs.js');

// ---------------------------------------------------------------- 1. 纯解析

test('parseThermalZone：正常毫摄氏度（本机实测 thermal_zone0=16800、x86_pkg_temp=50000）', () => {
  assert.equal(sysfs.parseThermalZone('46000\n'), 46);
  assert.equal(sysfs.parseThermalZone('16800'), 16.8);
  assert.equal(sysfs.parseThermalZone('50000\n'), 50);
  // 半度不能丢：46500 与 46499 在面板上就是两个数
  assert.equal(sysfs.parseThermalZone('46500'), 46.5);
  assert.equal(sysfs.parseThermalZone('1'), 0.001);
});

test('parseThermalZone：0 是已知读数，不是「没读到」', () => {
  // 0°C 真的会出现（冷库、刚上电、探头贴在进风口）。若把 0 当 falsy 处理，
  // UI 会显示「—」而不是 0°C —— 这正是本文件最讨厌的那种「假装没数据」。
  assert.equal(sysfs.parseThermalZone('0\n'), 0);
  assert.equal(sysfs.parseThermalZone('000'), 0);
  assert.equal(sysfs.parseThermalZone('-0'), 0, '-0 归一成 0，否则面板会写出 "-0°C"');
});

test('parseThermalZone：负温度照实返回（-60°C 边界内），坏传感器哨兵值判 null', () => {
  assert.equal(sysfs.parseThermalZone('-5000'), -5);        // 户外机柜/冷库实况
  assert.equal(sysfs.parseThermalZone('-27315\n'), -27.315);
  assert.equal(sysfs.parseThermalZone('-60000'), -60, '下界本身算合法');
  // -127000 是 coretemp / 部分 acpitz 驱动未初始化时的经典无效值；0x7fffffff 也见过。
  // 这类值判「不可用」而不是照实显示：显示 -127°C 是假信息，夹到 0 是编造读数。
  assert.equal(sysfs.parseThermalZone('-127000'), null);
  assert.equal(sysfs.parseThermalZone('2147483647'), null);
});

test('parseThermalZone：换行 / 前后空白 / \\r\\n 都容错', () => {
  assert.equal(sysfs.parseThermalZone(' 46000 \n'), 46);
  assert.equal(sysfs.parseThermalZone('\t27800\r\n'), 27.8);
  assert.equal(sysfs.parseThermalZone('\n\n  46000  \n\n'), 46);
  // 中间夹空格不是 sysfs 会给出的格式，按垃圾算（'46 000' 要么是驱动坏了，要么是另一个文件）
  assert.equal(sysfs.parseThermalZone('46 000'), null);
});

test('parseThermalZone：乱码一律 null，不做「尽力猜」', () => {
  assert.equal(sysfs.parseThermalZone('n/a'), null);
  assert.equal(sysfs.parseThermalZone('N/A\n'), null);
  assert.equal(sysfs.parseThermalZone('Error'), null);
  assert.equal(sysfs.parseThermalZone('46000abc'), null, '尾部带字符说明文件不是数字，别让 Number() 吃掉尾巴');
  assert.equal(sysfs.parseThermalZone('0x7fffffff'), null, 'Number("0x...")=16 会把垃圾洗成假读数');
  assert.equal(sysfs.parseThermalZone('1e5'), null, 'Number("1e5")=100000 同上');
  assert.equal(sysfs.parseThermalZone('--5000'), null);
  assert.equal(sysfs.parseThermalZone('46.5.3'), null);
});

test('parseThermalZone：空串 / null / undefined / 非字符串输入都是 null', () => {
  assert.equal(sysfs.parseThermalZone(''), null);
  assert.equal(sysfs.parseThermalZone('   \n\t'), null);
  assert.equal(sysfs.parseThermalZone(null), null);
  assert.equal(sysfs.parseThermalZone(undefined), null);
  assert.equal(sysfs.parseThermalZone(NaN), null);
  assert.equal(sysfs.parseThermalZone(Infinity), null);
  assert.equal(sysfs.parseThermalZone({}), null);
  assert.equal(sysfs.parseThermalZone([]), null);
});

test('parseThermalZone：超出合理范围判 null（150°C 上限；120°C 属真读数，照实放行）', () => {
  // 取舍：夹住（clamp）会编造读数，违反「已知或不可用」；照实返回 200°C 会把面板烧红。
  // 所以取「判不可用 + 上限 150」：真机过热最多到 115–120°C（节流点），150 以上只能是坏传感器/坏换算。
  assert.equal(sysfs.parseThermalZone('120000'), 120, '120°C 是真会出现的过热读数，不能吞掉');
  assert.equal(sysfs.parseThermalZone('145000'), 145);
  assert.equal(sysfs.parseThermalZone('150000'), 150, '上界本身算合法');
  assert.equal(sysfs.parseThermalZone('155000'), null);
  assert.equal(sysfs.parseThermalZone('200000'), null);
  assert.equal(sysfs.parseThermalZone('999999'), null);
});

test('parseHwmonTemp：与 thermal 同单位（毫摄氏度），容错规则一致', () => {
  assert.equal(sysfs.parseHwmonTemp('42000\n'), 42);
  assert.equal(sysfs.parseHwmonTemp(' 42000 '), 42);
  assert.equal(sysfs.parseHwmonTemp('0'), 0);
  assert.equal(sysfs.parseHwmonTemp('-5000'), -5);
  assert.equal(sysfs.parseHwmonTemp(''), null);
  assert.equal(sysfs.parseHwmonTemp(null), null);
  assert.equal(sysfs.parseHwmonTemp('n/a'), null);
  assert.equal(sysfs.parseHwmonTemp('46000abc'), null);
});

test('parseFanRpm：整数 rpm 正常、0 rpm 是停转事实', () => {
  assert.equal(sysfs.parseFanRpm('1200\n'), 1200);
  assert.equal(sysfs.parseFanRpm(' 2450 '), 2450);
  assert.equal(sysfs.parseFanRpm('\t800\r\n'), 800);
  assert.equal(sysfs.parseFanRpm('0'), 0, '风扇停转是真相（该报警），不是「没读到」');
});

test('parseFanRpm：负值 / 小数 / 垃圾 / 超范围都是 null', () => {
  assert.equal(sysfs.parseFanRpm('-100'), null, '负数转速只能是寄存器没读到');
  assert.equal(sysfs.parseFanRpm('1200.5'), null);
  assert.equal(sysfs.parseFanRpm('1e3'), null);
  assert.equal(sysfs.parseFanRpm('N/A'), null);
  assert.equal(sysfs.parseFanRpm('12 00'), null);
  assert.equal(sysfs.parseFanRpm(''), null);
  assert.equal(sysfs.parseFanRpm('   '), null);
  assert.equal(sysfs.parseFanRpm(null), null);
  assert.equal(sysfs.parseFanRpm(undefined), null);
  assert.equal(sysfs.parseFanRpm('100001'), null, '十万转以上必然是坏数据');
  assert.equal(sysfs.parseFanRpm('100000'), 100000, '上界本身算合法');
});

test('parseTempLabel：label 优先、去多余空白、缺失时退回兜底名', () => {
  assert.equal(sysfs.parseTempLabel('Composite\n', 'nvme/temp1'), 'Composite');
  assert.equal(sysfs.parseTempLabel('  Package id 0  \n', 'x/temp1'), 'Package id 0');
  assert.equal(sysfs.parseTempLabel('Package\nid 0', 'x'), 'Package id 0', '换行被折成单个空格，别撑高 UI 一行');
  assert.equal(sysfs.parseTempLabel('', 'nvme/temp1'), 'nvme/temp1');
  assert.equal(sysfs.parseTempLabel('   \n', 'nvme/temp1'), 'nvme/temp1');
  assert.equal(sysfs.parseTempLabel(null, 'hwmon3'), 'hwmon3');
  assert.equal(sysfs.parseTempLabel(undefined), '');
});

// ---------------------------------------------------------------- 2. 假 Gio：GI 分支的判断逻辑

// 假文件树：目录 → 子项名列表；文件 → 内容。查不到的一律按 GIO 的做法抛异常。
function makeFake(tree, contents, fsInfo) {
  const enumerators = [];      // 每个枚举器都记下来，用来断言 close
  let throwInDir = null;       // 测试用：让该目录的枚举器在第二次 next_file 抛异常

  function makeEnumerator(dir) {
    const rows = (tree[dir] || []).slice();
    let i = 0;
    const en = {
      dir: dir,
      closed: false,
      calls: 0,
      next_file() {
        if (dir === throwInDir && this.calls === 1) { this.calls++; throw new Error('device vanished'); }
        this.calls++;
        if (i >= rows.length) return null;
        const name = rows[i++];
        return { get_name: () => name };
      },
      close() { this.closed = true; return true; }
    };
    enumerators.push(en);
    return en;
  }

  function makeInfo(attrs) {
    const keys = Object.keys(attrs);
    return {
      keys: keys,
      has_attribute: (name) => keys.indexOf(name) >= 0,
      get_attribute_uint64(name) {
        if (keys.indexOf(name) < 0) throw new Error('attribute missing: ' + name);
        return attrs[name];
      }
    };
  }

  const gi = {
    GLib: {
      file_get_contents: (path) => {
        if (contents && Object.prototype.hasOwnProperty.call(contents, path)) {
          return [true, Buffer.from(String(contents[path]), 'utf8')];
        }
        return [false, null];
      }
    },
    Gio: {
      File: {
        new_for_path: (path) => ({
          enumerate_children: () => {
            if (!(path in tree)) throw new Error('NOT_FOUND: ' + path);   // GIO 对不存在的目录就是这样抛的
            return makeEnumerator(path);
          },
          query_filesystem_info: () => {
            if (fsInfo && Object.prototype.hasOwnProperty.call(fsInfo, path)) {
              const spec = fsInfo[path];
              if (spec instanceof Error) throw spec;
              return makeInfo(spec);
            }
            throw new Error('no such mount: ' + path);
          }
        })
      }
    }
  };
  return { gi, enumerators, setThrowDir: (d) => { throwInDir = d; } };
}

// 只在调用期间挂上假 imports，退出时还原（与 tests/list-files.test.js 同一个套路）。
// 必须用 globalThis 而不是 global：tests/panel-trend.test.js 里 `global.global = { stage: {} }`
// 把全局的 `global` 别名永久换成了一个普通对象；而 node --test 单进程跑整个目录时
// （tests/index.js 把每个 *.test.js require 进同一个进程），后加载的文件拿到的 `global`
// 就是那个假对象 —— 往它上面挂 imports，sysfs.js 里的 `imports` 根本看不见。
function withImports(gi, fn) {
  const had = 'imports' in globalThis;
  const prev = had ? globalThis.imports : undefined;
  globalThis.imports = { gi: gi };
  try {
    return fn();
  } finally {
    if (had) globalThis.imports = prev;
    else delete globalThis.imports;
  }
}

test('readThermal：thermal zone 优先，取最大值，逐项明细按温度降序', () => {
  const fake = makeFake(
    { '/sys/class/thermal': ['thermal_zone0', 'thermal_zone1', 'thermal_zone2', 'cooling_device0'] },
    {
      '/sys/class/thermal/thermal_zone0/temp': '16800\n',
      '/sys/class/thermal/thermal_zone0/type': 'acpitz\n',
      '/sys/class/thermal/thermal_zone1/temp': '50000\n',
      '/sys/class/thermal/thermal_zone1/type': 'x86_pkg_temp\n',
      '/sys/class/thermal/thermal_zone2/temp': 'n/a\n',          // 读得到文件但值是垃圾 → 跳过该条
    },
    {}
  );
  const r = withImports(fake.gi, () => sysfs.readThermal());
  assert.equal(r.source, 'thermal');
  assert.equal(r.celsius, 50);
  assert.deepEqual(r.zones, [
    { name: 'x86_pkg_temp', celsius: 50 },
    { name: 'acpitz', celsius: 16.8 }
  ]);
  assert.deepEqual(fake.enumerators.filter((e) => !e.closed), [], '枚举器必须 close，否则每次刷新漏一个 dirfd');
});

test('readThermal：没有 thermal_zone 才退回 hwmon，名字用 tempN_label 或 hwmon名/tempN', () => {
  const fake = makeFake(
    {
      '/sys/class/thermal': ['cooling_device0'],                 // 只有散热设备，没有温标
      '/sys/class/hwmon': ['hwmon3', 'hwmon6'],
      '/sys/class/hwmon/hwmon3': ['temp1_input', 'temp1_label', 'temp2_input', 'temp2_alarm'],
      '/sys/class/hwmon/hwmon6': ['temp1_input', 'name'],
    },
    {
      '/sys/class/hwmon/hwmon3/name': 'nvme\n',
      '/sys/class/hwmon/hwmon3/temp1_input': '42000\n',
      '/sys/class/hwmon/hwmon3/temp1_label': 'Composite\n',
      '/sys/class/hwmon/hwmon3/temp2_input': '39000\n',          // 没有 label
      '/sys/class/hwmon/hwmon6/name': 'coretemp\n',
      '/sys/class/hwmon/hwmon6/temp1_input': '87000\n',
    },
    {}
  );
  const r = withImports(fake.gi, () => sysfs.readThermal());
  assert.equal(r.source, 'hwmon');
  assert.equal(r.celsius, 87);
  assert.deepEqual(r.zones.map((z) => z.name), ['coretemp/temp1', 'Composite', 'nvme/temp2']);
  assert.deepEqual(fake.enumerators.filter((e) => !e.closed), []);
});

test('readThermal：两条通道都没有时给空结构（celsius/source 均 null，不编造 0）', () => {
  const fake = makeFake({}, {}, {});
  const r = withImports(fake.gi, () => sysfs.readThermal());
  assert.equal(r.celsius, null);
  assert.equal(r.source, null);
  assert.deepEqual(r.zones, []);
});

test('readThermal：zone 多于 8 条时只留最热的 8 条', () => {
  const names = [];
  const contents = {};
  for (let i = 0; i < 12; i++) {
    names.push('thermal_zone' + i);
    contents['/sys/class/thermal/thermal_zone' + i + '/temp'] = String(20000 + i * 1000) + '\n';
  }
  const fake = makeFake({ '/sys/class/thermal': names }, contents, {});
  const r = withImports(fake.gi, () => sysfs.readThermal());
  assert.equal(r.zones.length, 8);
  assert.equal(r.celsius, 31);
  assert.deepEqual(r.zones.map((z) => z.celsius), [31, 30, 29, 28, 27, 26, 25, 24]);
});

test('readThermal：枚举中途抛异常不炸整次刷新，已读到的仍然返回，枚举器照样 close', () => {
  const fake = makeFake(
    { '/sys/class/thermal': ['thermal_zone0', 'thermal_zone1'] },
    {
      '/sys/class/thermal/thermal_zone0/temp': '30000\n',
      '/sys/class/thermal/thermal_zone0/type': 'acpitz\n',
    },
    {}
  );
  fake.setThrowDir('/sys/class/thermal');
  const r = withImports(fake.gi, () => sysfs.readThermal());
  // 第二次 next_file 就抛：拿到了 zone0，zone1 当不可用
  assert.deepEqual(r.zones, [{ name: 'acpitz', celsius: 30 }]);
  assert.deepEqual(fake.enumerators.filter((e) => !e.closed), []);
});

test('readFan：多个 fan*_input 取最大转速，label 缺失时拼 hwmon名/fanN', () => {
  const fake = makeFake(
    {
      '/sys/class/hwmon': ['hwmon2'],
      '/sys/class/hwmon/hwmon2': ['fan1_input', 'fan2_input', 'fan1_label', 'fan2_alarm'],
    },
    {
      '/sys/class/hwmon/hwmon2/name': 'gigabyte_wmi\n',
      '/sys/class/hwmon/hwmon2/fan1_input': '1200\n',
      '/sys/class/hwmon/hwmon2/fan1_label': 'CPU Fan\n',
      '/sys/class/hwmon/hwmon2/fan2_input': '0\n',               // 停转的副风扇
    },
    {}
  );
  const r = withImports(fake.gi, () => sysfs.readFan());
  assert.equal(r.rpm, 1200);
  assert.deepEqual(r.fans, [{ name: 'CPU Fan', rpm: 1200 }, { name: 'gigabyte_wmi/fan2', rpm: 0 }]);
  assert.deepEqual(fake.enumerators.filter((e) => !e.closed), []);
});

test('readFan：本机没有风扇传感器时 rpm 为 null（0 是停转，null 是没有传感器）', () => {
  const fake = makeFake({ '/sys/class/hwmon': ['hwmon0'] }, { '/sys/class/hwmon/hwmon0/name': 'acpitz\n' }, {});
  assert.deepEqual(withImports(fake.gi, () => sysfs.readFan()), { rpm: null, fans: [] });
});

test('diskUsage：percent = used/size，同一路径去重，属性缺失/容量 0/查询抛错都整条跳过', () => {
  const fake = makeFake(
    {},
    {},
    {
      '/': { 'filesystem::size': 1000, 'filesystem::used': 250, 'filesystem::free': 750 },
      '/home': { 'filesystem::size': 2000, 'filesystem::used': 2400, 'filesystem::free': 0 },   // quota 溢出
      '/btrfs': { 'filesystem::size': 500 },                                                     // 只有 size：btrfs 常见
      '/empty': { 'filesystem::size': 0, 'filesystem::used': 0, 'filesystem::free': 0 },
      '/broken': new Error('timeout'),
    }
  );
  const d = withImports(fake.gi, () => sysfs.diskUsage(['/', '/home', '/btrfs', '/empty', '/broken', '/']));
  assert.equal(d.length, 2, '重复的 / 只算一次');
  assert.deepEqual(d[0], { mount: '/', totalBytes: 1000, usedBytes: 250, freeBytes: 750, percent: 25 });
  assert.equal(d[1].percent, 100, 'used > size 时夹到 100，不能给 120%');
});

test('diskUsage：node 里没有 Gio 时返回 []（不抛）', () => {
  assert.deepEqual(sysfs.diskUsage(['/']), []);
  assert.deepEqual(sysfs.diskUsage(), []);
});

test('collect：node 里没有 GI 时三个字段各自走「不可用」，不互相污染', () => {
  assert.deepEqual(sysfs.collect(), {
    disks: [],
    thermal: { celsius: null, source: null, zones: [] },
    fan: { rpm: null, fans: [] }
  });
});
