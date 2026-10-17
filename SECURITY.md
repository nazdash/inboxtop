# Security and privacy

Do not put credentials, original mail, cache files or personally identifying
screenshots in public issues. Report reproducible bugs with fictional input.

Report sensitive vulnerabilities through [GitHub private vulnerability reporting](https://github.com/nazdash/inboxtop/security/advisories/new).
This channel is enabled. Do not open a public issue containing exploit details,
private email or credentials. If private reporting is temporarily unavailable,
ask the maintainer to restore the channel without including sensitive details.

inboxtop authenticates IMAP over TLS with certificate validation. Setup stores
secrets in an OS credential store; explicit legacy `.env` configuration is plaintext
and must be protected separately. No TLS bypass or automatic plaintext fallback.

Cloud analysis sends selected email content/findings to the configured AI provider.
Local Ollama stays on loopback with no cloud fallback. There is no product analytics.
Chat reuses saved mail and can automatically perform bounded read-only retrieval
from the already-configured mailbox to answer a question. No separate access
switch is required. It never downloads attachments or opens
linked pages. Retrieved excerpts are processed by the selected model, including
local Ollama. Worker-enforced request, byte, time and cumulative limits apply to
both providers; these are not a global provider spending cap. Email content and
model-proposed plans remain untrusted. Chat retains allowlisted IMAP error codes
for diagnostics, never raw IMAP command/response logs. The model cannot change limits, credentials,
provider, mailbox names or read flags through retrieval tools.
Opening a message does not mark it read. Model output is not authority to change
mail without the application's confirmation and scope controls.

Cached mail is encrypted locally, but its key is alongside the cache. Someone who
can read both can decrypt the data. Retention is bounded; this is not a mail backup.
Local worker IPC is restricted through POSIX socket ownership and directory permissions.
Native Windows worker security/portability is not yet verified or release-supported.

Updates must preserve saved data. Do not recommend deleting caches, turning off
TLS or retrying uncertain mailbox writes as a generic fix. Stop analysis first
when investigating provider failures, and share only sanitized diagnostics.
