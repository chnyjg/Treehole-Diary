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

/** 设置页文案字典：中英双语。切换语言只影响界面文字，不影响任何数据/邮箱/加密逻辑。 */
const L = {
  zh: {
    title: "树洞日记",
    language: "语言",
    languageDesc: "设置页的界面语言",
    langAuto: "跟随 Obsidian",
    langZh: "中文（简体）",
    langEn: "English",
    syncNow: "立即同步",
    outFolder: "输出文件夹",
    outFolderDesc: "合并后的 Markdown 写到 vault 下的此文件夹",
    order: "合并稿排序",
    orderDesc: "newest=新日记在上，oldest=旧日记在上",
    newest: "新日记在上",
    oldest: "旧日记在上",
    autoSync: "自动同步",
    account: "账号",
    importCfg: "导入引导配置(.treehole)",
    importCfgDesc: "粘贴或导入从「树洞日记」App 导出的引导配置文件",
    accountHint:
      "邮箱满了可用「清理邮件」腾空间：只删除本 App 发出的日记邮件，其他邮件保留；删除前会再同步一次并二次确认。",
    cleanMail: "清理邮件",
  },
  en: {
    title: "Treehole Diary",
    language: "Language",
    languageDesc: "Interface language of the settings page",
    langAuto: "Follow Obsidian",
    langZh: "Chinese (Simplified)",
    langEn: "English",
    syncNow: "Sync now",
    outFolder: "Output folder",
    outFolderDesc: "Merged Markdown files are written to this folder in the vault",
    order: "Merged note order",
    orderDesc: "newest = new diary first, oldest = old diary first",
    newest: "New diary first",
    oldest: "Old diary first",
    autoSync: "Auto sync",
    account: "Accounts",
    importCfg: "Import setup config (.treehole)",
    importCfgDesc:
      "Paste or import the setup config file exported by the Treehole Diary app",
    accountHint:
      "If the mailbox is full, use \"Clean mail\" to free space: only diary emails sent by this app are removed, all other emails are kept; it syncs once more and asks for confirmation before deleting.",
    cleanMail: "Clean mail",
  },
} as const;

/** 把设置里的语言偏好解析成实际渲染语言：auto 时读 Obsidian 自身的界面语言。
 *  Obsidian 把语言存在 localStorage 的 "language" 键（如 zh / zh-TW / en）。 */
