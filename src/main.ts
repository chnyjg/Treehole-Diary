import {
  Plugin,
  PluginSettingTab,
  Setting,
  App,
  Modal,
  Notice,
  ButtonComponent,
} from "obsidian";
import { decryptEnvelope, Envelope } from "./crypto";
import { syncAccount } from "./sync";
import { scanDiaryMailGroups, cleanupDiaryMails } from "./cleanup";
import type { DiaryMailHit } from "./cleanup";
import { Account, LiuhunSettings, DEFAULT_SETTINGS } from "./types";

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** IMAP 主机留空时按邮箱域名推导：name@example.com → imap.example.com。
 *  各服务商主机不同，推导不对就在「手动添加账号」里填实际主机。 */
function guessImapHost(email: string): string {
  const d = (email.split("@")[1] || "").trim().toLowerCase();
  if (!d.includes(".") || d.startsWith(".") || d.endsWith(".")) return "";
  return "imap." + d;
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
      name: "导入引导配置(.treehole)",
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
        obj.imapHost || guessImapHost(obj.email),
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
    const host = imapHost || guessImapHost(email);
    // 备选码可能有多把（每次换授权码都会新增一把只能解密的历史密钥），逗号分隔
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
    new Setting(contentEl).setName("输入引导口令").setHeading();
    contentEl.createEl("p", {
      text: "请输入 App 导出配置时屏幕上显示的一次性口令。",
    });
    const input = contentEl.createEl("input");
    input.type = "password";
    input.placeholder = "一次性口令";
    input.setCssStyles({ width: "100%" });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.onSubmit(input.value);
        this.close();
      }
    });
    const btn = contentEl.createEl("button", { text: "确定" });
    btn.setCssStyles({ marginTop: "12px" });
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
    new Setting(contentEl).setName("导入引导配置 (.treehole)").setHeading();
    contentEl.createEl("p", {
      text:
        "把手机「导出引导配置」生成的 .treehole 文件内容粘贴到下方，无需口令，粘贴后直接导入。" +
        "打开方式：用文本编辑 app 打开该文件 → 全选复制 → 回到这里 Cmd+V；" +
        "或先点「从剪贴板读取」自动填入。",
    });
    const ta = contentEl.createEl("textarea");
    ta.rows = 8;
    ta.placeholder = "在此粘贴 .treehole 文件内容（一段 JSON 文本）";
    ta.setCssStyles({ width: "100%", marginTop: "8px", fontFamily: "monospace", fontSize: "12px" });

    const btnRow = contentEl.createEl("div");
    btnRow.setCssStyles({ marginTop: "12px" });
    const readBtn = btnRow.createEl("button", { text: "从剪贴板读取" });
    readBtn.setCssStyles({ marginRight: "8px" });
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
    importBtn.setCssStyles({ marginLeft: "8px" });
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
    new Setting(contentEl).setName("手动添加账号").setHeading();

    const fields: Record<string, HTMLInputElement> = {};
    const mk = (label: string, placeholder: string, type = "text") => {
      contentEl.createEl("label", { text: label });
      const i = contentEl.createEl("input");
      i.type = type;
      i.placeholder = placeholder;
      i.setCssStyles({ width: "100%", marginBottom: "8px" });
      fields[label] = i;
      return i;
    };
    mk("邮箱", "name@example.com");
    mk("IMAP 主机", "imap.example.com");
    const auth = mk("授权码", "16位授权码", "password");
    const altAuth = mk("备选授权码（可选，多把逗号分隔）", "旧码A,旧码B（旧码只解密、不能登录）", "password");
    contentEl.createEl("p", {
      text:
        "换过授权码后，旧码通常就不能再登录邮箱了，但它仍是历史加密邮件的解密密钥。" +
        "换码时把旧码填在这里，历史日记才不会解不开。",
    });

    const btn = contentEl.createEl("button", { text: "保存" });
    btn.setCssStyles({ marginTop: "12px" });
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
        imapHost: imapHost || guessImapHost(email),
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

/**
 * 「清空日记邮件」二次确认。
 * 设计要点：删除不可逆，所以把「是否已同步」由程序兜底 ——
 * 点确认后先完整同步一次，同步失败就一封不删；通过后才按 UID 删除。
 */
class CleanupConfirmModal extends Modal {
  plugin: LiuhunReader;
  acct: Account;
  private hits: DiaryMailHit[] = [];
  private busy = false;
  private delBtn?: ButtonComponent;

