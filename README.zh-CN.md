# Treehole Diary（树洞日记）for Obsidian

[English](README.md) | 简体中文

> Import encrypted diary emails from an IMAP mailbox into Markdown notes in your vault.

「树洞日记」是一个只负责「记」的 Android App：写完的日记通过邮件发到你自己的邮箱，投递成功后本地不留底。本插件是配套的收件端——通过 IMAP 从邮箱取回这些日记，解密后合并成 Obsidian 库里的 Markdown 文件。配套 App 的源码不在本仓库。

本插件只在 **桌面版 Obsidian** 可用：它用 Node.js 的 `crypto` 与 IMAP 客户端读取邮件。

## 功能

- 多账号管理，可分别启用或停用。
- 支持 AES-256-GCM 加密日记（v2 固定日记密钥，兼容早期由授权码派生密钥的邮件）与明文邮件。
- 支持「导入旧日记」邮件，把历史文本按日期拆成条目。
- 支持照片附件，落到 `assets/日期/`；没有照片的日期不会生成空目录。
- 可导入手机 App 导出的 `.treehole` 引导配置（一次性粘贴，无需手抄服务器参数）。
- 打开 Obsidian 或打开日记目录时自动同步（可关闭，5 分钟内最多一次）；也可手动点「立即同步」。
- 汇总稿排序可选「新在上 / 早在上」。

## 安装

**从社区插件市场**：Obsidian → 设置 → 第三方插件 → 浏览社区插件 → 搜索 `Treehole Diary` → 安装并启用。

**手动安装**：从本仓库 Releases 下载 `main.js`、`manifest.json`、`styles.css`，放入
`<vault>/.obsidian/plugins/shudong-diary/`，重启 Obsidian 后启用。目录名沿用插件 ID `shudong-diary`，与显示名不同。

## 配置与同步

1. 在邮箱服务商开启 IMAP，并生成**授权码**（不是登录密码）。IMAP 主机通常形如 `imap.<邮箱域名>`（端口 993，TLS），以服务商说明为准。
2. 手机 App：设置 → 导出引导配置，得到 `.treehole` 文件。
3. Obsidian：设置 → Treehole Diary → 导入引导配置(.treehole) → 粘贴文件内容 → 导入。
4. 点「立即同步」，或启用「打开时自动同步」。

也可以在插件设置里手动添加账号（邮箱、IMAP 主机、授权码、备选授权码）。换过授权码时把旧码填进「备选授权码」，历史邮件才仍能解密。

## 输出文件

写入设置里指定的输出文件夹（默认 `树洞日记/`）：

- `YYYY-MM-DD.md`：按天归档的单日文件，是本地主数据；删除邮箱里的邮件不会删掉这些文件。
- `assets/YYYY-MM-DD/`：当天的照片，仅在确有照片时创建。
- `index.md`：日期索引。
- `all_entries.md` / `all_entries_text.md`：全文汇总（含图 / 纯文字），首行标题带日期范围。

## 数据存储、隐私与网络使用

- 账号配置（邮箱、授权码、日记密钥）只保存在本机 `.obsidian/plugins/shudong-diary/data.json`，不会上传。
- 插件只读写 Obsidian 库内的输出文件夹，**不访问库外文件**。
- 免费、无需账号、无广告、无遥测、不自动安装或更新依赖、不自动更新自身。

**Network use / 网络使用（开发者政策披露）**

This plugin connects **only** to the IMAP server that you configure yourself (or one derived from your email address when left blank, port 993, TLS). It reads messages whose subject starts with `Log` and contains a `YYYY-MM-DD` date, downloads their bodies and attachments, and decrypts them locally. It does not send diary content, credentials, or telemetry to the plugin author or to any other service. No other network endpoints are used.

中文同上：插件仅连接你自己填写（或留空时按邮箱地址推导）的 IMAP 服务器（端口 993，TLS），只读取主题以 `Log` 开头且含日期的邮件及其附件，解密全部在本机完成；不会把日记、凭据或任何统计数据发给作者或第三方，也没有其他网络端点。

## 加密说明

日记正文与附件使用 AES-256-GCM 加密，密钥来自 App 导出的引导配置（或早期版本的邮箱授权码派生）。引导文件本身是一次性口令加密的信封。算法细节见 `src/crypto.ts`。插件不上传密钥，也不保存邮件副本。

## 从源码构建

需要 Node.js 20 或更新版本。

```bash
npm ci
npm run build   # tsc 类型检查 + esbuild 打包出 main.js
npm test        # 加解密对齐测试
npm run check   # 上架前自检：版本一致性、manifest 规范、必需文件
npm run notices # 依赖升级后重新生成第三方许可证声明
```

## 发布新版本（维护者）

1. 同步三处版本：`manifest.json`、`package.json`、`versions.json`（新增 `"x.y.z": "minAppVersion"`）。
2. `npm run build && npm run check`。
3. 提交并推送；创建 Git tag，名称与版本号完全一致、**不带 `v` 前缀**（如 `0.1.0`）。
4. 在 GitHub 创建同名 tag 的 Release，上传三个二进制附件：`main.js`、`manifest.json`、`styles.css`。
5. 首次上架：登录 [community.obsidian.md](https://community.obsidian.md) → 绑定 GitHub 账号 → Add plugin → 提交 `chnyjg/Treehole-Diary`。审核是自动的，反馈里指出的问题需改仓库、**递增版本号并重发 Release** 才会重新检查。上架成功后，后续版本只需发 Release，无需再次提交目录。

`main.js` 是构建产物，已被 `.gitignore` 排除；发 Release 时直接从本地仓库根目录取文件即可。

## 第三方代码

见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 `licenses/` 目录。运行时主要依赖：imapflow (MIT)、mailparser (MIT)、nodemailer (MIT-0) 等。

## License

[MIT](LICENSE)
