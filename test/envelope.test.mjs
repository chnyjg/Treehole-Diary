// 引导文件(.shudong)信封格式自测（独立实现，验证我们自己的格式正确）
// 运行：node test/envelope.test.mjs

import crypto from "node:crypto";

const ITER = 20000;

function encryptEnvelope(config, passphrase) {
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(passphrase, salt, ITER, 32, "sha1");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(config), "utf-8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const full = Buffer.concat([ct, tag]);
  return {
    v: 1,
    alg: "PBKDF2-HMAC-SHA1/AES-256-GCM",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ct: full.toString("base64"),
    hint: "树洞日记引导配置",
  };
}

function decryptEnvelope(env, passphrase) {
  if (env.v !== 1) throw new Error("版本不支持");
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

const cfg = { email: "user@example.com", imapHost: "imap.qq.com", authCode: "ABCD1234EFGH5678" };
const pass = "K7M2QP";

const env = encryptEnvelope(cfg, pass);
const back = decryptEnvelope(env, pass);
const okRound = JSON.stringify(back) === JSON.stringify(cfg);

let okWrong = false;
try {
  decryptEnvelope(env, "WRONGPASS");
} catch {
  okWrong = true; // 错误口令必须解密失败
}

console.log(`[1/2] 信封加/解密自洽 ${okRound ? "✅" : "❌"}`);
console.log(`[2/2] 错误口令被拒   ${okWrong ? "✅" : "❌"}`);

if (okRound && okWrong) {
  console.log("\n🎉 信封格式正确：.shudong 可正确加密配置，且错误口令无法解密。");
  process.exit(0);
} else {
  console.log("\n⚠️  信封格式存在问题。");
  process.exit(1);
}
