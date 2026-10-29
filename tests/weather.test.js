// tests/weather.test.js — lib/linux/weather.js 的纯函数（kindOf / geocodeRequest / parseGeocode /
// forecastRequest / parseForecast）外加两条「node 里没有 GI 时不抛、直接返回不可用」的兜底断言。
//
// 不碰 GI、不发请求：本机没网或走了代理都不该让这套测试红。
// 夹具是按 Open-Meteo 真实响应结构手写的（字段名、current.time 格式、daily 四个平行数组都照抄），
// 只有数值是为了断言方便捏的。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const weather = require('../mintdeck@bigmalove/lib/linux/weather.js');

// ---------------------------------------------------------------- 夹具

// geocoding-api 真实返回（name=杭州&count=1&language=zh&format=json）
const GEOCODE_OK = JSON.stringify({
  results: [{
    id: 1808926,
    name: '杭州',
    latitude: 30.29365,
    longitude: 120.16142,
    elevation: 12.0,
    feature_code: 'PPLA',
    country_code: 'CN',
    admin1_id: 1785695,
    timezone: 'Asia/Shanghai',
    population: 11936010,
    country_id: 1814991,
    country: '中国',
    admin1: '浙江',
    admin2: '杭州'
  }],
  generationtime_ms: 0.912
});

// forecast 真实返回结构：current 三字段 + daily 四个等长数组
const FORECAST_OK = JSON.stringify({
  latitude: 30.25,
  longitude: 120.15625,
  generationtime_ms: 0.28,
  utc_offset_seconds: 28800,
  timezone: 'Asia/Shanghai',
  timezone_abbreviation: 'GMT+8',
  elevation: 6.0,
  current_units: {
    time: 'iso8601',
    interval: 'seconds',
    temperature_2m: '°C',
    apparent_temperature: '°C',
    weather_code: 'wmo code'
  },
  current: {
    time: '2026-10-29T17:30',
    interval: 900,
    temperature_2m: 21.4,
    apparent_temperature: 21.0,
    weather_code: 2
  },
  daily_units: {
    time: 'iso8601',
    weather_code: 'wmo code',
    temperature_2m_max: '°C',
    temperature_2m_min: '°C'
  },
  daily: {
    time: ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'],
    weather_code: [2, 61, 3, 0],
    temperature_2m_max: [23.1, 20.4, 24.9, 25.6],
    temperature_2m_min: [15.2, 14.8, 13.9, 14.1]
  }
});

// 把 FORECAST_OK 的某个顶层字段摘掉，用来造「缺 current / 缺 daily」
function forecastWithout(path) {
  const data = JSON.parse(FORECAST_OK);
  const keys = path.split('.');
  let node = data;
  for (let i = 0; i < keys.length - 1; i++) node = node[keys[i]];
  delete node[keys[keys.length - 1]];
  return JSON.stringify(data);
}

// ---------------------------------------------------------------- kindOf

test('kindOf：WMO 代码按分组边界归到 8 类，0/1/2/3 四档各自站队', () => {
  assert.equal(weather.kindOf(0), 'clear', '0 = 全晴');
  assert.equal(weather.kindOf(1), 'partly', '1 = 大部晴，仍有云，不与 0 合并');
  assert.equal(weather.kindOf(2), 'partly', '2 = 多云间晴');
  assert.equal(weather.kindOf(3), 'cloud', '3 = 阴，全天无直射');
});

test('kindOf：雾 / 毛毛雨 / 雨 / 雪 / 雷暴的每一档都覆盖到', () => {
  assert.equal(weather.kindOf(45), 'fog');
  assert.equal(weather.kindOf(48), 'fog', '雾凇雾同样贴地挡视线');
  for (const code of [51, 53, 55, 56, 57]) {
    assert.equal(weather.kindOf(code), 'drizzle', `毛毛雨/冻毛毛雨 ${code}`);
  }
  for (const code of [61, 63, 65, 66, 67, 80, 81, 82]) {
    assert.equal(weather.kindOf(code), 'rain', `雨/冻雨/阵雨 ${code}`);
  }
  for (const code of [71, 73, 75, 77, 85, 86]) {
    assert.equal(weather.kindOf(code), 'snow', `雪/雪粒/阵雪 ${code}`);
  }
  for (const code of [95, 96, 99]) {
    assert.equal(weather.kindOf(code), 'storm', `雷暴 ${code}`);
  }
});

