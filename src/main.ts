import {
  Plugin,
  PluginSettingTab,
  Setting,
  App,
  Modal,
  Notice,
} from "obsidian";
import { decryptEnvelope, Envelope } from "./crypto";
import { syncAccount } from "./sync";
import { Account, LiuhunSettings, DEFAULT_SETTINGS } from "./types";

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default class LiuhunReader extends Plugin {
  settings: LiuhunSettings;
  private lastAutoSync = 0;
  private autoSyncing = false;
  private static AUTO_SYNC_COOLDOWN_MS = 5 * 60 * 1000;

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("sync", "同步树洞日记", () => this.syncAll());
    this.addCommand({
      id: "sync-all",
      name: "同步树洞日记（全部账号）",
      callback: () => this.syncAll(),
    });
    this.addCommand({
      id: "import-config",
      name: "导入引导配置(.shudong)",
      callback: () => this.importConfig(),
    });
    this.addSettingTab(new LiuhunSettingTab(this.app, this));

    if (this.settings.autoSyncOnOpen) {
      // 布局就绪后延迟同步一次（覆盖「打开 Obsidian」场景）
      this.app.workspace.onLayoutReady(() => {
        setTimeout(() => this.maybeAutoSync(), 3000);
      });
      // 打开树洞日记目录下的文件时也同步（覆盖「打开树洞日记」场景）
      this.registerEvent(
        this.app.workspace.on("file-open", (file) => {
          if (!file) return;
          const prefix = this.settings.outFolder + "/";
          if (
            file.path === this.settings.outFolder ||
            file.path.startsWith(prefix)
          ) {
            this.maybeAutoSync();
          }
        })
      );
    }
  }

  /** 带节流与防并发的自动同步：每 AUTO_SYNC_COOLDOWN_MS 最多一次 */
  private async maybeAutoSync() {
    if (!this.settings.autoSyncOnOpen) return;
    if (this.autoSyncing) return;
    const now = Date.now();
    if (now - this.lastAutoSync < LiuhunReader.AUTO_SYNC_COOLDOWN_MS) return;
    if (
      !this.settings.accounts ||
      this.settings.accounts.filter((a) => a.enabled).length === 0
    )
      return;
    this.lastAutoSync = now;
    this.autoSyncing = true;
    try {
      await this.syncAll();
    } finally {
      this.autoSyncing = false;
    }
  }

  async syncAll() {
    const list = this.settings.accounts.filter((a) => a.enabled);
    if (list.length === 0) {
      new Notice("没有已启用的账号，请先在设置里添加或导入");
      return;
    }
    for (const acct of list) {
      try {
        const summary = await syncAccount(
          acct,
          this.app,
          this.settings.outFolder,
          this.settings.order
        );
        new Notice(`已同步 ${acct.email}：${summary}`);
      } catch (e) {
        new Notice(`同步失败 ${acct.email}：${(e as Error).message}`);
      }
    }
  }

  importConfig() {
    new ImportConfigModal(this.app, this).open();
  }

  importFromText(text: string) {
    let obj: any;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      // 把内容前 80 字回显出来：JSON 解析失败最常见的原因是
      // ① 少了收尾引号 ② 粘进了多余文字/换行 ③ 复制时带上了别的内容
      const preview = text.slice(0, 80).replace(/\n/g, "⏎");
      new Notice(
        `内容不是有效的配置（JSON 解析失败）。收到的内容开头：「${preview}」` +
          (text.length > 80 ? "…" : "") +
          `（共 ${text.length} 字）`
      );
      return;
    }
    // 明文格式：含 email + authCode，无需口令，直接导入
    if (obj && typeof obj.email === "string" && typeof obj.authCode === "string") {
      this.addAccountFromCfg(
        obj.email,
        obj.imapHost || "imap.qq.com",
        obj.authCode,
        typeof obj.altAuthCode === "string" ? obj.altAuthCode : undefined,
        typeof obj.diaryKey === "string" ? obj.diaryKey : undefined
      );
      return;
    }
    // 加密信封格式（旧文件兼容）：需要口令解密
    if (obj && typeof obj.alg === "string" && obj.ct) {
      new PassphraseModal(this.app, (pass) => {
        try {
          const cfg = decryptEnvelope(obj as Envelope, pass);
          this.addAccountFromCfg(cfg.email, cfg.imapHost, cfg.authCode);
        } catch {
          new Notice("解密失败：口令或文件有误");
        }
      }).open();
      return;
    }
    new Notice("内容不是有效的引导配置");
  }

  /** 新增账号；同邮箱（忽略大小写）已存在则更新，不去重新增 */
  private addAccountFromCfg(
    email: string,
    imapHost: string,
    authCode: string,
    altAuthCode?: string,
    diaryKey?: string
  ) {
    if (!email || !authCode) {
      new Notice("配置缺少邮箱或授权码");
      return;
    }
    const host = imapHost || "imap.qq.com";
    // 备选码可能有多把（每次改 QQ 密码都会新增一把只能解密的历史密钥），逗号分隔
    const normAlt = (altAuthCode || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join(",");
    const existing = this.settings.accounts.find(
      (a) => a.email.trim().toLowerCase() === email.trim().toLowerCase()
    );
    if (existing) {
      existing.imapHost = host;
      existing.authCode = authCode;
      // 备选码：只在配置里明确带了才覆盖，避免把用户手填的旧码冲掉
      if (normAlt) {
        existing.altAuthCode = normAlt;
      }
      // v2 固定日记密钥：配置里带了才覆盖（老配置没有此字段，不冲掉）
      if (diaryKey && diaryKey.trim()) {
        existing.diaryKey = diaryKey.trim();
      }
      existing.enabled = true;
    } else {
      this.settings.accounts.push({
        id: genId(),
        email,
        imapHost: host,
        authCode,
        altAuthCode: normAlt || undefined,
        diaryKey: diaryKey && diaryKey.trim() ? diaryKey.trim() : undefined,
        enabled: true,
      });
    }
    this.saveSettings();
    new Notice(`已导入账号：${email}`);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.accounts) this.settings.accounts = [];
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class PassphraseModal extends Modal {
  onSubmit: (pass: string) => void;
  constructor(app: App, onSubmit: (pass: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "输入引导口令" });
    contentEl.createEl("p", {
      text: "请输入 App 导出配置时屏幕上显示的一次性口令。",
    });
    const input = contentEl.createEl("input");
    input.type = "password";
    input.placeholder = "一次性口令";
    input.style.width = "100%";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.onSubmit(input.value);
        this.close();
      }
    });
    const btn = contentEl.createEl("button", { text: "确定" });
    btn.style.marginTop = "12px";
    btn.addEventListener("click", () => {
      this.onSubmit(input.value);
      this.close();
    });
  }
  onClose() {
    this.contentEl.empty();
  }
}