  constructor(app: App, plugin: LiuhunReader, acct: Account) {
    super(app);
    this.plugin = plugin;
    this.acct = acct;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    new Setting(contentEl).setName("清空邮箱里的日记邮件").setHeading();

    contentEl.createEl("p", {
      text: "永久删除邮箱里由「树洞日记」发出的日记邮件以腾出空间，此操作不可恢复。",
    });
    contentEl.createEl("p", {
      text: "只删除主题形如「Log [标签] 日期」且发件人为本账号的邮件，收件箱、已发送、已删除都会清理，其余不动；点确认后先自动同步一次，同步失败则一封不删。",
    });

    const info = contentEl.createEl("p", { text: "正在检查邮箱…" });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("取消").onClick(() => this.close()))
      .addButton((b) => {
        this.delBtn = b;
        b.setButtonText("检查中…").setDisabled(true).setWarning();
        b.onClick(() => void this.confirmDelete());
      });

    void (async () => {
      try {
        const groups = await scanDiaryMailGroups(this.acct);
        const hits = groups.flatMap((g) => g.hits);
        this.hits = hits;
        if (hits.length === 0) {
          info.setText("邮箱里没有找到可删除的日记邮件。");
          return;
        }
        const sample = hits
          .slice(0, 3)
          .map((h) => `「${h.subject}」`)
          .join("、");
        // 自己发给自己的日记邮件在收件箱和「已发送」各有一份，
        // 确认前把每个文件夹的封数摊开给用户看，避免「删了怎么还有」。
        const detail = groups
          .filter((g) => g.hits.length > 0)
          .map((g) => `${g.label} ${g.hits.length} 封`)
          .join("、");
        info.setText(
          `共找到 ${hits.length} 封日记邮件（${detail}），例如 ${sample} 等。`
        );
        this.delBtn
          ?.setButtonText(`我已同步，删除 ${hits.length} 封`)
          .setDisabled(false);
      } catch (e) {
        info.setText(`检查失败：${(e as Error).message}`);
      }
    })();
  }

  private async confirmDelete() {
    if (this.busy || this.hits.length === 0) return;
    this.busy = true;
    this.delBtn?.setButtonText("正在同步并删除…").setDisabled(true);

    // 1) 程序替用户确认「已同步」：先完整同步一次，失败即中止，一封都不删。
    try {
      new Notice("清理前先自动同步一次…");
      const summary = await syncAccount(
        this.acct,
        this.plugin.app,
        this.plugin.settings.outFolder,
        this.plugin.settings.order
      );
      new Notice(`同步完成：${summary}`);
    } catch (e) {
      new Notice(
        `同步失败，已中止清理，未删除任何邮件：${(e as Error).message}`
      );
      this.busy = false;
      this.delBtn
        ?.setButtonText(`我已同步，删除 ${this.hits.length} 封`)
        .setDisabled(false);
      return;
    }

    // 2) 清理时自己重新扫描 UID（同步不改邮件，但手机上可能刚又发了一封）。
    try {
      const r = await cleanupDiaryMails(this.acct);
      const total = r.inbox + r.sent + r.trash;
      if (r.warnings.length) {
        // 只要有文件夹没清干净，哪怕别的删了也绝不报「清理完成」。
        new Notice(
          `清理未全部完成：成功 ${total} 封；失败：${r.warnings.join("；")}。` +
            `未清掉的邮件仍占空间，请到邮箱确认后再重试。`,
          12000
        );
        this.busy = false;
        this.delBtn
          ?.setButtonText(`我已同步，删除 ${this.hits.length} 封`)
          .setDisabled(false);
        return;
      }
      if (total === 0) {
        new Notice("没有可删除的日记邮件");
        this.close();
        return;
      }
      const parts = r.folders
        .filter((f) => f.deleted > 0)
        .map((f) => `${f.label} ${f.deleted} 封`);
      new Notice(
        `清理完成：${parts.join("、")}日记邮件，已复查确认删除。其他邮件未改动`
      );
      this.close();
    } catch (e) {
      new Notice(`清理失败：${(e as Error).message}`);
      this.busy = false;
      this.delBtn
        ?.setButtonText(`我已同步，删除 ${this.hits.length} 封`)
        .setDisabled(false);
    }
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
    new Setting(containerEl).setName("树洞日记").setHeading();

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

    new Setting(containerEl).setName("账号").setHeading();
    containerEl.createEl("p", {
      text: "邮箱满了可用「清理邮件」腾空间：只删除本 App 发出的日记邮件，其他邮件保留；删除前会再同步一次并二次确认。",
    });
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
          b.setButtonText("清理邮件").setWarning().onClick(() => {
            new CleanupConfirmModal(this.app, this.plugin, acct).open();
          })
        )
        .addButton((b) =>
          b.setButtonText("删除账号").setWarning().onClick(async () => {
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
      b.setButtonText("导入引导配置(.treehole)").onClick(() => {
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
