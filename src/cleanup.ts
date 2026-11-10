import { ImapFlow } from "imapflow";
import { Account } from "./types";
import { isDiaryMail } from "./diaryMail";

export interface DiaryMailHit {
  uid: number;
  subject: string;
}

/** 一个文件夹里的命中结果，供确认弹窗按文件夹展示封数。 */
export interface DiaryMailGroup {
  folder: string;
  label: string;
  hits: DiaryMailHit[];
}

type FolderKind = "inbox" | "sent" | "trash";

interface TargetFolder {
  path: string;
  label: string;
  kind: FolderKind;
}

export interface CleanupResult {
  /** 收件箱里删掉的封数 */
  inbox: number;
  /** 「已发送」里删掉的封数（自己发给自己时，部分邮箱会在两个文件夹各留一份） */
  sent: number;
  /** 「已删除 / 垃圾箱」里再删掉的封数（部分服务商删除后仍占容量） */
  trash: number;
  trashFolders: string[];
  /** 每个文件夹的实际删除数（含 0），用于提示与核对 */
  folders: { label: string; deleted: number }[];
  /** 单个文件夹清理失败只记警告，不影响其它文件夹；调用方必须把它显示出来 */
  warnings: string[];
}

/**
 * 11-10 二次修复：一条 IMAP 连接只干一小段活，用完立刻 logout。
 * 旧版三个文件夹共用一条长连接、每个文件夹全量 fetch 3~4 轮（收件箱扫描 +
 * flags 扫描 + 复查 + 再复查），累计远超 imapflow 默认 5 分钟 socketTimeout，
 * 服务器发 BYE 后所有后续命令都报 "Connection not available"，于是
 * 「其实已经删掉了」也被记成「成功 0 封」。
 */
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
      // 默认 socketTimeout = 5 分钟，某条命令不回应时要等足五分钟才断。
      socketTimeout: 90_000,
      logger: false,
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

async function logoutQuietly(client: ImapFlow): Promise<void> {
  try {
    await client.logout();
  } catch {
    /* ignore */
  }
}

/** 打开文件夹、做完一小段工作就关掉整条连接。 */
async function withFolder<T>(
  acct: Account,
  path: string,
  fn: (client: ImapFlow) => Promise<T>
): Promise<T> {
  const client = await connect(acct);
  try {
    const lock = await client.getMailboxLock(path);
    try {
      return await fn(client);
    } finally {
      // mailboxClose() 会把 mailbox deselect，release 可能抛；紧接着就 logout。
      try {
        lock.release();
      } catch {
        /* ignore */
      }
    }
  } finally {
    await logoutQuietly(client);
  }
}

/**
 * 要清理的文件夹：收件箱 + 已发送 + 已删除。
 * App 发给自己时部分邮箱在两个文件夹各存一份，只清 INBOX 会剩下一半。
 * 「已删除」排最后：前面的删除可能把邮件移进来，最后再清一次才干净。
 */
async function listTargetFolders(client: ImapFlow): Promise<TargetFolder[]> {
  let list: any[] = [];
  try {
    list = await client.list();
  } catch {
    return [{ path: "INBOX", label: "收件箱", kind: "inbox" }];
  }
  const out: TargetFolder[] = [{ path: "INBOX", label: "收件箱", kind: "inbox" }];
  const seen = new Set<string>(["INBOX"]);
  const nameOf = (m: any) => String(m.name || m.path || "");
  const pathOf = (m: any) => String(m.path || "");

  for (const m of list) {
    const p = pathOf(m);
    if (!p || seen.has(p) || p.toUpperCase() === "INBOX") continue;
    const su = String(m.specialUse || "");
    if (su === "\\Sent" || /sent|已发送/i.test(nameOf(m))) {
      out.push({ path: p, label: "已发送", kind: "sent" });
      seen.add(p);
    }
  }
  for (const m of list) {
    const p = pathOf(m);
    if (!p || seen.has(p) || p.toUpperCase() === "INBOX") continue;
    const su = String(m.specialUse || "");
    if (su === "\\Trash" || /已删除|垃圾箱|deleted|trash/i.test(nameOf(m))) {
      out.push({ path: p, label: "已删除", kind: "trash" });
      seen.add(p);
    }
  }
  // 稳定的排序：trash 一律沉到最后
  return out.sort(
    (a, b) => (a.kind === "trash" ? 1 : 0) - (b.kind === "trash" ? 1 : 0)
  );
}

