# Working on Doseline

Standing instructions for anyone (human or AI assistant) changing this repository.

**This repository is public.** Everything committed, every commit message and every release note is visible to
anyone. Doseline handles medication data, so treat privacy as a hard requirement.

## Project basics

- Windows desktop app: Electron + React + TypeScript (electron-vite), SQLite via better-sqlite3, packaged with electron-builder.
- `src/core` is pure TypeScript with no Electron or Node imports (`npm run typecheck` enforces it). Platform code lives behind the interfaces in `src/core/ports.ts`.
- User data lives only in `app.getPath('userData')` (`%APPDATA%\Doseline`), never in the project directory.
- Design decisions are recorded in `DECISIONS.md`; add to it when you make a non-obvious choice.

## Commit discipline

- **Commit after each coherent change**, not in one large batch at the end.
- Use **Conventional Commit** messages: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:` (also `ci:`, `build:`, `perf:` where they fit). Use an optional scope, e.g. `fix(alarms): ...`, and keep the summary in the imperative and under about 72 characters.
- **Run the tests before committing:** `npm run typecheck` and `npm test`. Don't commit with failing tests. For drug-lookup changes, also run `npm run test:live` when online.
- **Update `CHANGELOG.md` under `## [Unreleased]`** for every user-visible change (Added / Changed / Fixed / Removed / Security), following Keep a Changelog.
- **Push at the end of every task:** `git push`.
- Keep GitHub-facing text (docs, commit messages, release notes, issues) professional. No expressive emoji; use them only as supplemental graphics or where they add clarity.

## Never commit

- User data: databases (`*.db`, `*.sqlite`), backups, CSV/PDF exports, logs.
- Credentials: OAuth client IDs or secrets, tokens, API keys, `.env` files, certificates.
- Screenshots of real data. Screenshots in `docs/screenshots` must use the fictional demo dataset only (developer tools → **Load demo data**, with a throwaway profile via `DOSELINE_USER_DATA`).
- Build output: `out/`, `release/`, installers, exes, blockmaps. These are release assets only.
- Personal information: real names, email addresses, or absolute paths containing a username.

`.gitignore` covers most of these; check `git status` before committing anyway. Before pushing a change that touches
docs or fixtures, a secrets scan is cheap: `gitleaks git --redact`.

## Releasing

1. Bump `version` in `package.json` (and `package-lock.json`, e.g. `npm version 1.1.0 --no-git-tag-version`).
2. In `CHANGELOG.md`, move the `## [Unreleased]` entries under a new `## [x.y.z] - YYYY-MM-DD` heading, leave an empty `## [Unreleased]` section above it, and update the comparison links at the bottom.
3. Commit: `chore(release): vx.y.z`.
4. Tag and push: `git tag vx.y.z`, then `git push && git push origin vx.y.z`.
5. The **Release** workflow builds on `windows-latest` and attaches the NSIS installer and the portable exe to the GitHub Release, with notes taken from that version's CHANGELOG section. Never build or upload installers by hand, and never commit them.
