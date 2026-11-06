// 验证脚本（纯 Node，无需任何依赖）：接收手机导出的 .shudong 文件路径 + 一次性口令，
// 解开并打印内容。用法：node test/verify_envelope_cli.mjs <path> <passphrase>
import { readFileSync } from "fs";
import * as crypto from "crypto";

const ITER = 20000;

function decryptEnvelope(env, passphrase) {
  if (env.v !== 1) throw new Error("不支持的信封版本");
  const salt = Buffer.from(env.salt, "base64");
  const key = crypto.pbkdf2Sync(passphrase, salt, ITER, 32, "sha1");
  const iv = Buffer.from(env.iv, "base64");
  const data = Buffer.from(env.ct, "base64");
  const tag = data.subarray(data.length - 16);
  const ct = data.subarray(0, data.length - 16);
  const dec = crypto.createDecipheriv("aes-256-gcm", key, iv);
  dec.setAuthTag(tag);
  const json = Buffer.concat([dec.update(ct), dec.final()]).toString("utf-8");
  return JSON.parse(json);
}

const [path, pass] = process.argv.slice(2);
if (!path || !pass) {
  console.error("用法：node test/verify_envelope_cli.mjs <shudong文件路径> <一次性口令>");
  process.exit(1);
}

try {
  const env = JSON.parse(readFileSync(path, "utf-8"));
  const cfg = decryptEnvelope(env, pass);
  console.log("✅ 解密成功！Obsidian 插件可读出以下配置：");
  console.log("  email   :", cfg.email);
  console.log("  imapHost:", cfg.imapHost);
  console.log("  authCode:", cfg.authCode.slice(0, 4) + "****（已隐藏）");
} catch (e) {
  console.error("❌ 解密失败：", e.message);
  console.error("   可能原因：口令输错 / 文件损坏 / 文件不是 .shudong 信封");
  process.exit(1);
}
