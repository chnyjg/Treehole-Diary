/**
 * 标签相关的纯文本处理（不依赖 Obsidian，便于单测）。
 *
 * 背景：手机 App 把用户写的 #标签 留在正文里，同时把标签名另放进邮件主题
 * 和加密正文的首行。旧版插件同步时又额外在每条日记开头写了一行
 * 「- 标签：xxx」，于是 vault 里同一个标签出现两次。现在只保留正文里的 #标签。
 */

// 旧版插件生成的元信息行，形如「- 标签：姥姥姥爷」。
const LEGACY_TAG_LINE = /^- 标签：/;

/**
 * 摘掉旧版插件写在「每段开头」的元信息行，其余内容一字不改。
 * 段首 = 文件开头 / 标题行之后 / --- 分隔线之后。
 * 只认段首，避免误删用户自己在正文里写下的同形文字。
 */
export function stripLegacyTagLines(md: string): string {
  const out: string[] = [];
  let atPieceStart = true;
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (/^#{1,6}\s+\S/.test(t) || t === "---") {
      out.push(line);
      atPieceStart = true;
      continue;
    }
    if (atPieceStart && LEGACY_TAG_LINE.test(t)) continue;
    if (t !== "") atPieceStart = false;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * 收集某一天的标签（供 index.md 的链接后缀与「标签统计」用）。
 * ① 兼容历史文件：仍读旧元信息行；② 现在的主要来源：正文里的行内 #标签。
 * 判定与手机端一致：# 前必须是行首或空白，名字里不含空白和 #。
 */
export function collectTags(body: string): string[] {
  const tags = new Set<string>();
  const add = (raw: string) => {
    // 「#带娃，出门」里的中文逗号不是空白，正则会把整串当成一个名字，
    // 所以在第一个标点处截断；中间的点保留（兼容 #v1.2）。
    const t = raw
      .trim()
      .split(/[，。！？、,;!?:：]/)[0]
      .replace(/[.!?;:]+$/g, "")
      .trim();
    if (!t) return;
    // 色号 / 纯数字不是标签（Obsidian 也不接受纯数字标签）
    if (/^[0-9a-fA-F]{3,8}$/.test(t) || /^\d+$/.test(t)) return;
    tags.add(t);
  };
  for (const m of body.matchAll(/- 标签：([^\n]+)/g)) {
    for (const part of m[1].split(/[,，]/)) add(part);
  }
  for (const m of body.matchAll(/(?<!\S)#([^\s#]+)/g)) add(m[1]);
  return [...tags];
}