test('kindOf：表外的代码、非整数、空值一律 null（不猜最近的一类）', () => {
  for (const code of [4, 10, 30, 40, 50, 60, 70, 79, 90, 100, -1]) {
    assert.equal(weather.kindOf(code), null, `${code} 不在表内`);
  }
  assert.equal(weather.kindOf(4.5), null, '非整数只可能是坏数据');
  assert.equal(weather.kindOf('abc'), null);
  assert.equal(weather.kindOf(''), null, 'Number("") === 0，不挡的话「没有代码」会变成「晴」');
  assert.equal(weather.kindOf('   '), null, '空白串同样不能读成 0');
  assert.equal(weather.kindOf(null), null);
  assert.equal(weather.kindOf(undefined), null);
  assert.equal(weather.kindOf({}), null);
  assert.equal(weather.kindOf('2'), 'partly', '字符串数字照认（JSON 里的 code 偶尔是字符串）');
  assert.equal(weather.kindOf(' 95 '), 'storm', '两侧空白不影响');
});

// ---------------------------------------------------------------- 请求描述

test('geocodeRequest：中文城市名按 UTF-8 percent-encode，只描述请求不发请求', () => {
  const req = weather.geocodeRequest('杭州');
  assert.equal(req.url,
    'https://geocoding-api.open-meteo.com/v1/search' +
    '?name=%E6%9D%AD%E5%B7%9E&count=1&language=zh&format=json');
  assert.ok(req.url.indexOf('name=%E6%9D%AD%E5%B7%9E') > 0, '没编码的话 libsoup 会再编一次变乱码');
  assert.equal(weather.geocodeRequest('  杭州  ').url, req.url, '两侧空白先 trim');
  assert.equal(weather.geocodeRequest(''), null, '空城市不发空查询');
  assert.equal(weather.geocodeRequest(null), null);
});

test('forecastRequest：坐标四位小数、时区 auto、四天预报；越界或非数字返回 null', () => {
  const req = weather.forecastRequest(30.29365, 120.16142);
  assert.ok(req.url.indexOf('latitude=30.2937&longitude=120.1614') > 0, '四舍五入到 4 位');
  assert.ok(req.url.indexOf('current=temperature_2m,apparent_temperature,weather_code') > 0);
  assert.ok(req.url.indexOf('daily=weather_code,temperature_2m_max,temperature_2m_min') > 0);
  assert.ok(req.url.indexOf('timezone=auto') > 0, '日界要按坐标的本地时区算');
  assert.ok(req.url.indexOf('forecast_days=4') > 0);

  assert.equal(weather.forecastRequest(91, 120), null, '纬度越界');
  assert.equal(weather.forecastRequest(30, 181), null, '经度越界');
  assert.equal(weather.forecastRequest(null, 120), null);
  assert.equal(weather.forecastRequest('abc', 120), null);
});

// ---------------------------------------------------------------- parseGeocode

test('parseGeocode：正常响应取第一个候选，name/country/lat/lon 齐全', () => {
  assert.deepEqual(weather.parseGeocode(GEOCODE_OK), {
    name: '杭州',
    country: '中国',
    lat: 30.29365,
    lon: 120.16142
  });
});

test('parseGeocode：缺 country 允许（小镇没有国家字段），但 name/坐标缺一不可', () => {
  const noCountry = JSON.stringify({
    results: [{ name: 'Kerguelen', latitude: -49.35, longitude: 70.22 }]
  });
  assert.deepEqual(weather.parseGeocode(noCountry), {
    name: 'Kerguelen', country: null, lat: -49.35, lon: 70.22
  });

  const noName = JSON.stringify({ results: [{ latitude: 30.1, longitude: 120.1 }] });
  assert.equal(weather.parseGeocode(noName), null, '没有名字的候选点无法在 UI 上确认');
});

test('parseGeocode：空 results / 没有 results 键 / 空数组 → null（查不到就是查不到）', () => {
  assert.equal(weather.parseGeocode('{"generationtime_ms":0.5}'), null);
  assert.equal(weather.parseGeocode('{"results":[]}'), null);
  assert.equal(weather.parseGeocode('{"results":null}'), null);
  assert.equal(weather.parseGeocode('{"results":"杭州"}'), null, 'results 不是数组');
});