class ImportConfigModal extends Modal {
  plugin: LiuhunReader;
  constructor(app: App, plugin: LiuhunReader) {
    super(app);
    this.plugin = plugin;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "导入引导配置 (.shudong)" });
    contentEl.createEl("p", {
      text:
        "把手机「导出引导配置」生成的 .shudong 文件内容粘贴到下方，无需口令，粘贴后直接导入。" +
        "打开方式：用文本编辑 app 打开该文件 → 全选复制 → 回到这里 Cmd+V；" +
        "或先点「从剪贴板读取」自动填入。",
    });
    const ta = contentEl.createEl("textarea");
    ta.rows = 8;
    ta.placeholder = "在此粘贴 .shudong 文件内容（一段 JSON 文本）";
    ta.style.width = "100%";
    ta.style.marginTop = "8px";
    ta.style.fontFamily = "monospace";
    ta.style.fontSize = "12px";

    const btnRow = contentEl.createEl("div");
    btnRow.style.marginTop = "12px";
    const readBtn = btnRow.createEl("button", { text: "从剪贴板读取" });
    readBtn.style.marginRight = "8px";
    readBtn.addEventListener("click", async () => {
      try {
        const txt = await (navigator as any).clipboard.readText();
        if (txt && txt.trim()) {
          ta.value = txt.trim();
          new Notice("已从剪贴板填入");
        } else {
          new Notice("剪贴板为空，请手动粘贴");
        }
      } catch {
        new Notice("无法读取剪贴板，请手动粘贴");
      }
    });
    const importBtn = btnRow.createEl("button", { text: "导入" });
    importBtn.style.marginLeft = "8px";
    importBtn.addEventListener("click", () => {
      const txt = ta.value.trim();
      if (!txt) {
        new Notice("请先粘贴配置内容");
        return;
      }
      this.close();
      this.plugin.importFromText(txt);
    });
  }
  onClose() {
    this.contentEl.empty();
  }
}

