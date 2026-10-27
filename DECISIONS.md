# Decisions

Decisions made while building Doseline, with the reasoning, so they can be revisited deliberately.

## Platform and tooling

| Decision | Why |
|---|---|
| **Electron 44.9.3** (not 45.0.0) | 45.0.0 was days old when the project started. 44 is the mature line with the same Windows features (Mica `backgroundMaterial`, `titleBarOverlay`, `safeStorage`). |
| **electron-vite 6 + Vite 8 + React 19**, TypeScript **6.0** | TypeScript 7 (the native port) had just shipped; 6.0 is the conservative choice for the tooling ecosystem. Strict mode plus `noUncheckedIndexedAccess`. |
| **better-sqlite3 13** with **no native rebuild** | v13 ships N-API prebuilds (`prebuilds/win32-x64.node`). N-API is ABI-stable across Node and Electron, so the same binary loads in both. Verified by loading it under `ELECTRON_RUN_AS_NODE`. Packaging sets `npmRebuild: false`, so building needs no MSVC toolchain. `postinstall` still runs `electron-builder install-app-deps` for safety, and `.node` files are `asarUnpack`ed. |
| npm `allowScripts` | npm 11 blocks install scripts by default. Only `electron` (binary download) and `electron-winstaller` are allowed; `better-sqlite3`'s source build is explicitly disabled because the prebuild is used. |
| **luxon** inside `src/core` | Pure JS, runs unchanged in a browser, and handles DST gaps and overlaps correctly. Hand-rolling zone math is where medication apps get bugs. |
| **lucide-react** icons plus custom glyphs | An icon set, not a component library. All other UI components are hand-built. |
| **Geist Variable** via `@fontsource-variable/geist` | Bundled by Vite into the app (woff2 files in `out/renderer/assets`). No network font loading. |
| Sounds synthesized by `scripts/make-sounds.cjs` | Avoids licensing third-party audio. Three short WAVs (chime, bell, pulse) are generated deterministically. |
| Icon drawn as SVG and rasterized by Electron (`scripts/make-icons.cjs`) | Produces a PNG-compressed multi-size `.ico` (16–256 px) for app and tray, with no ImageMagick dependency. The tray uses a simplified capsule glyph that stays legible at 16 px on light and dark taskbars. |

## Architecture

- **`src/core` is pure TypeScript.** `tsconfig.core.json` compiles it with `"types": []` and only the `DOM` lib, so any Node or Electron import fails the typecheck.
  - Platform concerns sit behind interfaces in `src/core/ports.ts`: `Repository`, `TokenStore`, `AccessTokenProvider`, `CalendarGateway`, `TimerScheduler`, `AlarmPresenter`, `Clock`, `Logger`.
  - Core includes the orchestration as well as the math. `DoseService` handles logging, undo and edits. `CalendarSync` is the queue and reconcile loop. `AlarmEngine` is the timer plan. `GoogleCalendarGateway` uses only standard `fetch`. A web port only needs new adapters: IndexedDB repository, browser timers, a web OAuth flow, and Web Notifications.
- **Repository is async** even though better-sqlite3 is synchronous, so IndexedDB can implement the same interface.
- **Migrations** are an append-only array tracked with `PRAGMA user_version`. Medications are stored as JSON blobs with indexed columns for name and timestamps. Dose logs are fully relational. All instants are stored as UTC ISO strings so they sort lexically.
- **The renderer imports `src/core`** for read-only derivations (Today, Adherence, Inventory). Every mutation goes through typed IPC to main, which owns the database. Main pushes a debounced `AppSnapshot` after every change.
- **Single composition root:** `src/main/controller.ts`.

## Schedule semantics

