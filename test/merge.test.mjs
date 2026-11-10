// 同步落盘链路集成测试：用内存假 vault 跑真正的 writeOutputs，
// 验证「单日文件 / 汇总稿只留 #标签」「index 仍有标签」「历史文件自动摘除旧行」。
//
// 运行：node test/merge.test.mjs

import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), "td-merge-"));

function makeVault() {
  const store = new Map();
  const dirs = new Set();
  const adapter = {
    async exists(p) {
      return store.has(p) || dirs.has(p);
    },
    async mkdir(p) {
      dirs.add(p);
    },
    async remove(p) {
      store.delete(p);
    },
    async write(p, data) {
      store.set(p, String(data));
    },
    async read(p) {
      if (!store.has(p)) throw new Error("missing " + p);
      return store.get(p);
    },
    async list(dir) {
      const files = [...store.keys()].filter(
        (p) => p.startsWith(dir + "/") && !p.slice(dir.length + 1).includes("/")
      );
      return { files, folders: [] };
    },
  };
  return {
    store,
    app: {
      vault: {
        adapter,
        createBinary: async (p, data) => {
          store.set(p, data);
        },
      },
    },
  };
}

try {
  const out = join(tmp, "merge.cjs");
  await build({
    entryPoints: [join(__dirname, "../src/merge.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: out,
    logLevel: "silent",
  });
  const { writeOutputs } = require(out);

  const OUT = "树洞日记";
  const diaries = [
    {
      date: "2026-11-10",
      tags: "姥姥姥爷",
      mood: "",
      body: "#姥姥姥爷 \n \n前几天，姥姥姥爷在小区外面一家店里被骗了。",
      images: [],
    },
    {
      date: "2026-11-10",
      tags: "杨博远",
      mood: "",
      body: "#杨博远 \n10月底的一天，杨博远说身体不舒服。",
      images: [],
    },
  ];

  const vault = makeVault();
  const r = await writeOutputs(vault.app, diaries, OUT, "newest");
  assert.equal(r.days, 1, "应写出 1 天");
  assert.equal(r.entries, 2, "一天 2 篇");

  const daily = vault.store.get(`${OUT}/2026-11-10.md`);
  assert.ok(!daily.includes("- 标签："), "新写的单日文件不能再有重复行");
  assert.ok(daily.includes("#姥姥姥爷"), "正文 #标签 必须在");
  assert.ok(daily.includes("#杨博远"), "第二篇 #标签 必须在");
  assert.ok(
    daily.includes("#杨博远 \n\n10月底"),
    "首行独占一行的 #标签 与正文之间要有空行"
  );
  assert.ok(
    vault.store.get(`${OUT}/all_entries_text.md`).includes("## 2026-11-10\n\n"),
    "汇总稿日期标题后要有空行"
  );
  assert.ok(
    !vault.store.get(`${OUT}/all_entries.md`).includes("- 标签："),
    "带图汇总稿也要干净"
  );
  assert.ok(
    !vault.store.get(`${OUT}/all_entries_text.md`).includes("- 标签："),
    "纯文汇总稿也要干净"
  );
  const index = vault.store.get(`${OUT}/index.md`);
  assert.ok(index.includes("（姥姥姥爷,杨博远）"), "索引链接后缀仍要有标签");
  assert.ok(index.includes("## 标签统计"), "标签统计不能丢");
  assert.ok(index.includes("姥姥姥爷：2 篇"), "统计仍按天计数");

  // 历史文件：邮件已删、本地单日文件是主，同步时也要定点摘掉旧行
  vault.store.set(
    `${OUT}/2026-11-09.md`,
    "# 2026-11-09\n\n- 标签：旧标签\n#旧标签 \n \n旧日记正文\n"
  );
  await writeOutputs(vault.app, diaries, OUT, "newest");
  const legacy = vault.store.get(`${OUT}/2026-11-09.md`);
  assert.ok(!legacy.includes("- 标签："), "历史文件的重复行要被摘掉");
  assert.ok(legacy.includes("#旧标签"), "历史正文的 #标签 要保留");
  assert.ok(legacy.includes("旧日记正文"), "历史正文其余内容一字不动");
  assert.ok(
    !vault.store.get(`${OUT}/all_entries_text.md`).includes("- 标签："),
    "汇总稿里历史记录也干净"
  );
  assert.ok(
    vault.store.get(`${OUT}/index.md`).includes("旧标签"),
    "历史标签仍进索引统计"
  );
  console.log("merge: 同步落盘链路用例全部通过");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
