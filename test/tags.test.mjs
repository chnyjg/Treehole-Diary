// 「只保留正文里的 #标签」验证：旧元信息行要被摘掉，索引标签要照常收集。
// 用 esbuild 把纯 TS 模块打成临时 CJS 后 require，测的就是线上那份实现，不是复刻。
//
// 运行：node test/tags.test.mjs

import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), "td-tags-"));
try {
  const out = join(tmp, "tags.cjs");
  await build({
    entryPoints: [join(__dirname, "../src/tags.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: out,
    logLevel: "silent",
  });
  const { stripLegacyTagLines, collectTags } = require(out);

  // 真实落盘结构：单日文件 + 两篇日记 + --- 分隔线
  const daily = [
    "# 2026-11-10",
    "",
    "- 标签：姥姥姥爷",
    "#姥姥姥爷 ",
    " ",
    "前几天，姥姥姥爷在小区外面一家店里被骗了一万多块钱。",
    "",
    "---",
    "",
    "- 标签：杨博远",
    "#杨博远 ",
    "10月底的一天，杨博远说身体不舒服。",
  ].join("\n");

  const cleaned = stripLegacyTagLines(daily);
  assert.ok(!cleaned.includes("- 标签："), "旧元信息行必须被摘掉");
  assert.ok(cleaned.includes("#姥姥姥爷 "), "正文里的 #标签 必须原样保留");
  assert.ok(cleaned.includes("#杨博远 "), "第二篇的 #标签 也必须原样保留");
  assert.equal(
    cleaned.split("\n").length,
    daily.split("\n").length - 2,
    "只删两行，其余一字不动"
  );
  assert.equal(stripLegacyTagLines(cleaned), cleaned, "重复执行应幂等");
  assert.equal(
    cleaned.replace(/- 标签：\S*\n/g, ""),
    cleaned,
    "不能靠全局替换误伤正文"
  );

  // 用户自己在正文里写的同形文字（不在段首）不能删
  const prose = [
    "# 2026-11-10",
    "",
    "正文一段",
    "- 标签：这是我自己写的",
    "结束",
  ].join("\n");
  assert.equal(stripLegacyTagLines(prose), prose, "正文中间的同形行不动");

  // 汇总稿（## 日期 + --- 分隔）同样能摘掉
  const bundle = [
    "# all_entries_text(2026.11.10)",
    "",
    "## 2026-11-10",
    "- 标签：姥姥姥爷",
    "#姥姥姥爷 ",
    "",
    "---",
    "",
    "- 标签：杨博远",
    "#杨博远 ",
  ].join("\n");
  assert.ok(!stripLegacyTagLines(bundle).includes("- 标签："), "汇总稿也要干净");

  // 索引标签：历史文件（有旧行）与新版文件（只有 #标签）都要能收集到
  assert.deepEqual(collectTags(daily), ["姥姥姥爷", "杨博远"]);
  assert.deepEqual(collectTags(cleaned), ["姥姥姥爷", "杨博远"]);
  assert.deepEqual(
    collectTags("- 标签：姥姥姥爷,杨博远\n"),
    ["姥姥姥爷", "杨博远"],
    "旧行里的逗号分隔标签"
  );
  assert.deepEqual(
    collectTags("今天 #带娃，出门 #买菜。"),
    ["带娃", "买菜"],
    "句中 #标签 与尾部标点"
  );
  assert.deepEqual(collectTags("# 2026-11-10\n##小标题\n"), [], "标题不算标签");
  assert.deepEqual(
    collectTags("色号 #FF0000 和 #123 以及 http://x/#anchor"),
    [],
    "色号 / 纯数字 / URL 锚点不算标签"
  );
  console.log("tags: 标签摘除与索引收集用例全部通过");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
