import { App, Vault } from "obsidian";
import { DiaryEntry } from "./imap";
import { collectTags, stripLegacyTagLines } from "./tags";

type Adapter = App["vault"]["adapter"];

async function ensureDir(adapter: Adapter, dir: string): Promise<void> {
  const parts = dir.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur = cur ? cur + "/" + p : p;
    if (!(await adapter.exists(cur))) {
      try {
        await adapter.mkdir(cur);
      } catch {
        /* 已存在或并发创建，忽略 */
      }
    }
  }
}

async function writeText(
  adapter: Adapter,
  path: string,
  data: string
): Promise<void> {
  if (await adapter.exists(path)) {
    try {
      await adapter.remove(path);
    } catch {
      /* ignore */
    }
  }
  await adapter.write(path, data);
}

async function writeBinary(
  vault: Vault,
  path: string,
  data: ArrayBuffer
): Promise<void> {
  if (await vault.adapter.exists(path)) {
    try {
      await vault.adapter.remove(path);
    } catch {
      /* ignore */
    }
  }
  await vault.createBinary(path, data);
}

function bufToArrayBuffer(buf: Buffer): ArrayBuffer {
  const u8 = new Uint8Array(buf.length);
  u8.set(buf);
  return u8.buffer;
}

interface Written {
  date: string;
  mdName: string;
  entries: DiaryEntry[];
  dayPieces: string[]; // 含图稿
  dayPiecesText: string[]; // 纯文稿（图片为 [照片N] 占位）
  photoRel: string[];
}

function stripImages(piece: string): string {
  return piece
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("!["))
    .join("\n");
}

/**
 * 归一化正文里的 --- 分隔线：
 * 确保每条独立的 --- 两侧都有空行，避免 Obsidian 把「文字\n---」误判为
 * setext 二级标题（导致上一行文字突然变大、--- 不渲染成分割线）。
 * 同时可幂等重复执行。
 */
function normalizeDividers(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isDiv = line.trim() === "---";
    if (!isDiv) {
      out.push(line);
      continue;
    }
    // 前导空行：若上一行非空，先补一个空行，断开与上方文字的 setext 关联
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    out.push("---");
    // 后继空行：若下一行非空，补一个空行，断开与下方文字的关联
    const next = i + 1 < lines.length ? lines[i + 1] : null;
    if (next !== null && next.trim() !== "") out.push("");
  }
  // 去掉首尾多余空行，避免文件开头/结尾出现空白段
  while (out.length && out[0].trim() === "") out.shift();
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

// Obsidian 图片显示宽度约束：md 写成 ![照片N|480](原图)，由 Obsidian 按 480 缩放渲染。
// 旧实现额外生成 t_photoN.jpg 缩略图（最长边 480）再引用它，结果 360×480 的小图被拉到 480 显示，
// 等于放大显示、必然发虚；显示尺寸已由 |480 控制，缩略图这层是多余的，故不再生成。
const IMG_DISPLAY_WIDTH = 480;

// 图片占位符：App 端上传照片时在光标处插入的 {{IMG:N}}（N = 该照片在本篇中的序号）。
// 第二个右括号设为可选，以兼容个别历史邮件里被截断成 {{IMG:N} 的脏数据。
const IMG_TOKEN = /\{\{IMG:(\d+)\}\}?/g;

interface ImgRef {
  g: number; // 当天全局照片编号
  rel: string; // 相对路径（assets/日期/photoN.jpg，指向原图）
}

/**
 * 把正文里的 {{IMG:k}} 替换成真正的图片引用。
 * k 是 1-based 的「本篇内第几张」，映射到 eImgs[k-1]。
 *   useImg=true  → ![照片g](rel)
 *   useImg=false → [照片g]（纯文本占位，便于 AI 知道此处有图）
 * 未被任何占位符引用的照片（旧邮件 / 手误漏写 token）追加到正文末尾，避免丢图。
 */
function expandImages(body: string, eImgs: ImgRef[], useImg: boolean): string {
  const referenced = new Set<number>();
  const out = body.replace(IMG_TOKEN, (m, kStr: string) => {
    const k = parseInt(kStr, 10);
    if (k >= 1 && k <= eImgs.length) {
      referenced.add(k);
      const { g, rel } = eImgs[k - 1];
      return useImg ? `![照片${g}|${IMG_DISPLAY_WIDTH}](${rel})` : `[照片${g}]`;
    }
    return m;
  });
  const unref = eImgs.filter((_, i) => !referenced.has(i + 1));
  if (unref.length) {
    const tail = unref
      .map(({ g, rel }) => (useImg ? `![照片${g}|${IMG_DISPLAY_WIDTH}](${rel})` : `[照片${g}]`))
      .join("\n");
    return out + "\n\n" + tail;
  }
  return out;
}