test('parseGeocode：半截 JSON / 空串 / HTML 错误页 → null，不抛异常', () => {
  assert.equal(weather.parseGeocode('{"results":[{"name":"杭州","latit'), null);
  assert.equal(weather.parseGeocode(''), null);
  assert.equal(weather.parseGeocode('   '), null);
  assert.equal(weather.parseGeocode(null), null);
  assert.equal(weather.parseGeocode('<html><body>502 Bad Gateway</body></html>'), null);
  assert.equal(weather.parseGeocode('[1,2,3]'), null, '顶层是数组不是对象');
});

test('parseGeocode：缺 lat / lat 越界 / lon 非数字 → null（没坐标第二跳没法发）', () => {
  const noLat = JSON.stringify({ results: [{ name: '杭州', longitude: 120.16 }] });
  assert.equal(weather.parseGeocode(noLat), null);

  const badLat = JSON.stringify({ results: [{ name: '杭州', latitude: 999, longitude: 120.16 }] });
  assert.equal(weather.parseGeocode(badLat), null, '999 纬度只可能是坏数据');

  const badLon = JSON.stringify({ results: [{ name: '杭州', latitude: 30.29, longitude: 'abc' }] });
  assert.equal(weather.parseGeocode(badLon), null);

  const nullLat = JSON.stringify({ results: [{ name: '杭州', latitude: null, longitude: 120.16 }] });
  assert.equal(weather.parseGeocode(nullLat), null, 'null 不能当 0 用');
});

// ---------------------------------------------------------------- parseForecast

test('parseForecast：正常响应取出当前气温/体感/分组 + 四日预报', () => {
  const f = weather.parseForecast(FORECAST_OK);
  assert.equal(f.tempC, 21.4);
  assert.equal(f.apparentC, 21);
  assert.equal(f.kind, 'partly', 'weather_code 2 = 多云间晴');
  assert.equal(f.highC, 23.1, 'highC 恒等于 days[0] 的 max');
  assert.equal(f.lowC, 15.2);
  assert.equal(f.days.length, 4);
  assert.deepEqual(f.days[0], { date: '2026-10-29', maxC: 23.1, minC: 15.2, kind: 'partly' });
  assert.deepEqual(f.days[1], { date: '2026-10-30', maxC: 20.4, minC: 14.8, kind: 'rain' });
  assert.equal(f.days[3].date, '2026-11-01', '跨月日期原样保留');
  assert.equal(f.updatedAt, '2026-10-29T17:30', '观测时间取服务端的 current.time，不拿本机时钟');
});

test('parseForecast：缺 current / current 里没有气温 → null（不给 UI 任何数字）', () => {
  assert.equal(weather.parseForecast(forecastWithout('current')), null);
  assert.equal(weather.parseForecast(forecastWithout('current.temperature_2m')), null,
    '0°C 不能冒充「取不到」');
  assert.equal(weather.parseForecast('{"current":null,"daily":{}}'), null);
  assert.equal(weather.parseForecast('{"current":"21.4"}'), null, 'current 不是对象');

  const blank = JSON.parse(FORECAST_OK);
  blank.current.temperature_2m = '';
  assert.equal(weather.parseForecast(JSON.stringify(blank)), null, '空串不是 0°C');
});

test('parseForecast：缺 daily / daily 的平行数组不是数组 → null', () => {
  assert.equal(weather.parseForecast(forecastWithout('daily')), null);
  assert.equal(weather.parseForecast(forecastWithout('daily.temperature_2m_max')), null);
  assert.equal(weather.parseForecast(forecastWithout('daily.time')), null);
  assert.equal(weather.parseForecast('{"current":{"temperature_2m":21.4},"daily":[]}'), null);
});

test('parseForecast：四个数组长度不一 → 按最短截断，不补也不越界', () => {
  const data = JSON.parse(FORECAST_OK);
  data.daily.temperature_2m_max = [23.1, 20.4, 24.9];        // 比 time 少一天
  const f = weather.parseForecast(JSON.stringify(data));
  assert.equal(f.days.length, 3, '第 4 天没有任何温度可用，编一个就是假数据');
  assert.equal(f.days[2].date, '2026-10-31');
  assert.equal(f.highC, 23.1);

  // 反过来：code 数组比 time 短，同样按最短截断
  const shorter = JSON.parse(FORECAST_OK);
  shorter.daily.weather_code = [2];
  const g = weather.parseForecast(JSON.stringify(shorter));
  assert.equal(g.days.length, 1);
  assert.equal(g.days[0].kind, 'partly');
  assert.equal(g.updatedAt, '2026-10-29T17:30', 'daily 缩水不影响 current 段');
});

