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
  // ---- 解密密钥链 ----
  // diaryKey：v2 固定日记密钥，与授权码解绑 —— 邮件一律用它加解密。
  // 授权码派生密钥保留作兜底（未带 diaryKey 的老配置仍可解）。逐把尝试，GCM 校验失败即换下一把。
  const keys: Buffer[] = [];
  const dk = (acct.diaryKey || "").trim();
  if (dk) {
    try {
      keys.push(keyFromBase64(dk));
    } catch {
      // diaryKey 格式坏（手抄错等）→ 跳过，走授权码兜底
    }
  }
  keys.push(deriveDiaryKey(acct.authCode));

  // 登录只用当前授权码（v2 之前的测试邮件无需同步，不再做备选码登录兜底）。
  const passwords = [acct.authCode];

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
