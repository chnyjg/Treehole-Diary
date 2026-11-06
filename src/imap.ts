import { ImapFlow } from "imapflow";
import { simpleParser, ParsedMail } from "mailparser";
import { deriveDiaryKey, decryptDiaryBytes, decryptDiaryText } from "./crypto";

export interface DiaryImage {
  name: string;
  data: Buffer;
}

export interface DiaryEntry {
  date: string;
  tags: string;
  mood: string;
  body: string;
  images: DiaryImage[];
}

// ---------- 解析辅助（与 Obsidian 插件的解密逻辑保持一致） ----------
const _WD = new Set(["一", "二", "三", "四", "五", "六", "日", "天"]);

const _DATE_RE = new RegExp(
  "^\\s*(" +
    "(?<y8>\\d{4})(?<m8>\\d{2})(?<d8>\\d{2})" +
    "|(?<y6>\\d{6})" +
    "|(?<y2>\\d{2})(?<sep>[-./])(?<m2>\\d{1,2})\\2(?<d2>\\d{1,2})" +
    ")\\s*(?<wd>[一二三四五六日天])?\\s*$"
);

function pad(n: number): string {
  return n < 10 ? "0" + n : "" + n;
}

function parseDateLine(line: string): string | null {
  const s0 = line.trim();
  if (!s0) return null;
  let s = s0;
  if (_WD.has(s.slice(-1))) s = s.slice(0, -1); // 去掉末尾星期字
  const m = _DATE_RE.exec(s);
  if (!m) return null;
  if (m.groups!.y8) {
    const y = parseInt(m.groups!.y8),
      mo = parseInt(m.groups!.m8),
      d = parseInt(m.groups!.d8);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad(mo)}-${pad(d)}`;
  } else if (m.groups!.y6) {
    const d6 = m.groups!.y6;
    const y = 2000 + parseInt(d6.slice(0, 2)),
      mo = parseInt(d6.slice(2, 4)),
      d = parseInt(d6.slice(4, 6));
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad(mo)}-${pad(d)}`;
  } else {
    const y = 2000 + parseInt(m.groups!.y2!),
      mo = parseInt(m.groups!.m2!),
      d = parseInt(m.groups!.d2!);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad(mo)}-${pad(d)}`;
  }
  return null;
}

function parseSubject(subject: string): [string, string] {
  const dateM = subject.match(/(\d{4}-\d{2}-\d{2})/);
  const dateStr = dateM ? dateM[1] : "";
  const tagM = subject.match(/\[([^\]]+)\]/);
  const tags = tagM ? tagM[1].trim() : "";
  return [dateStr, tags];
}

function parseBody(rawText: string): [string, string, string] {
  const lines = rawText.replace(/\r\n/g, "\n").split("\n");
  let mood = "",
    tagsInline = "",
    idx = 0;
  if (lines.length && (lines[0].startsWith("心情:") || lines[0].startsWith("标签:"))) {
    const first = lines[0];
    const m = first.match(/心情:\s*([^|]*?)\s*(?:\||$)/);
    const t = first.match(/标签:\s*([^|]*?)\s*(?:\||$)/);
    mood = m ? m[1].trim() : "";
    tagsInline = t ? t[1].trim() : "";
    idx = 1;
    while (idx < lines.length && lines[idx].trim() === "") idx++;
  }
  const body = lines.slice(idx).join("\n").trim();
  return [mood, tagsInline, body];
}

function parseImport(text: string): DiaryEntry[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const entries: DiaryEntry[] = [];
  let curDate: string | null = null;
  let curBody: string[] = [];
  const flush = () => {
    if (curDate !== null) {
      const body = curBody.join("\n").trim();
      if (body) entries.push({ date: curDate, tags: "", mood: "", body, images: [] });
    }
    curDate = null;
    curBody = [];
  };
  for (const line of lines) {
    const d = parseDateLine(line);
    if (d !== null) {
      flush();
      curDate = d;
      curBody = [];
    } else if (curDate !== null) {
      curBody.push(line);
    }
  }
  flush();
  return entries;
}

// ---------- 多密钥尝试（应对密钥切换） ----------
function tryDecryptText(keys: Buffer[], b64: string): string | null {
  for (const k of keys) {
    try {
      return decryptDiaryText(k, b64);
    } catch {
      continue;
    }
  }
  return null;
}

function tryDecryptBytes(keys: Buffer[], data: Buffer): Buffer | null {
  for (const k of keys) {
    try {
      return decryptDiaryBytes(k, data);
    } catch {
      continue;
    }
  }
  return null;
}

function headerVal(parsed: ParsedMail, name: string): string {
  const v = parsed.headers.get(name);
  return v ? String(v).trim() : "";
}

// ---------- 主拉取 ----------
/**
 * 拉取主题形如 `Log [标签] YYYY-MM-DD` 的邮件并解析（必须是 Log 开头且带完整日期）。
 *
 * passwords: 可选的**多把**授权码（主码在前、备选码在后）。
 *   登录时逐把尝试，第一把能登录的即采用 —— 应对「主码已被重置失效、备选码仍有效」。
 *   注意：登录只需要一把有效的码；**解密**则需要所有码派生的密钥（旧邮件用旧码加密）。
 */
export async function fetchDiaries(
  email: string,
  imapHost: string,
  passwords: string[],
  keys: Buffer[]
): Promise<DiaryEntry[]> {
  const candidates = passwords.filter((p) => p && p.trim().length > 0);
  if (candidates.length === 0) {
    throw new Error("没有可用的授权码");
  }

  let client: ImapFlow | undefined;
  let lastErr: unknown;
  for (const pass of candidates) {
    const c = new ImapFlow({
      host: imapHost,
      port: 993,
      secure: true,
      auth: { user: email, pass },
    });
    try {
      await c.connect();
      client = c;
      break;
    } catch (e) {
      lastErr = e;
      try {
        await c.logout();
      } catch {
        /* ignore */
      }
    }
  }
  if (!client) {
    throw new Error(
      `登录失败：${candidates.length} 把授权码均被服务器拒绝` +
        `（${lastErr instanceof Error ? lastErr.message : String(lastErr)}）。` +
        `请到 mail.qq.com → 设置 → 账号与安全 → 安全设置 重新生成授权码，` +
        `并把旧码填入「备选授权码」以继续解密历史邮件。`
    );
  }

  const results: DiaryEntry[] = [];
  let lock: Awaited<ReturnType<typeof client.getMailboxLock>> | undefined;
  try {
    lock = await client.getMailboxLock("INBOX");
    const messages = client.fetch("1:*", { uid: true, source: true });
    for await (const msg of messages) {
      if (!msg.source) continue;
      const parsed = await simpleParser(msg.source as Buffer);

      const subject = parsed.subject || "";
      // 只认「以 Log 开头 + 主题里带完整日期」的邮件（App 的主题形如
      // `Log [标签] 2026-11-04` / `Log [导入] 2026-11-04`）。
      // 之前用 includes("Log") 太宽松：Blog / Login / Catalog / 各类系统告警都会命中，
      // 一旦误判就会往当天的单日 md 里塞一段无关正文（而单日文件只增不删，只能手动清）。
      if (!/^Log\b[^\n]*?(\d{4}-\d{2}-\d{2})/.test(subject)) continue;

      const [dateFromSubject, tagsFromSubject] = parseSubject(subject);
      let dateStr = dateFromSubject;
      if (!dateStr && parsed.date) {
        const d = parsed.date; // 本地时区 YYYY-MM-DD
        dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      }
      if (!dateStr) dateStr = "unknown-date";

      const isEnc = headerVal(parsed, "x-encrypted") === "1";
      const isImport = headerVal(parsed, "x-import") === "1";

      if (isImport) {
        const importTextParts: string[] = [];
        for (const att of parsed.attachments || []) {
          let payload = att.content as Buffer;
          if (isEnc) {
            const dec = tryDecryptBytes(keys, payload);
            if (!dec) continue;
            payload = dec;
          }
          try {
            importTextParts.push(payload.toString("utf-8"));
          } catch {
            /* ignore */
          }
        }
        for (const e of parseImport(importTextParts.join("\n"))) results.push(e);
        continue;
      }

      const textParts: string[] = [];
      const images: DiaryImage[] = [];
      const raw = parsed.text || "";
      if (raw) {
        if (isEnc) {
          const dec = tryDecryptText(keys, raw.trim());
          textParts.push(
            dec !== null ? dec : "<<解密失败：授权码不匹配或数据损坏>>"
          );
        } else {
          textParts.push(raw);
        }
      }
      for (const att of parsed.attachments || []) {
        let payload = att.content as Buffer;
        let fname = att.filename || `file${images.length + 1}`;
        if (isEnc) {
          const dec = tryDecryptBytes(keys, payload);
          if (!dec) continue;
          payload = dec;
          if (fname.toLowerCase().endsWith(".enc")) fname = fname.slice(0, -4);
        }
        images.push({ name: fname, data: payload });
      }

      const rawText = textParts.join("\n");
      const [mood, tagsInline, body] = parseBody(rawText);
      const tags = tagsFromSubject || tagsInline;
      results.push({ date: dateStr, tags, mood, body, images });
    }
  } finally {
    if (lock) lock.release();
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }

  results.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return results;
}

export { deriveDiaryKey };
