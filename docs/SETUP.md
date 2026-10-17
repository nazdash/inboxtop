# Set up inboxtop

From a source checkout, install Node.js/npm, run `npm ci`, then `npm start`.
The pinned Bun runtime runs the app. Prefer a current Node.js version matching
the OpenTUI package's development requirements (Node 26.4+); end-user executable
builds do not need Node, npm or Bun installed separately.

On first launch, choose **Try demo** for fictional mail or **Connect email**.
Use arrows/Tab and Enter throughout; Esc cancels an edit or goes back.

1. Choose Gmail, Fastmail, iCloud or Custom IMAP; enter your address and app password.
   Presets fill the server and TLS port. Passwords are masked.
   **Test email connection** authenticates and opens INBOX read-only; it does not
   fetch messages for AI or change read flags. Continue after the test passes.
2. Choose **OpenAI** or **Ollama**. Enter a masked API key for OpenAI. For Ollama,
   supply a loopback server and installed model tags. Nothing is downloaded for you.
   **Test AI** tests classification and detailed review using fictional text. For
   OpenAI these are two potentially billable requests; no private emails are sent.
3. **Save securely and open inbox** stores credentials in the OS credential store.
   Saving returns the account to Ad hoc. Existing reviews and Chat are retained.
4. Choose **New analysis** on the dashboard. The first suggested batch is 10 emails.
   Starting cloud analysis sends selected email content to your chosen provider.
   Reading/opening a message never marks it read. Mark read is a separate action.

Gmail uses `imap.gmail.com`, Fastmail uses `imap.fastmail.com`, and iCloud uses
`imap.mail.me.com`, all on TLS port 993. Use an app password when the provider
requires one. Gmail app-password eligibility depends on account settings; Fastmail
Basic plans do not support IMAP. See the provider instructions for
[Gmail](https://support.google.com/accounts/answer/185833),
[Fastmail](https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports)
and [iCloud](https://support.apple.com/en-us/102525).
Custom providers must support password-based IMAP over implicit TLS. Consult
your provider for its server and app-password requirements. OAuth is not yet
implemented; an ordinary account password may not work. Microsoft accounts that
require OAuth cannot use this first setup path. Never disable TLS verification.

Secrets are stored in macOS Keychain or Windows Credential Manager through the
native adapter. Linux uses `secret-tool` with a running Secret Service (such as
your desktop keyring); install your distribution's libsecret tools if missing.
A locked or unavailable store produces an error and keeps the draft. There is no
automatic plaintext fallback. Native Windows worker support is not release-ready,
even though the credential adapter supports Windows.

Nonsecret configuration is stored at:

- macOS: `~/Library/Application Support/inboxtop/config.json`
- Linux: `$XDG_CONFIG_HOME/inboxtop/config.json`, otherwise `~/.config/inboxtop/config.json`
- Windows: `%APPDATA%\inboxtop\config.json` (runtime support pending)

Run `inboxtop setup` to reconnect or change credentials. In Settings, **k Email /
API credentials** opens the same flow. Finish/discard unsaved settings, stop active
work and switch to Ad hoc first. A saved default profile takes precedence over
automatic `.env`/environment configuration. Explicit `--env PATH` still selects a
complete isolated legacy account; `--profile PATH` selects a saved secure profile.
Never combine them. Saving setup does not delete the original `.env` file.

Advanced users can still use `.env.example` and `--env PATH`. That is plaintext
configuration: keep it private and owner-readable, never upload it. Existing mail
data remains in `~/.local/share/inboxtop-terminal/<account-hash>/` unless configured
otherwise. The cache key lives beside encrypted data, so filesystem access to both
can decrypt it; this is not a complete mailbox archive.

Use `inboxtop doctor --json` for offline diagnostics. It does not authenticate or
send requests. See [agent setup](AGENT-SETUP.md) for automation contracts.
Closing the terminal does not stop an existing worker. Choose Stop analysis or
Ad hoc before closing if you do not want automatic analysis to continue.

If saving is interrupted, the previous profile remains usable until the new profile
is atomically committed. A `config.json.lock` file prevents concurrent setup saves;
remove a stale lock only after checking that no setup process is still running.
Never erase the mail cache to fix a connection problem.