export async function writeOutputs(
  app: App,
  diaries: DiaryEntry[],
  outFolder: string,
  order: "newest" | "oldest"
): Promise<{ days: number; entries: number }> {
  const adapter = app.vault.adapter;
  const vault = app.vault;
  await ensureDir(adapter, outFolder);
  // assets 及其日期子目录都按需创建：只有当天真的要写照片时才建，
  // 避免没照片的日期在 vault 里留下一排空文件夹。

  // 第一步：照旧把邮件内容写盘（单日 .md + 有照片时才建 assets）。
  // 即便某天的邮件已被删除，这里也不会去动那天已经落盘的单日文件。
  const groups: Record<string, DiaryEntry[]> = {};
  for (const d of diaries) (groups[d.date] = groups[d.date] || []).push(d);

  for (const date of Object.keys(groups)) {
    const entries = groups[date];
    const mdName = `${date}.md`;
    const dayAssets = `${outFolder}/assets/${date}`;

    const dayPieces: string[] = [];
    const dayPiecesText: string[] = [];
    let photoIdx = 0;
    let dayAssetsReady = false;

    for (const entry of entries) {
      const blocks: string[] = [];
      if (entry.mood) blocks.push(`- 心情：${entry.mood}`);
      // 标签不再单独写一行：用户写的 #标签 本来就在正文里，
      // 再写「- 标签：xxx」会重复。index 的标签改由正文里的 #标签 收集。
      if (blocks.length) blocks.push("");

      const eImgs: ImgRef[] = [];
      for (const img of entry.images) {
        // 首次遇到照片才建目录；ensureDir 会逐级补上 assets 父目录。
        // 一天有多篇日记时也只建一次。
        if (!dayAssetsReady) {
          await ensureDir(adapter, dayAssets);
          dayAssetsReady = true;
        }
        photoIdx += 1;
        const dot = img.name.lastIndexOf(".");
        const ext = dot >= 0 ? img.name.slice(dot) : ".jpg";
        const safe = `photo${photoIdx}${ext}`;
        const fullAb = bufToArrayBuffer(img.data);
        await writeBinary(vault, `${dayAssets}/${safe}`, fullAb);
        // 直接引用原图；显示尺寸由 expandImages 写入的 |IMG_DISPLAY_WIDTH 控制，无需缩略图
        const rel = `assets/${date}/${safe}`;
        eImgs.push({ g: photoIdx, rel });
      }

      // 把正文里的 {{IMG:k}} 就地替换成图片引用（或文本占位），
      // 使照片落在对应那段文字后面，而不是堆到全文末尾。
      const imgBody = expandImages(entry.body, eImgs, true);
      const textBody = expandImages(entry.body, eImgs, false);
      dayPieces.push(blocks.join("\n") + imgBody);
      dayPiecesText.push(blocks.join("\n") + textBody);
    }

    const sep = dayPieces.length > 1 ? "\n\n---\n\n" : "\n\n";
    const content = normalizeDividers(`# ${date}\n\n` + dayPieces.join(sep) + "\n");
    await writeText(adapter, `${outFolder}/${mdName}`, content);
  }

  // 第二步：汇总 / 索引改为从「磁盘上已落盘的单日 .md」读取生成，
  // 不再依赖内存里的 diaries[]。这样即使某天的邮件被删除，只要单日文件还在，
  // all_entries.md / index.md 就不会丢失那条记录。（设计原则：本地单日文件是主，
  // 邮件只是往里塞新内容的入口；删邮件删不掉已落盘的单日 .md。）
  const written = await readAllDaysFromDisk(adapter, outFolder);

  if (order === "newest") written.reverse();

  await writeIndex(adapter, outFolder, written, order);
  await writeBundle(adapter, outFolder, written);

  const totalEntries = written.reduce((s, w) => s + w.entries.length, 0);
  return { days: written.length, entries: totalEntries };
}

/**
 * 扫描 outFolder 下所有「YYYY-MM-DD.md」单日文件，还原出 Written[]。
 * 这是汇总 / 索引的唯一数据来源 —— 它读本地磁盘，不读邮件。
 * 因此邮件被删除不会影响汇总；只有手动删掉单日 .md 才会。
 */