- **Interval** schedules measure *absolute elapsed time* from the last logged dose. "Every 8 h" is always 8 real hours, even across DST. A skip advances from the *skipped slot*, not from when the skip button was pressed. With no history, the first dose is due at `firstDoseAt` (defaults to the creation time).
- **Fixed** schedules are *wall-clock times in the user's current zone*:
  - On a spring-forward day, a slot in the gap (02:30) moves to the first valid instant (03:30).
  - On a fall-back day, an ambiguous slot fires once, at its first occurrence. Tests assert exactly one slot either way.
  - After a zone change, slots are re-evaluated in the new zone. Already-handled slots are never repeated.
- **Pending and overdue:** an unlogged fixed slot stays pending (status *due*, then *overdue*) until the next slot arrives, capped at 24 h. After that it counts as **missed**. The "next dose" therefore shows an overdue dose rather than silently skipping ahead, which matches "the next scheduled slot after now" once the overdue dose is handled.
- **Slot assignment:** logging a fixed-time dose fulfils the nearest *unhandled* slot within ±12 h. That's how "took it early" and "took it late" both work, and why backdating lands on the right slot.
- **Status:** *upcoming* before due, *due* from the due time until the grace window ends, *overdue* after it.
- **PRN:**
  - Availability is `max(last dose + min interval, the time the oldest dose in a full 24 h window ages out)`.
  - A PRN med gets an alarm and calendar event only when "Remind me when it's available" is on.
  - PRN doses can't be skipped (there's nothing to skip).
- **Safety checks** are warnings shown in a confirm dialog ("Log anyway"); nothing is ever hard-blocked:
  - logging a PRN dose before its minimum interval;
  - exceeding the PRN 24 h cap;
  - a likely duplicate: two *taken* logs within **30 minutes**, for any schedule type.
- **Future times are clamped to now** when logging or editing.
- **Paused periods** are stored as ranges, so slots inside a pause are neither alarmed nor counted as missed.

## Adherence

- "On time" means within the grace window (default ±60 min) of the scheduled time. Early doses count too.
- The rate is `onTime / (onTime + late + skipped + missed)`. Skips count against on-time, since a skipped dose wasn't taken. The pending dose isn't counted until it's resolved.
- Interval meds are judged against when each dose was due. Because interval schedules wait for you, they have no "missed" doses, only late ones.
- PRN meds are excluded from adherence and listed separately; their doses still appear in History and the report.
- **Streak:** consecutive days, ending today, on which every scheduled dose was on time. Days with nothing scheduled are neutral. Today only breaks the streak once a dose today is late, skipped or missed.

## Google Calendar

- **Scope:** `calendar.app.created` (first preference). Google's scope documentation (checked during the build) confirms it allows creating secondary calendars and full event management *on calendars the app created*.
  - Doseline creates and owns a dedicated **Medications** calendar, so no calendar picker is needed. Settings shows the calendar instead of a picker, because the scope can't see other calendars by design.
  - `openid email` are added only to display the connected account.
- **OAuth:** installed-app flow with PKCE (S256) and `state`. The loopback server listens on `127.0.0.1` with an ephemeral port and path `/oauth2callback`. Sign-in opens in the system browser via `shell.openExternal`, uses `access_type=offline` and `prompt=consent` (so a refresh token is always returned), and times out after 5 minutes. Granted scopes are verified, since the user can untick the calendar checkbox.
- **Secrets:** the client ID/secret and tokens are stored in separate files encrypted with `safeStorage` (DPAPI). The logger redacts any key matching token, secret, code or verifier.
- **Reconcile model:** sync is expressed as idempotent per-medication jobs (`<medId>` and `refill:<medId>`) persisted in SQLite.
  - Each run computes the desired event from local state, finds existing events via `privateExtendedProperty` (`app=doseline`, `medicationId`, `kind`), then patches one, deletes extras, inserts if missing, or deletes all if none is desired.
  - This makes undo, edits, offline replays and crash recovery converge to exactly one event, with no duplicates.
  - Offline changes collapse into the latest state.
