// 「删除日记邮件」识别规则验证：删错一封就不可恢复，所以规则必须单独可测。
// 用 esbuild 把纯 TS 模块打成临时 CJS 后 require，测的就是线上那份实现，不是复刻。
//
// 运行：node test/cleanup_filter.test.mjs

import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), "td-cleanup-"));
try {
  const out = join(tmp, "diaryMail.cjs");
  await build({
    entryPoints: [join(__dirname, "../src/diaryMail.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: out,
    logLevel: "silent",
  });
  const { isDiaryMail } = require(out);

  const ACCT = "me@qq.com";
  const cases = [
    ["Log [日常] 2026-11-09", "me@qq.com", true, "标准日记邮件"],
    ["Log [导入] 2026-11-04", "ME@QQ.COM", true, "发件人大小写不敏感"],
    ["Log 2026-11-09", "me@qq.com", true, "无标签也命中"],
    ["Blog 2026-11-09", "me@qq.com", false, "Blog 不能命中（历史 bug）"],
    ["Login 2026-11-09", "me@qq.com", false, "Login 不能命中（历史 bug）"],
    ["Catalog 2026-11-09", "me@qq.com", false, "Catalog 不能命中"],
    ["Log [日常] 无日期", "me@qq.com", false, "缺完整日期不放行"],
    ["请查收 2026-11-09", "me@qq.com", false, "不以 Log 开头"],
    ["Log [日常] 2026-11-09", "other@qq.com", false, "别人发来的同格式邮件必须保留"],
    ["Log [日常] 2026-11-09", "", false, "发件人为空不放行"],
    ["", "me@qq.com", false, "空主题不放行"],
    ["Log [日常] 2026-11-09", "me@qq.com ", true, "发件人带空格"],
  ];
  for (const [subject, from, expected, label] of cases) {
    assert.equal(
      isDiaryMail(subject, from, ACCT),
      expected,
      `用例失败：${label}（${subject} / ${from}）`
    );
  }
  console.log(`cleanup_filter: ${cases.length} 个用例全部通过`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
