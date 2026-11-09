import { ImapFlow } from "imapflow";
import { Account } from "./types";
import { isDiaryMail } from "./diaryMail";

export interface DiaryMailHit {
  uid: number;
  subject: string;
}

export interface CleanupResult {
  /** 收件箱里删掉的封数 */
  inbox: number;
  /** 「已删除 / 垃圾箱」里再删掉的封数（部分服务商删除后仍占容量） */
  trash: number;
  trashFolders: string[];
  /** 单个文件夹清理失败只记警告，不影响其它文件夹 */
  warnings: string[];
}

/** 与 fetchDiaries 同样的多码登录：主授权码失效时逐把尝试备选码。 */
async function connect(acct: Account): Promise<ImapFlow> {
  const alt = (acct.altAuthCode || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const passwords = [acct.authCode, ...alt].filter(
    (p) => p && p.trim().length > 0
  );
  if (passwords.length === 0) throw new Error("没有可用的授权码");

  let lastErr: unknown;
  for (const pass of passwords) {
    const c = new ImapFlow({
      host: acct.imapHost,
      port: 993,
      secure: true,
      auth: { user: acct.email, pass },
    });
    try {
      await c.connect();
      return c;
    } catch (e) {
      lastErr = e;
      try {
        await c.logout();
      } catch {
        /* ignore */
      }
    }
  }
  throw new Error(
    `登录失败：${passwords.length} 把授权码均被服务器拒绝` +
      `（${lastErr instanceof Error ? lastErr.message : String(lastErr)}）`
  );
}

/** 在指定文件夹里只取 envelope（主题 + 发件人），不下载正文、不改动邮件。 */
async function collectHits(
  client: ImapFlow,
  acct: Account,
  folder: string
): Promise<DiaryMailHit[]> {
  const lock = await client.getMailboxLock(folder);
  try {
    const hits: DiaryMailHit[] = [];
    for await (const msg of client.fetch("1:*", {
      uid: true,
      envelope: true,
    })) {
      const env = (msg as any).envelope;
      if (!env || typeof msg.uid !== "number") continue;
      const subject = String(env.subject || "");
      const firstFrom =
        Array.isArray(env.from) && env.from[0] ? env.from[0] : null;
      const from = firstFrom
        ? String(firstFrom.address || firstFrom.name || "")
        : "";
      if (isDiaryMail(subject, from, acct.email)) {
        hits.push({ uid: msg.uid, subject });
      }
    }
    return hits;
  } finally {
    lock.release();
  }
}

/** 扫描 INBOX：返回符合「日记邮件」规则的 UID 列表，供确认弹窗展示数量与样例。 */
export async function scanDiaryMails(acct: Account): Promise<DiaryMailHit[]> {
  const client = await connect(acct);
  try {
    return await collectHits(client, acct, "INBOX");
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
}

/** 找出「已删除 / 垃圾箱」文件夹：优先用 SPECIAL-USE 标记，缺失时按本地化名字兜底。 */
async function findTrashFolders(client: ImapFlow): Promise<string[]> {
  try {
    const list = await client.list();
    return list
      .filter(
        (m: any) =>
          m.specialUse === "\\Trash" ||
          /已删除|垃圾箱|deleted|trash/i.test(String(m.name || m.path || ""))
      )
      .map((m: any) => String(m.path))
      .filter((p) => p && p.toUpperCase() !== "INBOX");
  } catch {
    return [];
  }
}

async function deleteHitsInFolder(
  client: ImapFlow,
  acct: Account,
  folder: string
): Promise<number> {
  const hits = await collectHits(client, acct, folder);
  if (hits.length === 0) return 0;
  const lock = await client.getMailboxLock(folder);
  try {
    // imapflow 的 messageDelete = 标记 \Deleted + EXPUNGE；用 UID 而非序号，
    // 因为 EXPUNGE 会让序号变化。返回 false 视为失败，绝不谎报成功。
    const ok = await client.messageDelete(
      hits.map((h) => h.uid),
      { uid: true }
    );
    if (!ok) throw new Error("服务器未确认删除");
    return hits.length;
  } finally {
    lock.release();
  }
}

/**
 * 真正执行清理：按 UID 永久删除收件箱里的日记邮件，再清理「已删除 / 垃圾箱」里
 * 同规则的日记邮件（部分服务商删除后仍占容量，不清等于没腾空间）。
 *
 * 调用方必须已完成「同步成功」与「用户二次确认」；本函数不做任何确认。
 * 只删符合 isDiaryMail 的邮件，其它邮件一律不动。
 */
export async function cleanupDiaryMails(
  acct: Account
): Promise<CleanupResult> {
  const client = await connect(acct);
  const result: CleanupResult = {
    inbox: 0,
    trash: 0,
    trashFolders: [],
    warnings: [],
  };
  try {
    result.inbox = await deleteHitsInFolder(client, acct, "INBOX");

    const folders = await findTrashFolders(client);
    for (const folder of folders) {
      try {
        const n = await deleteHitsInFolder(client, acct, folder);
        if (n > 0) {
          result.trash += n;
          result.trashFolders.push(folder);
        }
      } catch (e) {
        result.warnings.push(
          `「${folder}」清理失败：${(e as Error).message}`
        );
      }
    }
    return result;
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
}