- **Backoff:** 30 s × 2ⁿ⁻¹, capped at 30 min, ±20% jitter. Offline errors pause the run. Coming back online, or **Sync now**, retries immediately. A job is dropped after 5 consecutive 4xx client errors.
- **Revoked or expired grants** (`invalid_grant`, 401 after a refresh) put sync into a *reconnect* state. Jobs stay queued, Settings shows **Reconnect**, and nothing crashes.
- **Deleted calendar** (404, or 403 `forbidden` on our calendar id): Doseline recreates it and resyncs.
- **Event shape:**
  - Title `💊 Name Strength`. The description holds dose, instructions and notes.
  - It's a 15-minute event marked *free* (`transparency: transparent`).
  - Popup reminders mirror the alarm offsets plus a reminder at the due time. Google allows at most 5; the closest ones are kept.
  - `colorId` is the nearest Google event color by CIE76 distance in Lab space.
- **Refill events** are all-day events created when stock first drops to the alert level, and they keep their original date rather than moving daily. Opt in per med.

## Alarms and system integration

- **Defaults:** reminders 30 and 15 minutes before, plus one at the due time. The offsets are editable globally and per medication. They also drive calendar popups.
- **The plan is recomputed from scratch** on startup, on any data change, on `powerMonitor` `resume` and `unlock-screen`, on a time-zone change, and on clock jumps. Timers are never trusted across sleep.
  - The engine never sleeps more than an hour.
  - A 30-second heartbeat detects wall-clock jumps.
  - A timer firing more than 2 minutes late is treated as a wake from sleep.
- **Time zone changes:** Node in the main process caches the zone, but Chromium's renderer tracks OS zone changes. The renderer therefore reports `Intl…timeZone` to main every minute and on focus, and main recomputes alarms and re-syncs events.
- **Missed while away:** doses that came due between the last heartbeat and now, minus a 2-minute tolerance, are collected into one notification plus a dismissible banner on Today. Stale alarms are never replayed in a burst. Fired alarm ids are persisted, so a restart never re-fires.
- **Presentation:** each alarm shows a native toast (silent when the app's own sound is on, to avoid a double chime) and an always-on-top alarm window (`screen-saver` level, shown *inactive* so it doesn't steal keystrokes). Multiple alarms stack with 1/N paging. The chime repeats up to 3 times, 25 s apart, until answered or muted.
- **AppUserModelId** is `com.doseline.app`, matching the NSIS shortcut, so toasts show the Doseline name and icon. Toasts from the **portable** exe may show a generic name because no Start-menu shortcut registers the AUMID. This is a Windows limitation.
- **Window chrome:** `titleBarStyle: 'hidden'` with `titleBarOverlay` gives a frameless look with a custom title bar while keeping native caption buttons and Windows 11 Snap Layouts. Mica is used on Windows 11 22H2+ (build ≥ 22621); elsewhere it falls back to solid theme colors.
- **Close to tray:** closing the window hides it, and the first time a toast explains that. Quit from the tray menu.
- **Launch at login** is on by default via `setLoginItemSettings` with `--hidden`, so the app starts in the tray. It applies only to packaged builds; the portable exe registers its own path.
- **Global quick-log hotkey:** Ctrl+Alt+M by default. If the accelerator can't be registered, the previous one is restored with an error toast.

