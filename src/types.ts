export interface Account {
  id: string;
  email: string;
  imapHost: string;
  authCode: string;
  /**
   * 固定日记密钥（v2，Base64 的 32 字节 AES-256 密钥）。
   * 加密与邮箱凭证解绑：新邮件一律用它加解密，换授权码/换邮箱密码都不影响。
   * 可空（未升级的账号走 deriveKey(授权码) 旧逻辑）。
   */
  diaryKey?: string;
}

export interface LiuhunSettings {
  accounts: Account[];
  outFolder: string;
  order: "newest" | "oldest";
  /** 打开 Obsidian 或打开输出目录下文件时，自动拉取最新日记（每 5 分钟最多一次） */
  autoSyncOnOpen: boolean;
  /** 设置页界面语言：zh=中文（简体），en=English，auto=跟随 Obsidian 自身语言 */
  language: "zh" | "en" | "auto";
}

export const DEFAULT_SETTINGS: LiuhunSettings = {
  accounts: [],
  outFolder: "treehole",
  order: "newest",
  autoSyncOnOpen: true,
  language: "zh",
};