async function readAllDaysFromDisk(
  adapter: Adapter,
  outFolder: string
): Promise<Written[]> {
  const list = await adapter.list(outFolder);
  const out: Written[] = [];
  const dayRe = /^\d{4}-\d{2}-\d{2}\.md$/;
  for (const file of list.files) {
    const base = file.split("/").pop() || "";
    if (!dayRe.test(base)) continue;
    if (
      base === "all_entries.md" ||
      base === "all_entries_text.md" ||
      base === "index.md"
    )
      continue;
    const date = base.slice(0, 10);
    const raw = await adapter.read(file);
    // 旧版在每段开头写过「- 标签：xxx」；只做定点摘除，其余内容（含用户手改）一字不动。
    // 摘除后回写，这样单日文件本身也不再带重复行，汇总稿自然也是干净的。
    const content = stripLegacyTagLines(raw);
    if (content !== raw) await writeText(adapter, file, content);
    // 去掉首行「# YYYY-MM-DD」标题，取整段正文
    const body = content.replace(/^#\s*\d{4}-\d{2}-\d{2}\s*\n?/, "");
    // 按 normalizeDividers 产生的分隔（--- 独占一行、两侧留空）切成各条记录
    const dayPieces = body
      .split(/\n\s*---\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (dayPieces.length === 0) continue;
    // 纯文版：把 ![照片N|480](rel) 换成 [照片N]
    const dayPiecesText = dayPieces.map((p) =>
      p.replace(/!\[照片(\d+)\|480\]\([^)]*\)/g, "[照片$1]")
    );
    // 索引标签用原始内容：历史元信息行（摘除前的旧行）+ 正文里的 #标签 都算，
    // 这样旧文件不再显示重复行，index.md 的链接后缀与「标签统计」也不会丢。
    const tags = collectTags(raw);
    const entries: DiaryEntry[] = dayPieces.map(() => ({
      date,
      tags: tags.join(","),
      mood: "",
      body: "",
      images: [],
    }));
    out.push({ date, mdName: base, entries, dayPieces, dayPiecesText, photoRel: [] });
  }
  return out;
}

async function writeIndex(
  adapter: Adapter,
  outFolder: string,
  written: Written[],
  order: "newest" | "oldest"
): Promise<void> {
  const lines = ["# 树洞日记索引", ""];
  const groups: Record<string, Written[]> = {};
  for (const w of written) {
    const month = w.date.slice(0, 7);
    (groups[month] = groups[month] || []).push(w);
  }
  const months = Object.keys(groups).sort((a, b) =>
    order === "newest" ? (a < b ? 1 : -1) : a < b ? -1 : 1
  );
  for (const month of months) {
    lines.push(`## ${month}`);
    let days = groups[month];
    if (order === "newest") days = [...days].reverse();
    for (const w of days) {
      const tags: string[] = [];
      for (const d of w.entries) {
        for (const t of d.tags.split(",")) {
          const tt = t.trim();
          if (tt && !tags.includes(tt)) tags.push(tt);
        }
      }
      const tag = tags.length ? `（${tags.join(",")}）` : "";
      lines.push(`- [${w.date}](${w.mdName}) ${tag}`);
    }
    lines.push("");
  }
  const tagCount: Record<string, number> = {};
  for (const w of written) {
    for (const d of w.entries) {
      for (const t of d.tags.split(",")) {
        const tt = t.trim();
        if (tt) tagCount[tt] = (tagCount[tt] || 0) + 1;
      }
    }
  }
  if (Object.keys(tagCount).length) {
    lines.push("## 标签统计");
    for (const [t, c] of Object.entries(tagCount).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${t}：${c} 篇`);
    }
    lines.push("");
  }
  await writeText(adapter, `${outFolder}/index.md`, lines.join("\n"));
}

async function writeBundle(
  adapter: Adapter,
  outFolder: string,
  written: Written[]
): Promise<void> {
  // 汇总标题与日期范围合成一行，标题用文件名本身：
  //   all_entries.md      → # all_entries(2025.10.30~2026.11.06)
  //   all_entries_text.md → # all_entries_text(2025.10.30~2026.11.06)
  // date 为 ISO「YYYY-MM-DD」，排序后取首尾；只有一天写单日期，没有日期则不带括号。
  const sortedDates = written.map((w) => w.date).sort();
  const fmt = (iso: string) => iso.replace(/-/g, ".");
  const range =
    sortedDates.length === 0
      ? ""
      : sortedDates[0] === sortedDates[sortedDates.length - 1]
      ? fmt(sortedDates[0])
      : `${fmt(sortedDates[0])}~${fmt(sortedDates[sortedDates.length - 1])}`;
  const bundleTitle = (name: string) =>
    range ? `# ${name}(${range})` : `# ${name}`;
  const withImg: string[] = [bundleTitle("all_entries"), ""];
  const noImg: string[] = [bundleTitle("all_entries_text"), ""];
  for (const w of written) {
    withImg.push(`## ${w.date}`);
    noImg.push(`## ${w.date}`);
    w.dayPieces.forEach((piece, i) => {
      if (i > 0) {
        withImg.push("---");
        noImg.push("---");
      }
      withImg.push(piece);
      noImg.push(w.dayPiecesText[i]);
      withImg.push("");
      noImg.push("");
    });
  }
  // 末道保险：对整篇合并稿再归一化一次分隔线，确保每条 --- 两侧都有空行，
  // 与每日文件（\n\n---\n\n）、all_entries_text.md 渲染完全一致，杜绝 setext 标题陷阱。
  await writeText(
    adapter,
    `${outFolder}/all_entries.md`,
    normalizeDividers(withImg.join("\n"))
  );
  await writeText(
    adapter,
    `${outFolder}/all_entries_text.md`,
    normalizeDividers(noImg.join("\n"))
  );
}