test('parseForecast：时间非法的那一天被跳过；全都不合法则整条 null', () => {
  const data = JSON.parse(FORECAST_OK);
  data.daily.time = ['2026-02-30', '2026-10-30', 'not-a-date', '2026-11-01'];
  const f = weather.parseForecast(JSON.stringify(data));
  assert.equal(f.days.length, 2, '2-30 与 not-a-date 都是假日期，不补');
  assert.deepEqual(f.days.map((d) => d.date), ['2026-10-30', '2026-11-01']);
  assert.equal(f.highC, 20.4, 'highC 跟着 days[0] 走，两者永不打架');

  const allBad = JSON.parse(FORECAST_OK);
  allBad.daily.time = ['2026-02-30', 'x', 'y', 'z'];
  assert.equal(weather.parseForecast(JSON.stringify(allBad)), null);

  const emptyDaily = JSON.parse(FORECAST_OK);
  emptyDaily.daily.time = [];
  emptyDaily.daily.weather_code = [];
  emptyDaily.daily.temperature_2m_max = [];
  emptyDaily.daily.temperature_2m_min = [];
  assert.equal(weather.parseForecast(JSON.stringify(emptyDaily)), null, '一天都没有 = 四日预报不可用');
});

test('parseForecast：坏的一天只丢那一天；kind/apparentC 缺失时降级为 null 而不是 0', () => {
  const data = JSON.parse(FORECAST_OK);
  data.daily.temperature_2m_max = [23.1, null, 24.9, 25.6];   // 中间那天缺最高温
  data.current.apparent_temperature = null;                    // 体感缺失
  data.current.weather_code = 42;                              // 表外代码
  data.current.time = '2026-10-29T25:99';                      // 非法时刻
  const f = weather.parseForecast(JSON.stringify(data));
  assert.equal(f.days.length, 3, '缺温度的那天被跳过');
  assert.deepEqual(f.days.map((d) => d.date), ['2026-10-29', '2026-10-31', '2026-11-01']);
  assert.equal(f.apparentC, null, '体感取不到就是 null，不能写成 0');
  assert.equal(f.kind, null, '42 不在 WMO 表内，图标给「未知」');
  assert.equal(f.updatedAt, null, '25:99 不是合法时刻');
  assert.equal(f.tempC, 21.4, '但这些都不影响已知的气温');
});

test('parseForecast：半截 JSON / 空串 / 顶层是数组 → null', () => {
  assert.equal(weather.parseForecast('{"current":{"temperature_2m":21.4},"dail'), null);
  assert.equal(weather.parseForecast(''), null);
  assert.equal(weather.parseForecast(null), null);
  assert.equal(weather.parseForecast('[]'), null);
  assert.equal(weather.parseForecast('{"error":true,"reason":"Invalid date format"}'), null,
    'Open-Meteo 的错误响应不能当预报读');
});

// ---------------------------------------------------------------- 异步兜底（node 里没有 GI）

test('fetchWeather：城市为空同步 cb(null)；node 里没有 Soup 也是 cb(null) 且不抛', () => {
  let emptyCalls = 0;
  let emptyArg = 'not-set';
  assert.doesNotThrow(() => {
    const h = weather.fetchWeather('', (v) => { emptyCalls++; emptyArg = v; });
    assert.equal(h, null, '空城市连句柄都没有');
  });
  assert.equal(emptyCalls, 1, '必须回调，且只回调一次');
  assert.equal(emptyArg, null, '城市没配就是不可用，不拿默认城市顶替');

  weather.resetForTests();
  let result = 'not-set';
  let calls = 0;
  assert.doesNotThrow(() => {
    weather.fetchWeather('杭州', (v) => { calls++; result = v; });
  });
  assert.equal(result, null, '没有 Soup → 不可用，不是 0°C');
  assert.equal(calls, 1);

  // 失败后 60s 安静期：再问一次同样只回 null，且不会重复尝试
  let again = 'not-set';
  weather.fetchWeather('杭州', (v) => { again = v; });
  assert.equal(again, null, '安静期内直接回不可用');
  assert.equal(weather.FAIL_BACKOFF_MS, 60000);
  assert.equal(weather.WEATHER_CACHE_MS, 600000, '成功缓存 10 分钟');
  assert.equal(weather.HTTP_TIMEOUT_SEC, 4);
});
