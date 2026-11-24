// 日历分档测试：验证有效字数统计（剔除标题/元数据/分隔线/图片语法）与 5 档阈值。
// 运行：node test/calendar.test.mjs

import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), "td-cal-"));

try {
  const out = join(tmp, "calendar.cjs");
  await build({
    entryPoints: [join(__dirname, "../src/calendar.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: out,
    logLevel: "silent",
  });
  const { countDiaryChars, diaryCharLevel } = require(out);

  // 空内容 / 只有标题和图片 → 0 字
  assert.equal(countDiaryChars(""), 0);
  assert.equal(
    countDiaryChars("# 2026-11-24\n\n[![照片1|300](s.jpg)](p.jpg)\n"),
    0,
    "标题和图片链接不能算字数"
  );

  // 新格式：标题 / 心情 / 分隔线 / 方图嵌套链接全部剔除，只数正文
  const md = [
    "# 2026-11-24",
    "",
    "- 心情：晴",
    "",
    "今天写了日记。",
    "",
    "[![照片1|300](assets/2026-11-24/s_photo1.jpg)](assets/2026-11-24/photo1.jpg)",
    "",
    "#生活 #随手记",
    "",
    "---",
    "",
    "第二天内容。",
  ].join("\n");
  assert.equal(countDiaryChars(md), 20, "只统计正文字符（含标点与标签）");

  // 老格式：{{IMG:n}} 与普通图片语法也要剔除
  const old = "# 2026-11-01\n\n{{IMG:1}}\n\n![照片1|480](x.jpg)\n\n- 标签：旧格式\n\n一二三四五六七";
  assert.equal(countDiaryChars(old), 7, "老格式占位与元数据不能算字数");

  // 5 档阈值边界：50 / 100 / 200 / 400
  const cases = [
    [0, 1], [49, 1], [50, 2], [99, 2], [100, 3],
    [199, 3], [200, 4], [399, 4], [400, 5], [2000, 5],
  ];
  for (const [chars, level] of cases) {
    assert.equal(diaryCharLevel(chars), level, `${chars} 字应为第 ${level} 档`);
  }

  console.log("calendar: 字数统计与 5 档分色用例全部通过");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
