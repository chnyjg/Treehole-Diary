# Treehole Diary for Obsidian

English | [简体中文](README.zh-CN.md)

Import encrypted diary emails from an IMAP mailbox into Markdown notes in your Obsidian vault.

Treehole Diary (树洞日记) is an Android app focused on one thing: writing. Each entry is sent by email to your own mailbox, and no copy is kept on the phone after a successful delivery. This plugin is the receiving side: it fetches those emails over IMAP, decrypts them locally, and merges them into Markdown notes in your vault. The source code of the companion Android app is not part of this repository.

The plugin works on **desktop only** because it uses the Node.js `crypto` module and an IMAP client.

## Features

- Manage multiple accounts, and enable or disable each one separately.
- Read AES-256-GCM encrypted entries (a fixed diary key in v2, with backward compatibility for entries encrypted with a key derived from the mail authorization code) as well as plain-text entries.
- Import older diary text from import emails and split it into dated entries.
- Save photo attachments under `assets/YYYY-MM-DD/`; no empty folders are created for days without photos.
- Import the `.treehole` bootstrap config exported by the phone app with a single paste, without typing server settings by hand.
- Sync automatically when Obsidian starts or when a diary note is opened (optional, at most once every five minutes), or use the manual **Sync now** command.
- Choose newest-first or oldest-first order for the collected notes.

## Installation

**From the community plugin directory**: select **Settings → Community plugins → Browse**, search for `Treehole Diary`, then install and enable the plugin.

**Manually**: download `main.js`, `manifest.json`, and `styles.css` from Releases and place them in `<vault>/.obsidian/plugins/shudong-diary/`. Restart Obsidian and enable the plugin. The folder name follows the plugin ID `shudong-diary`, which differs from the display name.

## Set up and sync

1. Enable IMAP for your mailbox and generate an **authorization code**, not your login password. The IMAP host is usually `imap.<your email domain>` on port 993 with TLS; check your provider if that does not work.
2. In the Android app, select **Settings → Export bootstrap config** to create a `.treehole` file.
3. In Obsidian, open **Settings → Treehole Diary → Import bootstrap config (.treehole)**, paste the file content, and select **Import**.
4. Select **Sync now**, or enable automatic sync on startup.

You can also add an account manually in the plugin settings (email address, IMAP host, authorization code, and optional older authorization codes). If you have replaced your authorization code, add the old one as an alternative so that older emails can still be decrypted.

## Output files

All files are written to the output folder configured in the settings (`树洞日记/` by default):

- `YYYY-MM-DD.md` — one note per day. These files are the local source of truth; deleting the emails does not delete them.
- `assets/YYYY-MM-DD/` — photos for that day, created only when photos exist.
- `index.md` — an index of dates.
- `all_entries.md` and `all_entries_text.md` — full collections with and without images; the first heading includes the date range.

## Data, privacy, and network use

- Account settings (email address, authorization code, diary key) are stored only on your device in `.obsidian/plugins/shudong-diary/data.json` and are never uploaded.
- The plugin reads and writes only inside the output folder of your vault. **It does not access files outside the vault.**
- The plugin is free, requires no account, contains no ads, and has no telemetry. It does not install or update dependencies, and does not update itself.

**Network use** (disclosure required by the [Obsidian developer policies](https://docs.obsidian.md/community-directory/developer-policies)): this plugin connects **only** to the IMAP server you configure yourself (or one derived from your email address when left blank, port 993, TLS). It reads messages whose subject starts with `Log` and contains a `YYYY-MM-DD` date, downloads their bodies and attachments, and decrypts them locally. It does not send diary content, credentials, or telemetry to the plugin author or to any other service. No other network endpoints are used.

## Encryption

Entry text and attachments use AES-256-GCM. The key comes from the bootstrap config exported by the app; older entries use a key derived from the mailbox authorization code. The bootstrap file itself is an envelope encrypted with a one-time passphrase. See `src/crypto.ts` for the algorithm details. The plugin never uploads the key and never keeps a copy of the emails.

## Build from source

Requires Node.js 20 or later.

```bash
npm ci
npm run build   # Type check with tsc, then bundle main.js with esbuild
npm test        # Encryption alignment and envelope tests
npm run check   # Pre-submit checks: version consistency, manifest rules, required files
npm run notices # Regenerate third-party license notices after dependency updates
```

## Publish a release (maintainers)

1. Update the version in three places: `manifest.json`, `package.json`, and `versions.json` (add `"x.y.z": "minAppVersion"`).
2. Run `npm run build && npm run check`.
3. Commit and push. Create a Git tag whose name matches the version exactly, **without a `v` prefix** (for example `0.1.0`).
4. Create a GitHub Release for that tag and upload three binary assets: `main.js`, `manifest.json`, and `styles.css`.
5. For the initial submission, sign in to [community.obsidian.md](https://community.obsidian.md), link your GitHub account, select **Add plugin**, and submit `chnyjg/Treehole-Diary`. The review is automated; to address its feedback, update the repository, increment the version, and publish a new Release. After the plugin is published, later versions only need a new Release, not another directory submission.

`main.js` is a build artifact and is excluded by `.gitignore`. Take it from the repository root when you create the Release.

## Third-party code

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the `licenses/` folder. Main runtime dependencies include imapflow (MIT), mailparser (MIT), and nodemailer (MIT-0).

## License

[MIT](LICENSE)
