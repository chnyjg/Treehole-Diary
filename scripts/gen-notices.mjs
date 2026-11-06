import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 生成第三方依赖许可证声明。运行前先 npm ci，publish 时把结果一起提交。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const licensesDir = path.join(root, "licenses");
fs.mkdirSync(licensesDir, { recursive: true });

const candidates = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENCE",
  "LICENSE-MIT",
  "license",
  "license.md",
];

const rows = [];
for (const [key, meta] of Object.entries(lock.packages || {})) {
  if (!key.startsWith("node_modules/") || meta.dev) continue;
  const dir = path.join(root, key);
  const name = key.split("node_modules/").pop();
  const version = meta.version || "unknown";
  let license = meta.license || "UNKNOWN";
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    license = pj.license || license;
  } catch {
    /* use lockfile value */
  }

  let text = null;
  for (const c of candidates) {
    const p = path.join(dir, c);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      text = fs.readFileSync(p, "utf8");
      break;
    }
  }
  if (!text) {
    text = `No LICENSE file shipped with this package.\nDeclared license: ${license}\n`;
  }

  const file = `${name.replace(/[^A-Za-z0-9._-]/g, "_")}@${version}.txt`;
  fs.writeFileSync(path.join(licensesDir, file), text);
  const copyright = (text.match(/Copyright[^\n]{0,160}/i) || [])[0] || "-";
  rows.push({ name, version, license, copyright, file });
}

rows.sort((a, b) => a.name.localeCompare(b.name));
const lines = [
  "# Third-party notices",
  "",
  "本项目自身采用 MIT 许可证（见根目录 LICENSE）。以下第三方包被 esbuild 打包进 `main.js`，其许可证全文保存在 `licenses/` 目录。",
  "",
  "| Package | Version | License | Copyright / license file |",
  "| --- | --- | --- | --- |",
  ...rows.map(
    (r) =>
      `| ${r.name} | ${r.version} | ${r.license} | [${r.file}](licenses/${r.file}) |`
  ),
  "",
  `共 ${rows.length} 个运行时依赖。升级依赖后运行 \`npm run notices\` 重新生成。`,
  "",
];
fs.writeFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), lines.join("\n"));
console.log(`已生成 THIRD_PARTY_NOTICES.md 与 ${rows.length} 份许可证全文`);