class AddAccountModal extends Modal {
  plugin: LiuhunReader;
  constructor(app: App, plugin: LiuhunReader) {
    super(app);
    this.plugin = plugin;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "手动添加账号" });

    const fields: Record<string, HTMLInputElement> = {};
    const mk = (label: string, placeholder: string, type = "text") => {
      contentEl.createEl("label", { text: label });
      const i = contentEl.createEl("input");
      i.type = type;
      i.placeholder = placeholder;
      i.style.width = "100%";
      i.style.marginBottom = "8px";
      fields[label] = i;
      return i;
    };
    mk("邮箱", "you@qq.com");
    mk("IMAP 主机", "imap.qq.com");
    const auth = mk("授权码", "16位授权码", "password");
    const altAuth = mk("备选授权码（可选，多把逗号分隔）", "旧码A,旧码B（改过QQ密码后旧码只能解密、不能登录）", "password");
    contentEl.createEl("p", {
      text:
        "改了 QQ 密码后所有旧授权码会立即失效（不能再登录），但旧码仍是历史加密邮件的解密密钥。" +
        "换码时把旧码填在这里，历史日记才不会解不开。",
    });

    const btn = contentEl.createEl("button", { text: "保存" });
    btn.style.marginTop = "12px";
    btn.addEventListener("click", () => {
      const email = fields["邮箱"].value.trim();
      const imapHost = fields["IMAP 主机"].value.trim();
      const code = auth.value.trim();
      const alt = altAuth.value.trim();
      if (!email || !code) {
        new Notice("邮箱和授权码必填");
        return;
      }
      this.plugin.settings.accounts.push({
        id: genId(),
        email,
        imapHost: imapHost || "imap.qq.com",
        authCode: code,
        altAuthCode: alt || undefined,
        enabled: true,
      });
      this.plugin.saveSettings();
      new Notice(`已添加账号：${email}`);
      this.close();
    });
  }
  onClose() {
    this.contentEl.empty();
  }
}

class LiuhunSettingTab extends PluginSettingTab {
  plugin: LiuhunReader;
  constructor(app: App, plugin: LiuhunReader) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "树洞日记" });

    new Setting(containerEl)
      .setName("输出文件夹")
      .setDesc("合并后的 Markdown 写到 vault 下的此文件夹")
      .addText((t) =>
        t.setValue(this.plugin.settings.outFolder).onChange(async (v) => {
          this.plugin.settings.outFolder = v.trim() || "树洞日记";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("合并稿排序")
      .setDesc("newest=新在上，oldest=早在上")
      .addDropdown((d) =>
        d
          .addOption("newest", "新在上")
          .addOption("oldest", "早在上")
          .setValue(this.plugin.settings.order)
          .onChange(async (v) => {
            this.plugin.settings.order = v as "newest" | "oldest";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("打开时自动同步")
      .setDesc(
        "打开 Obsidian 或打开树洞日记目录下的文件时，自动拉取最新日记（每 5 分钟最多一次）。关闭后需手动点「立即同步」。"
      )
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.autoSyncOnOpen)
          .onChange(async (v) => {
            this.plugin.settings.autoSyncOnOpen = v;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "账号" });
    this.plugin.settings.accounts.forEach((acct) => {
      new Setting(containerEl)
        .setName(acct.email)
        .setDesc(acct.imapHost)
        .addToggle((tg) =>
          tg.setValue(acct.enabled).onChange(async (v) => {
            acct.enabled = v;
            await this.plugin.saveSettings();
          })
        )
        .addButton((b) =>
          b.setButtonText("删除").setWarning().onClick(async () => {
            this.plugin.settings.accounts = this.plugin.settings.accounts.filter(
              (a) => a.id !== acct.id
            );
            await this.plugin.saveSettings();
            this.display();
          })
        );
    });

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("手动添加账号").onClick(() => {
        new AddAccountModal(this.app, this.plugin).open();
      })
    );
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("导入引导配置(.shudong)").onClick(() => {
        this.plugin.importConfig();
      })
    );
    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText("立即同步")
        .setCta()
        .onClick(() => this.plugin.syncAll())
    );
  }
}