/**
 * SEARCH 只用来「快速判定这个文件夹里根本不可能有日记邮件」：日记主题一定以
 * Log 开头，所以 subject 搜不到 Log 就整夹跳过（837 封的「已删除」从 70 秒
 * 降到 0.4 秒）。**SEARCH 结果绝不能替代全量扫描** —— 实测部分邮箱 SEARCH
 * 返回 96 个 UID，但按这些 UID fetch 只拿回 27 封 envelope，照它删会漏 69 封。
 * 只有明确返回空数组才敢跳过；false / undefined / 异常一律退回全量扫。
 */
async function hasLogSubjects(client: ImapFlow): Promise<boolean> {
  try {
    const uids = await client.search({ subject: "Log" }, { uid: true });
    if (Array.isArray(uids) && uids.length === 0) return false;
    return true;
  } catch {
    return true;
  }
}

/** 在已打开（且已持锁）的文件夹里取 envelope：主题 + 发件人，不下载正文、不改动邮件。 */
async function collectHits(
  client: ImapFlow,
  acct: Account
): Promise<DiaryMailHit[]> {
  if (!(await hasLogSubjects(client))) return [];
  const hits: DiaryMailHit[] = [];
  for await (const msg of client.fetch("1:*", { uid: true, envelope: true })) {
    const env = (msg as any).envelope;
    if (!env || typeof msg.uid !== "number") continue;
    const firstFrom =
      Array.isArray(env.from) && env.from[0] ? env.from[0] : null;
    const from = firstFrom
      ? String(firstFrom.address || firstFrom.name || "")
      : "";
    const subject = String(env.subject || "");
    if (isDiaryMail(subject, from, acct.email)) {
      hits.push({ uid: msg.uid, subject });
    }
  }
  return hits;
}

/** 扫描所有目标文件夹，按文件夹分组返回（供确认弹窗展示明细）。 */
export async function scanDiaryMailGroups(
  acct: Account
): Promise<DiaryMailGroup[]> {
  const client = await connect(acct);
  try {
    const groups: DiaryMailGroup[] = [];
    for (const f of await listTargetFolders(client)) {
      let lock: Awaited<ReturnType<typeof client.getMailboxLock>> | undefined;
      try {
        lock = await client.getMailboxLock(f.path);
        groups.push({
          folder: f.path,
          label: f.label,
          hits: await collectHits(client, acct),
        });
      } catch {
        // 某个文件夹打不开就当 0 封，清理阶段会记 warning 并在提示里显示
        groups.push({ folder: f.path, label: f.label, hits: [] });
      } finally {
        if (lock) {
          try {
            lock.release();
          } catch {
            /* ignore */
          }
        }
      }
    }
    return groups;
  } finally {
    await logoutQuietly(client);
  }
}

/** 兼容旧调用：所有目标文件夹的命中合并成一个数组。 */
export async function scanDiaryMails(acct: Account): Promise<DiaryMailHit[]> {
  const groups = await scanDiaryMailGroups(acct);
  return groups.flatMap((g) => g.hits);
}

/**
 * 复查用**全新连接**，并允许重试一次。旧版在删除的那条连接上复查，连接一断
 * 就把「其实删掉了」误报成「成功 0 封」——这正是 11-10 用户看到的现象。
 */
async function verifyFolder(
  acct: Account,
  path: string
): Promise<DiaryMailHit[]> {
  let lastErr: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      return await withFolder(acct, path, (c) => collectHits(c, acct));
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `复查失败（${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }）；删除可能已经生效，请到邮箱确认后重试`
  );
}

