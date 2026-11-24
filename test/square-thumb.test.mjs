// 方图缩略图测试：注入假的 createImageBitmap / canvas，模拟 Obsidian 的 Electron 环境，
// 验证 merge.ts 生成的 markdown 是「方图缩略 + 点击打开原图」的嵌套链接，
// 且纯文汇总稿把整段嵌套链接换成 [照片N]。
//
// 运行：node test/square-thumb.test.mjs

import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), "td-square-"));

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
    app: {
      vault: {
        adapter,
        createBinary: async (p, data) => { store.set(p, data); },
      },
    },
  };
}

function installFakeCanvas() {
  const g = globalThis;
  g.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return {
        width: 0,
        height: 0,
        getContext() {
          return { drawImage() {} };
        },
        toBlob(cb) {
          cb(new Blob([Buffer.from("fake-jpeg")], { type: "image/jpeg" }));
        },
      };
    },
  };
  g.createImageBitmap = async () => ({
    width: 4000,
    height: 3000,
    close() {},
  });
}

try {
  installFakeCanvas();

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
      date: "2026-11-24",
      tags: "摄影",
      mood: "",
      body: " prefixed {{IMG:1}} 后面。",
      images: [{ name: "IMG_0001.JPG", data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }],
    },
  ];

  const vault = makeVault();
  await writeOutputs(vault.app, diaries, OUT, "newest");

  const daily = vault.store.get(`${OUT}/2026-11-24.md`);
  assert.ok(
    daily.includes(
      "[![照片1|300](assets/2026-11-24/s_photo1.jpg)](assets/2026-11-24/photo1.JPG)"
    ),
    "方图缩略图写成嵌套链接，点击指向原图：" + daily
  );
  assert.ok(vault.store.has(`${OUT}/assets/2026-11-24/s_photo1.jpg`), "方图必须写盘");
  assert.ok(vault.store.has(`${OUT}/assets/2026-11-24/photo1.JPG`), "原图也必须写盘");

  const plain = vault.store.get(`${OUT}/all_entries_text.md`);
  assert.ok(plain.includes("[照片1]"), "纯文版要换成 [照片1]");
  assert.ok(!plain.includes("!["), "纯文版不能残留图片语法：" + plain);
  assert.ok(!plain.includes("](") || plain.includes("](../../"), "纯文版不能有嵌套链接残留");

  // 图片上下各留一个空行：独占段落，Obsidian 渲染时与文字有间距。
  // 下面验证「原本没空行会补」「原本有空行不重复堆叠」两种输入都得到同样的效果。
  const IMG = "[![照片1|300](assets/2026-11-24/s_photo1.jpg)](assets/2026-11-24/photo1.jpg)";
  const oneGap = `前一段\n{{IMG:1}}\n后一段`;
  const twoGap = `前一段\n\n{{IMG:1}}\n\n后一段`;
  const expected = `前一段\n\n${IMG}\n\n后一段`;

  const v1 = makeVault();
  await writeOutputs(v1.app, [{ date: "2026-11-24", tags: "", mood: "", body: oneGap,
    images: [{ name: "a.jpg", data: Buffer.from([1]) }] }], OUT, "newest");
  assert.equal(
    v1.store.get(`${OUT}/2026-11-24.md`).includes(expected),
    true,
    "占位符上下没空行时要各补一个：" + v1.store.get(`${OUT}/2026-11-24.md`)
  );

  const v2 = makeVault();
  await writeOutputs(v2.app, [{ date: "2026-11-24", tags: "", mood: "", body: twoGap,
    images: [{ name: "a.jpg", data: Buffer.from([1]) }] }], OUT, "newest");
  assert.equal(
    v2.store.get(`${OUT}/2026-11-24.md`).includes(expected),
    true,
    "占位符上下已有空行时不能重复堆叠：" + v2.store.get(`${OUT}/2026-11-24.md`)
  );

  console.log("square-thumb: 方图嵌套链接用例全部通过");
} finally {
  delete globalThis.document;
  delete globalThis.createImageBitmap;
  rmSync(tmp, { recursive: true, force: true });
}
