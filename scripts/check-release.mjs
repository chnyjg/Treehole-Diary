import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
const errors = [];
const warnings = [];

const manifest = readJson("manifest.json");
const pkg = readJson("package.json");
const versions = readJson("versions.json");

if (manifest.version !== pkg.version) {
  errors.push(`版本不一致：manifest.json=${manifest.version}，package.json=${pkg.version}`);
}
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  errors.push("版本号必须是 x.y.z，且 Release tag 不带 v 前缀");
}
if (!Object.prototype.hasOwnProperty.call(versions, manifest.version)) {
  errors.push(`versions.json 缺少 ${manifest.version} 条目`);
} else if (versions[manifest.version] !== manifest.minAppVersion) {
  errors.push(
    `versions.json["${manifest.version}"]=${versions[manifest.version]}，应等于 minAppVersion=${manifest.minAppVersion}`
  );
}

for (const f of ["README.md", "LICENSE", "manifest.json", "versions.json", "main.js", "styles.css"]) {
  if (!fs.existsSync(path.join(root, f))) errors.push(`缺少必需文件 ${f}`);
}

if (!/^[A-Za-z0-9 +()\-]+$/.test(manifest.name)) {
  errors.push("manifest.name 含非 Basic Latin 字符（官方要求英文，不能用中文）");
}
if (!/^[a-z0-9-]+$/.test(manifest.id) || manifest.id.includes("obsidian") || manifest.id.endsWith("plugin")) {
  errors.push("manifest.id 只能含小写字母与连字符，不能含 obsidian、不能以 plugin 结尾");
}
const desc = manifest.description || "";
if (desc.length > 250 || !desc.endsWith(".")) {
  errors.push("description 必须不超过 250 字符且以英文句号 . 结尾");
}
if (/[^\x00-\x7F]/.test(desc)) {
  warnings.push("description 含非 ASCII 字符，官方建议全英文");
}
if (manifest.isDesktopOnly !== true) {
  errors.push("源码使用 Node.js 的 crypto / IMAP API，isDesktopOnly 必须为 true");
}
if (Object.prototype.hasOwnProperty.call(manifest, "fundingUrl")) {
  warnings.push("未接受捐赠时请删除 fundingUrl");
}

const src = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
const commandIds = [...src.matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]);
if (commandIds.some((id) => id.includes(manifest.id))) {
  errors.push("命令 ID 不应包含插件 ID，Obsidian 会自动加前缀");
}

if (fs.existsSync(path.join(root, "README.md"))) {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const cjk = (readme.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (readme.match(/[A-Za-z]/g) || []).length;
  if (cjk > latin * 0.2) {
    warnings.push("README.md 建议以英文为主（Auto Scan 会提示 README does not appear to contain English text）");
  }
  if (!/network use/i.test(readme)) {
    errors.push("README.md 缺少网络使用披露章节（开发者政策要求）");
  }
}
if (!fs.existsSync(path.join(root, "README.zh-CN.md"))) {
  warnings.push("缺少 README.zh-CN.md 中文说明");
}

console.log(`目标版本 ${manifest.version} · Release tag 应为 ${manifest.version}（不带 v）`);
console.log("Release 附件：main.js、manifest.json、styles.css");
for (const w of warnings) console.log(`⚠️  ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`❌ ${e}`);
  process.exit(1);
}
console.log("✅ 上架前自检通过（网络与文件访问披露请确认 README 中已写明）");
