/**
 * 「日记邮件」识别规则（纯函数，无 IMAP 依赖，便于单测）。
 *
 * 主题规则必须与 imap.ts 的 fetchDiaries 完全一致，否则会出现
 * 「同步读得到、清理却没删」；更不能放宽，否则会误删别的邮件。
 * App 发出的主题形如 `Log [标签] 2026-11-04`（见 MailSender.buildSubject）。
 *
 * 再加一道保险：发件人必须是本账号（App 用配置里的 account 发给自己）。
 * 这样即使别人恰好发来一封同格式主题的邮件也不会被删。
 * 原则：宁可漏删（还能去邮箱手动删），不可误删（不可恢复）。
 */
export const DIARY_SUBJECT_RE = /^Log\b[^\n]*?(\d{4}-\d{2}-\d{2})/;

export function isDiaryMail(
  subject: string,
  fromAddress: string,
  accountEmail: string
): boolean {
  if (!DIARY_SUBJECT_RE.test(subject || "")) return false;
  const from = (fromAddress || "").trim().toLowerCase();
  const acct = (accountEmail || "").trim().toLowerCase();
  // 发件人为空（少数服务器 envelope 缺 from）时不放行。
  if (!from || !acct) return false;
  return from === acct;
}
