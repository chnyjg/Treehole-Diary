// 加密对齐验证（独立实现，不依赖 TS 模块）
// 目标：证明 TS/Node 端能解开 Android 端 DiaryCrypto 加密的内容。
//
// 验证两件事：
//   1) 密钥派生对齐：PBKDF2-HMAC-SHA1(salt=liuhen_diary_v1, iter=20000) 得到的密钥字节
//      与 Python(=Android 同算法) 一致；
//   2) 解密对齐：用该密钥解开 sample.json 里的 Base64 密文，得到原始明文。
//
// 运行：node test/crypto_align.test.mjs

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(
  readFileSync(join(__dirname, "sample.json"), "utf-8")
);

const SALT = Buffer.from("liuhen_diary_v1", "utf-8");
const ITER = 20000;

function deriveKey(auth) {
  return crypto.pbkdf2Sync(auth, SALT, ITER, 32, "sha1");
}

function decryptBytes(key, data) {
  const iv = data.subarray(0, 12);
  const tag = data.subarray(data.length - 16);
  const ct = data.subarray(12, data.length - 16);
  const dec = crypto.createDecipheriv("aes-256-gcm", key, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]);
}

// ---- 验证 1：密钥派生对齐 ----
const nodeKey = deriveKey(sample.authCode);
const okKey = nodeKey.toString("hex") === sample.keyHex;
console.log(
  `[1/2] 密钥派生 ${okKey ? "✅ 一致" : "❌ 不一致"} ` +
    `(Node=${nodeKey.toString("hex").slice(0, 16)}… / Py=${sample.keyHex.slice(0, 16)}…)`
);

// ---- 验证 2：解密对齐 ----
let okDecrypt = false;
let decrypted = "";
try {
  const ct = Buffer.from(sample.b64, "base64");
  decrypted = decryptBytes(nodeKey, ct).toString("utf-8");
  okDecrypt = decrypted === sample.plaintext;
} catch (e) {
  console.log("[2/2] 解密 ❌ 抛异常:", e.message);
}

console.log(
  `[2/2] 解密还原 ${okDecrypt ? "✅ 一致" : "❌ 不一致"}`
);
if (okDecrypt) {
  console.log("      明文 =", JSON.stringify(sample.plaintext));
} else if (decrypted) {
  console.log("      得到 =", JSON.stringify(decrypted));
  console.log("      期望 =", JSON.stringify(sample.plaintext));
}

// ---- 额外：TS 格式自洽（Node 加密 → Node 解密） ----
function encryptBytes(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}
const rt = encryptBytes(nodeKey, sample.plaintext);
const rtBack = decryptBytes(nodeKey, rt).toString("utf-8");
const okRound = rtBack === sample.plaintext;
console.log(`[3/3] Node 端自洽加密/解密 ${okRound ? "✅ 通过" : "❌ 失败"}`);

if (okKey && okDecrypt && okRound) {
  console.log("\n🎉 加密对齐全部通过：TS/Node 可正确解开 Android 端加密的树洞日记。");
  process.exit(0);
} else {
  console.log("\n⚠️  对齐存在不一致，需排查。");
  process.exit(1);
}
