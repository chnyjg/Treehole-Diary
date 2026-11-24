// 日记照片测试：markdown 直接引用原图（src = 原图），方形显示交给 CSS；
// 验证不再生成方图文件、不写嵌套链接、图片上下留空行，以及 CSS 裁方规则存在。
// 运行：node test/diary-image.test.mjs

import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), "td-image-"));

function makeVault() {
  const store = new Map();
  const dirs = new Set();
  const adapter = {
    async exists(p) { return store.has(p) || dirs.has(p); },
    async mkdir(p) { dirs.add(p); },
    async remove(p) { store.delete(p); },
    async write(p, data) { store.set(p, String(data)); },
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
    app: { vault: { adapter, createBinary: async (p, data) => { store.set(p, data); } } },
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
  const vault = makeVault();
  await writeOutputs(vault.app, [
    {
      date: "2026-11-24",
      tags: "摄影",
      mood: "",
      body: "前缀 {{IMG:1}} 后面。",
      images: [{ name: "IMG_0001.JPG", data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }],
    },
  ], OUT, "newest");

  const daily = vault.store.get(`${OUT}/2026-11-24.md`);
  assert.ok(
    daily.includes("![照片1|300](assets/2026-11-24/photo1.JPG)"),
    "markdown 必须直接引用原图：" + daily
  );
  assert.ok(!daily.includes("[!["), "不能写成嵌套链接（点开会是内层方图）：" + daily);
  assert.ok(!daily.includes("s_photo"), "不能再引用方图文件：" + daily);
  assert.ok(vault.store.has(`${OUT}/assets/2026-11-24/photo1.JPG`), "原图必须写盘");
  assert.ok(
    ![...vault.store.keys()].some((p) => p.includes("s_photo")),
    "不能再生成 s_photoN.jpg 方图文件"
  );

  const plain = vault.store.get(`${OUT}/all_entries_text.md`);
  assert.ok(plain.includes("[照片1]"), "纯文版换成 [照片1]");
  assert.ok(!plain.includes("!["), "纯文版不能残留图片语法：" + plain);

  // 图片上下各留一个空行：原本没空行会补，已有空行不堆叠。
  const IMG = "![照片1|300](assets/2026-11-24/photo1.jpg)";
  const expected = `前一段\n\n${IMG}\n\n后一段`;
  for (const [name, body] of [
    ["没空行", "前一段\n{{IMG:1}}\n后一段"],
    ["已有空行", "前一段\n\n{{IMG:1}}\n\n后一段"],
  ]) {
    const v = makeVault();
    await writeOutputs(v.app, [
      { date: "2026-11-24", tags: "", mood: "", body,
        images: [{ name: "a.jpg", data: Buffer.from([1]) }] },
    ], OUT, "newest");
    assert.ok(
      v.store.get(`${OUT}/2026-11-24.md`).includes(expected),
      `${name}时图片上下各留一个空行`
    );
  }

  // CSS 必须把 markdown 正文里的日记照片裁成方形，且不能框住看图器弹窗。
  const css = readFileSync(join(__dirname, "../styles.css"), "utf8");
  assert.match(css, /\.markdown-reading-view img\[alt\^="照片"\]/, "CSS 要限定 markdown 正文区");
  assert.match(css, /object-fit:\s*cover\s*!important/, "CSS 要用 object-fit:cover 裁方");
  assert.ok(!/\.image-viewer[\s\S]{0,200}object-fit:\s*cover/.test(css), "不能裁到图片查看器");

  console.log("diary-image: 原图引用 + CSS 方形缩略用例全部通过");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