## Security

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`.
- The preload exposes one typed object (`window.doseline`), and every IPC argument is validated in main.
- CSP meta: `default-src 'self'; script-src 'self'`.
- `webRequest` cancels any non-`file:` request from renderer processes. Main-process `net.fetch` calls to Google are unaffected.
- Navigation and `window.open` are denied. External links are allow-listed to Google domains and open in the system browser. Permission requests are denied.
- DevTools are disabled in packaged builds.
- Logs: rotating `doseline.log` (1 MB × 3) in `%APPDATA%\Doseline\logs`. Console echo happens in development only. Medication names and tokens are never logged; only ids and error messages are.

## UX details

- **Undo** lasts 10 s, plus a 5 s grace for a click landing at the end. It covers only the last log action, which matches the toast. Undo deletes the log, restores the exact inventory delta, and the reconcile loop restores calendar and alarms.
- **Deleting a medication deletes its history**, behind a confirm that suggests *Pause* instead.
- **Backups** include medications, history, settings, and the Google calendar id. They never include credentials. Restoring re-reconciles calendar events instead of duplicating them.
- **The PDF report** renders in a hidden window with the same React components and is printed with `printToPDF`. It uses Letter for en-US and A4 elsewhere.
- **Hidden developer tools:** click the version in **Settings → About** five times. That reveals *Fire test alarm* and *Create 2-minute test dose*, which creates a real medication due in 2 minutes with a 1-minute reminder, exercising alarms and calendar end-to-end.
- **Testing hooks** (environment variables, unset in normal use):
  - `DOSELINE_USER_DATA` runs Doseline against a separate data directory.
  - `DOSELINE_EXPORT_DIR` makes CSV/PDF/backup exports write straight to a folder instead of opening a Save dialog.

  Both were used for automated verification and screenshots without touching real data.

## Drug lookup (names and strengths)

No drug list is bundled. Names and strengths come live from NLM RxTerms, and strength commonness comes from the openFDA NDC directory. Both are fetched from the main process through the typed bridge, so the renderer CSP stays `connect-src 'self'`.

### What the APIs actually return (checked live on 2026-10-27)

- **RxTerms v3** (`clinicaltables.nlm.nih.gov/api/rxterms/v3/search`):
  - It returns `[total, names[], {STRENGTHS_AND_FORMS, RXCUIS, SXDG_RXCUI}, display[][]]`.
  - Matching is case-insensitive word-prefix, and several words are ANDed. `maxList` defaults to 7 (maximum 500). Doseline asks for 50 and ranks them client-side down to 12.
  - The service is free and needs no registration. The advised limit is 25 requests per second. The FAQ asks clients never to send PHI or PII, and Doseline sends only the typed text.
- **RxTerms doesn't spell out salts.** Metoprolol tartrate is **"Metoprolol (Oral Pill)"** and metoprolol succinate ER is **"Metoprolol XR (Oral Pill)"**. Each formulation is its own entry with its own RXCUIs, and Doseline never merges entries. (Lopressor and Toprol XR appear as their own brand entries.)
- **Brand detection:** RxTerms writes brand names entirely in capitals (`TOPROL XR`, `METROGEL`). Generics are mixed case, often Tall Man (`metFORMIN`). An entry whose name part has no lowercase letters is tagged **Brand**. Saved names are re-cased for readability (`metFORMIN` → `Metformin`, `TOPROL XR` → `Toprol XR`). The original display name is kept as `catalogName`.
- **SXDG_RXCUI** is sometimes the string `"NA"`. Only numeric codes are kept.
- **CORS:** both APIs send `Access-Control-Allow-Origin: *`. RxTerms adds nothing else; openFDA also sends `Access-Control-Allow-Credentials: true`. A future web build can call them straight from the browser with the same `RxTermsCatalog` and `OpenFdaStrengthRanker` (they take an injected `fetch`).

### openFDA query

Settled on one count request per selected drug:

```
https://api.fda.gov/drug/ndc.json
  ?search=openfda.rxcui:(<every RXCUI of the drug's RxTerms strengths>) AND finished:true
  &count=openfda.rxcui.exact&limit=1000
```

The count is the number of distinct finished NDC products per RxNorm clinical drug. RxTerms gives an RXCUI for each strength + form string, so the counts map back onto chips exactly, including combination products, since an RXCUI identifies the whole combination. Terms for other RXCUIs that co-listed products mention are ignored.

Approaches tried and rejected:

- `count=openfda.rxcui`: the server errors, because it is a text field; `.exact` is needed.
- `count=active_ingredients.strength` searched by `generic_name`: it works for single ingredients, after normalising `"50 mg/1"` (per unit) to `"50 mg"`. But for combination products it mixes every ingredient's strength into one histogram (the HCTZ in a metoprolol/HCTZ product counts as "25 mg"). It also includes bulk API listings like `"1 kg/kg"` unless `finished:true` is added. It is kept only as a fallback for single-ingredient drugs whose strengths have no RXCUIs; combinations and brands skip ranking instead.

Other behaviour:

- **No matches** comes back as HTTP 404 with `error.code = NOT_FOUND`, and is treated as an empty ranking.
- **No API key** is needed. The documented keyless limits are 240 requests per minute and 1,000 per day per IP. An optional key can be entered in Settings → Drug lookup; it is stored with DPAPI and only appended as `api_key`.

### Ranking and labels

- **Suggestion tiers:**
  1. already in Doseline (matched by `catalogName`, or by name for unlinked meds);
  2. first word starts with the query;
  3. any word starts with it;
  4. everything else.
- **Within a tier,** strict shortest-first surfaced rare short brands (METROGEL, METHITEST, METROCREAM) above Metoprolol XR, Methotrexate and Metronidazole for "met". Within a tier Doseline therefore orders by NLM's own result position plus 0.5 × name length, so shorter names still win at similar relevance. NLM's order is clearly relevance and usage weighted: metformin comes first.
- **"Common"** marks up to 3 chips per form, never more than half the group. A chip must have at least 25% of the group's top count and more than the group's least-listed strength. Ties carry no signal: all four Metoprolol XR capsule strengths list 8 products, so none is marked. The footnote under the chips says it reflects listed products (availability), not prescribing. Nothing is labelled "most prescribed".
- **Folding:** RxTerms lists some strengths several times that differ only by package size (`Pen Injector 3 ml` vs `1.5 ml`) or by application number (three `90 mcg/puff NDA… MDI`). These fold into one chip whose tooltip lists the variants. Their product counts are summed, and the first RXCUI is stored.

### Strength parser

`parseStrength` reads `<amounts> <unit> <form>`. Amounts can be `25`, `5-325` or `1,000-62.5`. Units can be `mg`, `mg/5ml`, `mcg/puff`, `unt/ml` or `var units`. Package sizes and NDA/ANDA/BLA numbers are stripped into `details`.

The form is shown two ways:

- **Group header:** a readable form, e.g. `24 HR XR Tab` → "24-hour extended-release tablet".
- **Form field:** a short label, e.g. "extended-release tablet".

A chip also suggests a dose unit (tablet, ml, puff, units, patch) and an icon. Each is applied only if the user hasn't set one. Strings without a leading amount (`mixed Pack` kits) stay selectable as raw chips. Every string in the recorded fixtures (192 of them) parses without error.

### Name field and linking

- Lookup starts at 2 characters, debounced by 200 ms.
- Each keystroke aborts the in-flight request. The abort crosses IPC as `drug:cancel <id>`, and the main process aborts its `net.fetch`.
- `DrugSearchController` applies a response only if it belongs to the latest query, so a late "met" can't replace "meto".
- **Nothing is pre-highlighted,** so Enter on a typed name keeps the typed name. ↓ opens or moves the selection, and Enter or Tab picks. Esc closes the list, keeps the text, and doesn't close the drawer.
- Selecting links the medication: `rxcui` (SXDG, drug + route), `catalogName`, `catalogSource = 'rxterms'`. A chip adds `strengthRxcui`. Any edit to the name unlinks it and hides the chips; the strength fields the user already filled are kept. Retyping the same name doesn't silently relink.
- **Offline:** an inline "Suggestions unavailable offline" note, with no dialog. The field stays a plain input.
- **Editing an unlinked medication:** Doseline searches its name once. If an entry's name matches exactly, it offers "Link to …" with one button per route group, plus "Not now".

### Data and caching

- **Migration 2** adds `rxcui`, `catalog_name` and `catalog_source` columns to `medications`. They mirror the JSON blob, which stays the source of truth, and old rows read as null. It also adds a `drug_cache` table.
- **Searches** use an in-memory LRU (200 queries) for the session. Typed text is never persisted.
- **Strengths and rankings of selected drugs** are cached in SQLite with a 30-day TTL. When a refresh fails, expired entries are still served, so a saved medication's chips work offline indefinitely.
- **"Yours" chips** come from current medications linked to the same catalog entry, plus a remembered list (`kv: drugs.used`, up to 12 per drug). Custom strengths therefore survive edits and deletion, and appear as first-class chips in a "Your entries" group.
- **Settings → Online drug lookup** is on by default. When it's off, the main process refuses every lookup (`disabled`) and the UI renders plain inputs. Requests are sent with `credentials: 'omit'` and carry no account, cookie or user identifier. Queries and drug names are never logged; only the error code is.

## Overdue escalation

A second alert level for doses that stay unlogged. It is purely local: Google Calendar is never touched.

### Model: derived, not timed

- **Inputs:** each scheduled medication's single pending dose (from `computeNextDue`, i.e. from the logs), the settings, and one persisted `EscalationRecord` per escalated dose. A record holds the medication, due time, escalated-at, last fired, repeats and snooze-until, in the `escalations` table added by migration 3.
- **Fire times are recomputed on every recompute:**
  - first alarm = due + threshold;
  - each repeat = max(last fired + repeat interval, snooze-until).

  Restarts, sleep and wake, clock jumps and time-zone changes therefore land on the right state.
- **"Resolved" is never stored as truth.** A dose stops escalating when logs say it is no longer pending, so undo naturally resumes the escalation on its old cadence. The record's `resolution` field (taken / skipped / missed) is bookkeeping for history only.
- **It shares `AlarmEngine`'s timer, recompute chain and sleep/clock-jump detection** instead of running a second scheduler.

### Rules

- **Fixed schedules:** escalation ends when the next slot comes due. That is the existing rule that an unlogged slot stays pending until the next one, after which adherence counts it as missed. No fire is planned at or after the next slot, and only one pending dose exists per medication, so two escalations for one medication can't happen.
- **Interval schedules** have no next slot and escalate until the dose is logged.
- **PRN never escalates;** neither do paused medications.
- **Threshold:** the global default is 30 min; Custom allows 5–360 min. The per-medication override is stored as `escalationMinutes`: `null` means use the default, `0` means Off.
- **Repeat interval:** 5–60 min, default 15. Both values are clamped wherever settings are merged.
- **Snooze** offers 15, 30 or 60 min. It sets snooze-until, so it defers only the next repeat. It never touches escalated-at or the repeat count, and a snooze shorter than the cadence never pulls a repeat earlier.

### Consolidation and sound

- When an escalation alarm is due, every other one due within 60 s is pulled into the same cycle. That gives one window update, one sound and at most one notification. Medications pulled forward together then stay in step.
- The escalation sound plays **once per cycle**; the next cycle is the repeat. Normal reminders still chime up to 3 times.
- The sound is chosen separately (Urgent by default, or Siren or Bell). It uses the alarm volume and the master "Play a sound with alarms" switch, so one switch still silences everything.
- **Quiet hours** (off by default; a wall-clock range that may cross midnight) mute only escalation sound. The window and taskbar flash still happen. Each cycle checks quiet hours at fire time, so the first cycle after they end rings normally.
- **Notifications:** a silent Windows toast (the window supplies the sound) on a cycle that contains a first escalation, and on repeats only when the alarm window isn't focused.
- **Taskbar flash:** the alarm window shows inactive and flashes its taskbar button. Focusing the window or acting on any row acknowledges it and stops the flash.

### Sleep, restart and backlog

- **On launch or resume after a gap** (the existing > 2 min heartbeat-gap detection), escalation alarms whose fire time passed more than 2 min ago are **folded** into "Missed while you were away", which gains an *Escalated* tag. No alarm fires for them. A dose whose threshold was crossed while away gets `escalatedAt` = that crossing time. The repeat cadence restarts from now, so no catch-up burst ever happens.
- **A stale fire time without a gap** (e.g. lowering the threshold while a dose is already 2 h overdue) fires **one** cycle immediately, not a series.
- **DST:** thresholds and repeats are absolute durations from the due instant, so a repeat is 15 real minutes even through the fall-back hour. Due instants follow the existing wall-clock rules: a 02:30 dose on spring-forward day moves to 03:30.

### History and adherence

- When a dose is logged, `DoseService` stamps the log with `escalatedAt` and `escalationRepeats` from the matching record. History shows an *Escalated ×N* pill, and the CSV gains `escalated_at` and `escalation_repeats` columns.
- **Adherence:** a dose taken at or after its `escalatedAt` is **late**, even inside the on-time grace window. "Took it at…" backdated to before the escalation (the picker defaults to the scheduled time) is judged by the normal grace rule. That is the user telling us when they really took it.

### Presentation

- **Alarm window:** while any escalation is active, it switches from the single-card pager to one consolidated list. Each row shows the overdue medication with a live "Overdue by 1 h 15 m" counter and its own Take now / Took it at… / Skip / Snooze. Any normal reminders show below as plain rows. The window measures its content and resizes, anchored bottom-right, up to 720 px tall, after which the list scrolls. Its natural height includes whatever the list is hiding, so the window can't shrink-wrap its own scroll cap; the first build did exactly that and collapsed to the 220 px minimum. In escalated mode it is 480 px wide (420 otherwise), so each row's four actions fit on one line.
- **Toasts can't grow,** so with more than two overdue medications the notification names two and says "and N more".
- **The design** reuses the danger token for border, glow, eyebrow and counter, and keeps the existing card surfaces, radii and buttons in both themes.
- **The X button hides the window until the next repeat.** It doesn't stop escalation; only Take, Took it at, Skip or Snooze affect it.
- **Today:** an escalated dose gets an *Escalated* pill (solid danger), a danger-tinted hero card with an "Overdue by …" note, or a danger-accented row in the list.
- **Settings → Overdue alerts:** threshold, repeat interval, overdue sound and quiet hours. The medication editor has an *Overdue alert* picker: Default / 30 min / 1 h / 2 h / Custom / Off.
- **Developer tools** (Settings → About, click the version 5×) add two things:
  - real test doses (1, 2 or 4) due in 1 minute, used with Custom = 5 min to verify end to end;
  - a fake escalated window preview, single or consolidated.

## Open-source release

- **Public from the first commit,** so the audit ran before anything was committed.
  - All user data (database, logs, encrypted credentials, drug cache) is written only under `app.getPath('userData')`, and exports go wherever the user picks in a Save dialog.
  - `.gitignore` excludes databases, logs, credentials, env files, build output and every installer format.
  - gitleaks scanned both the working tree and the full history.
- **History is honest.** The project was built before it was under version control, so it is imported as one baseline commit. `CHANGELOG.md` is committed separately and labels its 1.0.0 entries as a reconstruction without dates. No intermediate commits were fabricated or backdated.
- **Commits use the GitHub no-reply address,** set as a repo-local git identity before the first commit.
- **Screenshots come only from the fictional demo dataset:** Developer tools → **Load demo data** (`src/core/demo.ts`). It is deterministic per day, has about six months of history so Adherence and History look realistic, and is refused while Google is connected so fake medications can't reach a real calendar.
- **Releases are built by CI only.** `.github/workflows/ci.yml` runs typecheck and tests on every push and pull request, using `windows-latest` and Node 24 to match development (npm 11 honours `allowScripts`). On a `v*` tag it checks the tag matches `package.json`, then builds the unsigned NSIS installer and portable exe with no secrets. The release notes come from the version's CHANGELOG section (`scripts/changelog-section.mjs`). Installers are never committed.
- **Line endings:** `.gitattributes` stores text as LF, keeps Windows scripts as CRLF, marks binaries explicitly, and keeps the recorded API fixtures byte-exact.