function resolveLang(pref: "zh" | "en" | "auto"): "zh" | "en" {
  if (pref === "zh" || pref === "en") return pref;
  const raw = (
    window.localStorage.getItem("language") ||
    navigator.language ||
    "en"
  ).toLowerCase();
  return raw.startsWith("zh") ? "zh" : "en";
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** IMAP 主机留空时按邮箱域名推导：name@example.com → imap.example.com。
 *  各服务商主机不同时，引导配置里可直接带来正确的 imapHost。 */
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
        window.setTimeout(() => this.maybeAutoSync(), 3000);
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
            void this.maybeAutoSync();
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
    if (!this.settings.accounts || this.settings.accounts.length === 0) return;
    this.lastAutoSync = now;
    this.autoSyncing = true;
    try {
      await this.syncAll();
    } finally {
      this.autoSyncing = false;
    }
  }

  async syncAll() {
    const list = this.settings.accounts;
    if (list.length === 0) {
      new Notice("还没有账号，请先在设置里导入引导配置");
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
    } catch {
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
      this.replaceAccountFromCfg(
        obj.email,
        obj.imapHost || guessImapHost(obj.email),
        obj.authCode,
        typeof obj.diaryKey === "string" ? obj.diaryKey : undefined
      );
      return;
    }
    // 加密信封格式（旧文件兼容）：需要口令解密
    if (obj && typeof obj.alg === "string" && obj.ct) {
      new PassphraseModal(this.app, (pass) => {
        try {
          const cfg = decryptEnvelope(obj as Envelope, pass);
          this.replaceAccountFromCfg(cfg.email, cfg.imapHost, cfg.authCode);
        } catch {
          new Notice("解密失败：口令或文件有误");
        }
      }).open();
      return;
    }
    new Notice("内容不是有效的引导配置");
  }

  /**
   * 覆盖式导入：永远只保留一个邮箱账号。
   * 每次导入引导配置都整体替换账号列表，而不是按邮箱追加/更新。
   * 原因：插件按日期命名日记文件，多个邮箱同时开启会在同一天互相覆盖、静默丢内容。
   * 这样从源头保证「永远只有一个邮箱在同步」。
   */
  private replaceAccountFromCfg(
    email: string,
    imapHost: string,
    authCode: string,
    diaryKey?: string
  ) {
    if (!email || !authCode) {
      new Notice("配置缺少邮箱或授权码");
      return;
    }
    const host = imapHost || guessImapHost(email);
    // 整体替换：清掉旧账号（含旧邮箱），只留配置里这一个，永远保证单一邮箱
    this.settings.accounts = [
      {
        id: genId(),
        email,
        imapHost: host,
        authCode,
        diaryKey: diaryKey && diaryKey.trim() ? diaryKey.trim() : undefined,
      },
    ];
    void this.saveSettings();
    new Notice(`已导入账号：${email}（已替换原有账号，当前只保留这一个邮箱）`);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.accounts) this.settings.accounts = [];
    // 永远只保留一个邮箱：兼容老配置里残留的多个账号，收敛为第一个启用的（否则第一个）。
    // 与「导入即覆盖」配合，从加载和导入两端都保证单邮箱，避免日记按日期同名互相覆盖。
    if (this.settings.accounts.length > 1) {
      const keep = this.settings.accounts[0];
      const dropped = this.settings.accounts.length - 1;
      this.settings.accounts = [keep];
      await this.saveSettings();
      window.setTimeout(
        () => new Notice(`已收敛为单个邮箱账号（移除 ${dropped} 个旧账号）`),
        0
      );
    }
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
    readBtn.addEventListener("click", () => {
      void (async () => {
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
      })();
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
        b.setButtonText("检查中…").setDisabled(true);
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
    const t = L[resolveLang(this.plugin.settings.language)] || L.zh;

    new Setting(containerEl).setName(t.title).setHeading();

    // 最常用的操作放最上面，不用滚到设置页底部去找。
    new Setting(containerEl)
      .setName(t.syncNow)
      .addButton((b) =>
        b
          .setButtonText(t.syncNow)
          .setCta()
          .onClick(() => this.plugin.syncAll())
      );

    new Setting(containerEl)
      .setName(t.outFolder)
      .setDesc(t.outFolderDesc)
      .addText((text) =>
        text
          .setValue(this.plugin.settings.outFolder)
          .onChange(async (v) => {
            this.plugin.settings.outFolder = v.trim() || "treehole";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t.order)
      .setDesc(t.orderDesc)
      .addDropdown((d) =>
        d
          .addOption("newest", t.newest)
          .addOption("oldest", t.oldest)
          .setValue(this.plugin.settings.order)
          .onChange(async (v) => {
            this.plugin.settings.order = v as "newest" | "oldest";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t.autoSync)
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.autoSyncOnOpen)
          .onChange(async (v) => {
            this.plugin.settings.autoSyncOnOpen = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t.language)
      .setDesc(t.languageDesc)
      .addDropdown((d) =>
        d
          .addOption("auto", t.langAuto)
          .addOption("zh", t.langZh)
          .addOption("en", t.langEn)
          .setValue(this.plugin.settings.language)
          .onChange(async (v) => {
            this.plugin.settings.language = v as "zh" | "en" | "auto";
            await this.plugin.saveSettings();
            this.display(); // 立即用新语言重绘设置页
          })
      );

    new Setting(containerEl).setName(t.account).setHeading();
    new Setting(containerEl)
      .setDesc(t.importCfgDesc)
      .addButton((b) =>
        b.setButtonText(t.importCfg).setCta().onClick(() => {
          this.plugin.importConfig();
        })
      );
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: t.accountHint,
    });
    this.plugin.settings.accounts.forEach((acct) => {
      new Setting(containerEl)
        .setName(acct.email)
        .setDesc(acct.imapHost)
        .addButton((b) =>
          b.setButtonText(t.cleanMail).setWarning().setCta().onClick(() => {
            new CleanupConfirmModal(this.app, this.plugin, acct).open();
          })
        );
    });
  }
}
