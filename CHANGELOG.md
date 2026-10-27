# Changelog

All notable changes to Doseline are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2026-10-27

### Fixed

- History: the *Escalated* tag overlapped the "late · due" text. The status column is now wide enough for both tags, and they wrap instead of overflowing.

## [1.0.0] - 2026-10-27

First public release.

> **Pre-version-control reconstruction.** Doseline was developed before it was put under version control, so the
> work in this release has no individual commits or dates. The entries below were reconstructed afterwards from
> `DECISIONS.md`, the documentation and the code, and are grouped by development phase in the order the work
> happened. Exact dates are unknown.

### Added

#### Initial build

- Windows desktop app built with Electron, React and TypeScript, with a pure-TypeScript domain core (`src/core`) behind platform interfaces, and SQLite storage with append-only migrations.
- Three schedule types:
  - every N hours, measured in real elapsed time from the last dose;
  - fixed wall-clock times on chosen weekdays, correct across DST and time-zone changes;
  - as needed (PRN), with a minimum interval, an optional 24-hour cap and an optional "available again" reminder.
- Medications have pause and resume, course start and end dates, and inventory with refill alerts.
- Logging: Take now, Took it at… (backdate), Skip, editing and deleting history, and a 10-second Undo that reverses inventory, calendar and alarms.
- Safety warnings for a PRN dose taken too soon, the 24-hour cap, and likely duplicates. They are warnings with "Log anyway", never hard blocks.
- Local alarms:
  - reminders before each dose (30 and 15 minutes by default), editable globally and per medication;
  - each one shows a native Windows notification and an always-on-top alarm window with Take, Skip and Snooze (5, 10 or 15 minutes);
  - bundled synthesized sounds (chime, bell, pulse).
- Robust timing:
  - the alarm plan is recomputed on startup, data changes, resume from sleep, unlock, clock jumps and time-zone changes;
  - doses that came due while the PC was off are shown once as "Missed while you were away".
- Screens: Today (countdown rings and a day timeline), Medications, History, Adherence (on-time rates, streaks, a calendar heatmap and a configurable grace window), Inventory and Settings.
- Optional Google Calendar sync:
  - OAuth 2.0 with PKCE through a loopback redirect, in the system browser;
  - the `calendar.app.created` scope, with a dedicated *Medications* calendar holding one "next dose" event per medication;
  - tagged with private extended properties, matching popup reminders and the nearest Google event color;
  - an offline queue with exponential backoff, and a "Reconnect Google" state when access is revoked;
  - credentials and tokens encrypted with Windows DPAPI through Electron `safeStorage`.
- System integration: tray icon with quick-log, launch at sign-in (starting in the tray), a single running instance, and the Ctrl+Alt+M quick-log palette.
- Export: CSV history, a printable PDF doctor report, and JSON backup and restore.
- Design:
  - dark-first with a matching light theme;
  - Windows 11 Mica with a custom title bar, and bundled Geist font with tabular numerals;
  - keyboard accessible, with reduced-motion support and empty states.
- Hidden developer tools (click the version in Settings five times): fire a test alarm, and create a real 2-minute test dose.
- Security hardening: context isolation, sandboxed renderers, strict CSP, validated IPC, a rotating log that redacts secrets, and no tokens or medication data in production console output.
- `SETUP.md` (Google Cloud steps), `README.md` and `DECISIONS.md`.

#### Online drug lookup

- Drug-name autocomplete in the medication editor:
  - live data from the NLM Clinical Table Search Service (RxTerms v3);
  - an accessible combobox, debounced and cancellable, so stale responses are discarded;
  - client-side ranking that puts drugs you already have first;
  - matched text in bold, route labels, and a *Brand* tag.
- Salts and formulations stay separate entries. Free text always works, and editing a picked name unlinks it.
- Strength suggestions as chips grouped by form, parsed from RxTerms strength strings. Combinations, concentrations, extended release, patches, inhalers and injectables are all handled, and unparseable strings stay selectable.
- Strength ordering:
  - strengths you've used before first, marked "Yours";
  - then the number of finished products listed in the openFDA NDC directory, with a "Common" marker;
  - then numeric order;
  - a short animation when the ranking arrives.
- Custom strengths are remembered per drug.
- Medications store their catalog link (RXCUI, display name, source) through a new migration. Existing medications offer "Link to …" when their name matches.
- Caching: an in-session LRU for searches, and a 30-day SQLite cache for strengths and rankings, so saved medications show strength suggestions offline.
- Settings → Drug lookup: an on/off switch with a privacy note, and an optional openFDA API key stored encrypted.
- Recorded API fixtures, unit tests for the parsers and ranking, and an opt-in live API smoke test (`npm run test:live`).

