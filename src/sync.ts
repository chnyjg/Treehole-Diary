import { App } from "obsidian";
import { fetchDiaries, deriveDiaryKey } from "./imap";
import { keyFromBase64 } from "./crypto";
import { writeOutputs } from "./merge";
import { Account } from "./types";

/**
 * 同步一个账号：登录 IMAP → 拉取并解密 → 写出 Markdown 到 vault 的 outFolder。
 * 返回形如 "3 天 / 5 条" 的摘要，供 UI 提示。
 */
export async function syncAccount(
  acct: Account,
  app: App,
  outFolder: string,
  order: "newest" | "oldest"
): Promise<string> {
  // ---- 解密密钥链（v2 起 diaryKey 优先）----
  // 1) diaryKey：v2 固定日记密钥，与授权码解绑 —— 新邮件一律用它加解密；
  // 2) deriveKey(主授权码)：v1 时代的邮件（升级前用「当时的授权码」加密）；
  // 3) deriveKey(备选码…)：换过授权码的用户，更早的邮件用更旧的码加密。
  // 解密逐把尝试（GCM 校验失败即换下一把），顺序只影响速度不影响正确性。
  const keys: Buffer[] = [];
  const dk = (acct.diaryKey || "").trim();
  if (dk) {
    try {
      keys.push(keyFromBase64(dk));
    } catch {
      // diaryKey 格式坏（手抄错等）→ 跳过，走授权码链兜底
    }
  }
  keys.push(deriveDiaryKey(acct.authCode));

  // 支持「备选授权码」：应对中途重置授权码 / 前段用别的邮箱发，导致旧邮件用不同密钥加密。
  // 备选码可能有多把（每次换授权码都会让旧码失效，但旧码仍是历史邮件的解密密钥），
  // 用逗号分隔，一并派生密钥、逐把尝试登录。
  const altCodes = (acct.altAuthCode || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const alt of altCodes) keys.push(deriveDiaryKey(alt));

  // 登录码逐把尝试：主码失效（如已被重置）时自动回退到备选码，
  // 避免「码换了就完全拉不到信」；解密仍用全部密钥。
  const passwords = [acct.authCode, ...altCodes];

  const diaries = await fetchDiaries(
    acct.email,
    acct.imapHost,
    passwords,
    keys
  );
  if (diaries.length === 0) {
    throw new Error("未找到主题含 Log 的邮件");
  }
  const res = await writeOutputs(app, diaries, outFolder, order);
  return `${res.days} 天 / ${res.entries} 条`;
}
