export interface Account {
  id: string;
  email: string;
  imapHost: string;
  authCode: string;
  /** 备选授权码：应对「中途换过授权码 / 前段用别的邮箱发」导致旧邮件用不同密钥加密。可空。 */
  altAuthCode?: string;
  /**
   * 固定日记密钥（v2，Base64 的 32 字节 AES-256 密钥）。
   * 加密与邮箱凭证解绑：新邮件一律用它加解密，换授权码/换邮箱密码都不影响。
   * 可空（未升级的账号走 deriveKey(授权码) 旧逻辑）。
   */
  diaryKey?: string;
  enabled: boolean;
}

export interface LiuhunSettings {
  accounts: Account[];
  outFolder: string;
  order: "newest" | "oldest";
  /** 打开 Obsidian 或打开树洞日记目录下文件时，自动拉取最新日记（每 5 分钟最多一次） */
  autoSyncOnOpen: boolean;
}

export const DEFAULT_SETTINGS: LiuhunSettings = {
  accounts: [],
  outFolder: "树洞日记",
  order: "newest",
  autoSyncOnOpen: true,
};