#### Overdue escalation

- A second alert level when a scheduled dose stays unlogged past a threshold:
  - the threshold defaults to 30 minutes (1 h, 2 h, custom 5 min–6 h, or Off per medication);
  - it repeats on an interval (default 15 minutes, 5–60) until the dose is taken, backdated, skipped or snoozed;
  - snooze (15, 30 or 60 minutes) defers only the next repeat.
- How it ends:
  - fixed-time doses stop escalating when the next dose comes due, and the old one counts as missed;
  - every-N-hours doses escalate until you act;
  - as-needed doses never escalate.
- The escalated alarm window has a live "Overdue by" counter, one consolidated list for several medications, and one sound per cycle. Its urgent sound (Urgent, Siren or Bell) is chosen separately, and the taskbar button flashes until acknowledged.
- Notifications on the first escalation, and on repeats when the window isn't focused.
- Optional quiet hours mute escalation sound while still showing the alarm.
- State is derived from persisted data (a new migration adds an `escalations` table and escalation fields on dose logs). Restarts, sleep, clock and time-zone changes and DST all stay correct. Escalations that happened while the PC was away are folded into the away summary, with no backlog burst.
- Escalation is recorded in history (an *Escalated ×N* tag, and new CSV columns). A dose taken after escalation counts as late in adherence.
- An escalated state on the Today dashboard, Settings → Overdue alerts, and a per-medication override in the editor.
- Developer tools: escalation test doses due in 1 minute, and a preview of the escalated alarm window.

#### Preparing the public release

- Developer tool **Load demo data**: a deterministic, fictional dataset (five medications, about six months of history). It is refused while Google is connected. All screenshots were regenerated from it.
- `SECURITY.md`, issue templates, an MIT license, a rewritten README with a medical disclaimer and privacy section, and a GitHub Actions workflow that tests every push and builds the installer and portable exe for tagged releases.

### Changed

- Google sign-in and consent (reconstructed):
  - Requests offline access with a consent prompt, so a refresh token is always issued.
  - Verifies the granted scopes after sign-in, with a clear error if the Calendar permission checkbox was left unticked.
  - Validates the client ID format before starting sign-in.
- `SETUP.md` gained explicit steps:
  - an External consent screen with yourself as a test user;
  - publishing the app **In production**, because Testing-mode refresh tokens expire after 7 days;
  - getting past Google's "hasn't verified this app" warning;
  - first-time Google Cloud terms, with no billing needed.
- The medication editor's strength field is split into amount, unit and a free-text form, so suggestions can fill each part.
- Within a ranking tier, drug suggestions blend NLM's relevance order with name length. Strict shortest-first surfaced rare brands above common drugs.

### Fixed

#### Initial build

- Closing the main window from the renderer destroyed it. It is now hidden to the tray and recreated on demand.
- The alarm engine could misread a timer that fired late after sleep. Late timers are now detected against the time they were armed for.
- Today's "taken" progress counted as-needed doses; it now counts scheduled medications only.
- Adherence heatmap cells stretched to fill the width; they now keep a square aspect over a fixed 39-week range.
- Medication cards repeated the same information in their subtitle.
- The quick-log palette's focus ring overflowed its search field.
- Pluralization: "1 entries", and unit labels in Inventory.
- Clearer quick-log palette wording after logging a dose.

#### Online drug lookup

- "Common" was shown on strengths that tie with every other strength of the same form.
- Two different fields in the editor were both labelled "Unit"; the dose field is now "Dose unit".
- RxTerms returns `"NA"` for some codes; these are now treated as missing.
- The openFDA API key is sent first in the query, as openFDA's documentation asks.
- Drug-lookup failures were logged with a redacted reason; the error category is now visible (still without any drug names).

#### Overdue escalation

- The alarm window collapsed to its minimum height with several overdue medications, cutting off rows. It now grows to fit (up to 720 px, then scrolls).
- Row actions wrapped onto two lines; the escalated window is now wider so they fit.
- Notifications for three or more overdue medications were cut off; they now summarize as "and N more".
- Wording of the single-dose escalated alarm.

[Unreleased]: https://github.com/Nocturnxl/doseline/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/Nocturnxl/doseline/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Nocturnxl/doseline/releases/tag/v1.0.0
