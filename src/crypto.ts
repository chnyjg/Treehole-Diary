import * as crypto from "crypto";

/**
 * 树洞日记加密兼容层
 * - 日记解密：必须与 Android 端 com.example.diarymailer.crypto.DiaryCrypto 完全一致
 *   KDF : PBKDF2-HMAC-SHA1, salt="liuhen_diary_v1", iter=20000, dklen=32
 *   算法: AES-256-GCM, IV=12 字节(前缀), tag=16 字节(尾附)
 *   文本: Base64(NO_WRAP) 的 (IV ‖ 密文 ‖ tag)
 * - 引导文件(.shudong)：独立的信封格式，用一次性口令加密，与日记加密互不干扰
 */

// ---------- 日记解密（兼容 Android） ----------
export const DIARY_SALT = "liuhen_diary_v1";
const DIARY_ITER = 20000;

export function deriveDiaryKey(authCode: string): Buffer {
  return crypto.pbkdf2Sync(
    authCode,
    Buffer.from(DIARY_SALT, "utf-8"),
    DIARY_ITER,
    32,
    "sha1"
  );
}

/**
 * v2 固定日记密钥：Base64（32 字节）→ 密钥。
 * 与授权码解绑 —— 新邮件一律用它加解密，不随授权码变化。
 * 格式不对（长度≠32）抛异常，调用方应跳过并回退 deriveKey 链。
 */
export function keyFromBase64(b64: string): Buffer {
  const buf = Buffer.from(b64.trim(), "base64");
  if (buf.length !== 32) {
    throw new Error(`diaryKey 长度应为 32 字节，实际 ${buf.length}`);
  }
  return buf;
}

export function decryptDiaryBytes(key: Buffer, data: Buffer): Buffer {
  const iv = data.subarray(0, 12);
  const tag = data.subarray(data.length - 16);
  const ct = data.subarray(12, data.length - 16);
  const dec = crypto.createDecipheriv("aes-256-gcm", key, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]);
}

export function decryptDiaryText(key: Buffer, b64: string): string {
  return decryptDiaryBytes(key, Buffer.from(b64, "base64")).toString("utf-8");
}

// ---------- 引导文件信封（.shudong） ----------
export interface DiaryConfig {
  email: string;
  imapHost: string;
  authCode: string;
}

export interface Envelope {
  v: 1;
  alg: string;
  salt: string; // base64
  iv: string; // base64
  ct: string; // base64，含密文 + 尾附 tag
  hint?: string;
}

// 引导文件用同样的 KDF 参数，但盐随机每文件生成，种子是一次性口令（与日记授权码无关）
export function encryptEnvelope(config: DiaryConfig, passphrase: string): Envelope {
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(passphrase, salt, DIARY_ITER, 32, "sha1");
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

export function decryptEnvelope(env: Envelope, passphrase: string): DiaryConfig {
  if (env.v !== 1) throw new Error("不支持的信封版本");
  const salt = Buffer.from(env.salt, "base64");
  const key = crypto.pbkdf2Sync(passphrase, salt, DIARY_ITER, 32, "sha1");
  const iv = Buffer.from(env.iv, "base64");
  const data = Buffer.from(env.ct, "base64");
  const tag = data.subarray(data.length - 16);
  const ct = data.subarray(0, data.length - 16);
  const dec = crypto.createDecipheriv("aes-256-gcm", key, iv);
  dec.setAuthTag(tag);
  const json = Buffer.concat([dec.update(ct), dec.final()]).toString("utf-8");
  return JSON.parse(json) as DiaryConfig;
}
