# Security policy

Doseline handles sensitive personal information (medications and dose history) and stores Google OAuth credentials
on the user's PC, so security reports are taken seriously.

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**
   (direct link: <https://github.com/Nocturnxl/doseline/security/advisories/new>).
3. Describe the issue, the affected version, and steps to reproduce.

Don't include real medication data or unredacted logs in a report. If a log is needed, remove medication names,
dose details and any tokens first.

You can expect an acknowledgement within a week. Once a fix is released, the advisory will be published with credit
to the reporter, unless you prefer to stay anonymous.

## Scope

In scope:

- How credentials and tokens are stored (Electron `safeStorage` / DPAPI).
- The OAuth flow (PKCE, loopback redirect).
- Renderer isolation (context isolation, sandbox, CSP) and IPC input validation.
- Anything that could leak medication data off the machine.

Out of scope:

- Issues that require an attacker who already controls the user's Windows account.
- Missing code signing on the installer (known and documented in the README).
