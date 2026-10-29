'use strict';

// CJS 目录入口。
//
// 起因：node ≥22 把 `--test` 的位置参数当 glob 处理，`node --test tests/` 里的 `tests/` 匹配到目录本身，
// 于是被当成「一个待执行的测试文件」去加载并报 MODULE_NOT_FOUND。有了本文件，CJS 的目录解析会落到
// index.js，所有 *.test.js 在这里被 require，测试照常在同一个子进程里注册与运行。
//
// 用动态遍历而不是硬编码 require：tests/ 目录是多人共写的，新增测试文件不需要改这里。

const fs = require('node:fs');
const path = require('node:path');

for (const file of fs.readdirSync(__dirname).sort()) {
  if (file.endsWith('.test.js')) require(path.join(__dirname, file));
}
