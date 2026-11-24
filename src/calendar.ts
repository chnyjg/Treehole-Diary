/** 日历分档用的纯函数：不依赖 Obsidian，便于在 Node 里直接测试。
 *  颜色深浅按单日日记的正文长度分 5 档：字少浅绿，字多深绿。 */

/** 统计单日 md 的有效字数：剔除标题、心情/标签元数据、分隔线、
 *  图片 markdown（含方图嵌套链接）与旧版 {{IMG:n}} 占位，只数真正写下的字符。
 *  中英文与标点都算，空白不算。 */
export function countDiaryChars(content: string): number {
  let s = content;
  // # 2026-11-24
  s = s.replace(/^[ \t]*#[ \t]*\d{4}-\d{2}-\d{2}[ \t]*$/gm, "");
  // - 心情：xxx / - 标签：xxx（老格式元数据）
  s = s.replace(/^[ \t]*-[ \t]*(心情|标签)：.*$/gm, "");
  // 方图嵌套链接：[![照片N|300](s_photoN.jpg)](photoN.jpg)
  s = s.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "");
  // 普通图片：![照片N|480](photoN.jpg)
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // 旧版正文图片 token
  s = s.replace(/\{\{IMG:\d+\}\}/g, "");
  // 多篇日记之间的分隔线
  s = s.replace(/^[ \t]*-{3,}[ \t]*$/gm, "");
  return s.replace(/\s+/g, "").length;
}

/** 分档阈值：按用户现有日记分布（14~634 字，中位 192）定的等比分界。 */
export const CAL_CHAR_STEPS = [50, 100, 200, 400] as const;

/** 1 = 最浅绿（字最少） → 5 = 最深绿（字最多） */
export type DiaryLevel = 1 | 2 | 3 | 4 | 5;

export function diaryCharLevel(chars: number): DiaryLevel {
  if (chars < CAL_CHAR_STEPS[0]) return 1;
  if (chars < CAL_CHAR_STEPS[1]) return 2;
  if (chars < CAL_CHAR_STEPS[2]) return 3;
  if (chars < CAL_CHAR_STEPS[3]) return 4;
  return 5;
}
