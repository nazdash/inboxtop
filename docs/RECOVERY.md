# Recovery and removal

## Connection recovery

For connection errors, open Settings → Email / API credentials or run
`inboxtop setup`. Test email and AI separately. Unlock the OS credential store if
needed. On Linux, a Secret Service session and `secret-tool` are required. Headless
users can explicitly use protected `--env` configuration instead.

Use `doctor --json` for offline diagnosis. `doctor --test-vault --json` additionally
creates, reads and deletes a uniquely named fictional credential. Neither connects
to email or AI. The vault test may prompt the OS to unlock; do not run it as an
implicit installation side effect.

Never delete encrypted mail/history to fix credentials. Preserve the whole account
directory, including its cache key, when making a private backup. Losing the key
makes encrypted history unreadable. Do not share backups in issues or treat them
as a full mailbox archive.

Stop analysis in the UI before removing the app. Hiding the menu companion or
closing a terminal does not stop a worker. On macOS, if Live installed a launch
agent, inspect `~/Library/LaunchAgents/local.inboxtop.*.plist` to identify this
account's label. Use `launchctl bootout gui/$(id -u)/LABEL` for that exact service,
then remove its plist to prevent restart. Do not remove unrelated launch agents.
For a detached worker without launchd, identify the matching `inboxtop --worker`
process and terminate it gracefully; never use a broad process kill command.

Removing the executable/menu app is separate from deleting user data. Keep config,
credential-store entries and `~/.local/share/inboxtop-terminal/` to retain settings
and history. Only delete them when the user explicitly asks to erase local data.
The profile's `credential` UUID identifies its entry under service
`dev.inboxtop.credentials` in the OS store. Deleting local data does not delete
emails on the server or revoke an app password at the provider.