/**
 * 清理一个文件夹，分阶段各用独立短连接：
 *   1) 一轮 fetch 同时拿 envelope + flags → 标记目标、摘掉别人的 \Deleted
 *      → mailboxClose()（RFC 3501：CLOSE 永久移除所有 \Deleted，且不发逐封
 *      untagged EXPUNGE 响应，比内部 exec("EXPUNGE") 稳）；
 *   2) 新连接复查，确认服务器真删掉了；
 *   3) 少数服务商 CLOSE 不生效时，用公开 API 的 UID EXPUNGE 再试一次并复查。
 * 任何一步之后仍存在就抛错，绝不谎报成功。
 */
async function deleteOneFolder(
  acct: Account,
  target: TargetFolder
): Promise<number> {
  let deleted = 0;
  await withFolder(acct, target.path, async (client) => {
    if (!(await hasLogSubjects(client))) return;
    const uids: number[] = [];
    const otherDeleted: number[] = [];
    for await (const msg of client.fetch("1:*", {
      uid: true,
      envelope: true,
      flags: true,
    })) {
      if (typeof msg.uid !== "number") continue;
      const env = (msg as any).envelope;
      const firstFrom =
        env && Array.isArray(env.from) && env.from[0] ? env.from[0] : null;
      const from = firstFrom
        ? String(firstFrom.address || firstFrom.name || "")
        : "";
      const subject = env ? String(env.subject || "") : "";
      if (env && isDiaryMail(subject, from, acct.email)) {
        uids.push(msg.uid);
      } else if (
        Array.from(msg.flags || [])
          .map(String)
          .includes("\\Deleted")
      ) {
        // 普通 CLOSE/EXPUNGE 会清掉整个文件夹里所有带 \Deleted 的邮件，
        // 先把非目标邮件的标记摘掉，避免连带误删别人的信。
        otherDeleted.push(msg.uid);
      }
    }
    if (uids.length === 0) return;
    if (otherDeleted.length) {
      await client.messageFlagsRemove(otherDeleted, ["\\Deleted"], { uid: true });
    }
    await client.messageFlagsAdd(uids, ["\\Deleted"], { uid: true });
    await client.mailboxClose();
    deleted = uids.length;
  });
  if (deleted === 0) return 0;

  let left = await verifyFolder(acct, target.path);
  if (left.length === 0) return deleted;

  // 兜底：CLOSE 没生效的服务商，再走一次 imapflow 公开的 UID EXPUNGE。
  await withFolder(acct, target.path, async (client) => {
    const again = await collectHits(client, acct);
    if (again.length) {
      await client.messageDelete(
        again.map((h) => h.uid),
        { uid: true }
      );
    }
  });
  left = await verifyFolder(acct, target.path);
  if (left.length) {
    throw new Error(
      `服务器未真正删除「${target.label}」里的 ${left.length} 封` +
        `（邮件仍留在文件夹里或只是被标记 \\Deleted），已中止以免误报成功`
    );
  }
  return deleted;
}

/**
 * 真正执行清理：按文件夹删除符合 isDiaryMail 的邮件，其它邮件一律不动。
 * 调用方必须已完成「同步成功」与「用户二次确认」；本函数不做任何确认。
 */
export async function cleanupDiaryMails(
  acct: Account
): Promise<CleanupResult> {
  const result: CleanupResult = {
    inbox: 0,
    sent: 0,
    trash: 0,
    trashFolders: [],
    folders: [],
    warnings: [],
  };
  const listClient = await connect(acct);
  let folders: TargetFolder[];
  try {
    folders = await listTargetFolders(listClient);
  } finally {
    await logoutQuietly(listClient);
  }

  for (const t of folders) {
    try {
      // 每个文件夹独立连接：某个文件夹把连接搞挂，不影响后面的文件夹。
      const n = await deleteOneFolder(acct, t);
      result.folders.push({ label: t.label, deleted: n });
      if (t.kind === "inbox") result.inbox += n;
      else if (t.kind === "sent") result.sent += n;
      else {
        result.trash += n;
        if (n > 0) result.trashFolders.push(t.path);
      }
    } catch (e) {
      result.warnings.push(`「${t.label}」：${(e as Error).message}`);
      result.folders.push({ label: t.label, deleted: 0 });
    }
  }
  return result;
}
