# Changelog

## 0.1.3

- Fix "Delete diary emails": independent short-lived IMAP connections for INBOX / Sent / Trash plus a fresh-connection re-check, so a success notice really means the messages are gone.
- Make account setup wording provider-neutral and derive the IMAP host from the email address.
- Unify the bootstrap config file extension to `.treehole` across the phone apps and this plugin. Files exported by older app versions still import fine — the plugin reads pasted JSON text, not the filename.
- Generated notes now keep only the inline `#tag`: the plugin no longer writes a duplicate `- Tags: xxx` line, and legacy lines in existing day notes are removed on sync. The index and tag statistics still work.

## 0.1.0

- Initial release.
- Import encrypted diary emails over IMAP, decrypt them locally and merge them into Markdown notes.
- Support multiple accounts, bootstrap config import, photo attachments and optional auto sync.
