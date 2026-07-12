# AGENTS.md — NextDeck

Instructions for AI agents (Claude, Codex, Trae, Cursor, …) working on this repository. Read this file first before making any change; it captures decisions the git log alone won't teach you.

## 1. What this repo is

**NextDeck** — an Obsidian plugin that stores every kanban card as a real Markdown note in the vault, with optional two-way sync against a self-hosted [Nextcloud Deck](https://github.com/nextcloud/deck) instance.

- Manifest id (never change): `nextdeck`
- Manifest display name: `NextDeck`
- Entry point: `src/plugin.js` → bundled to `main.js` via `build.js`
- Language: Vanilla JS (CommonJS), no TypeScript, no framework
- Target: Obsidian ≥ 1.5.0, desktop + mobile
- Backend: Nextcloud Deck REST + OCS + WebDAV

## 2. Build / test / dev loop

```bash
# Unit tests — MUST pass before every commit that touches src/
node scripts/test-sync-units.js

# Build main.js from src/
node build.js

# Sanity-check the bundle actually parses
node --check main.js

# Local end-to-end without a real Nextcloud (optional)
node scripts/mock-nextcloud.js
```

No `npm install`, no `package.json`. The bundler in `build.js` is a hand-rolled ~70-line CommonJS collector — read it before "improving" it.

## 3. Release flow

Every user-facing change ships as a GitHub release. **This is the ONLY distribution channel** — Obsidian's Community Plugins updater pulls from GitHub releases directly.

### Standard release checklist

```bash
# 1. Bump version in manifest.json (semver, NO "v" prefix)
#    - Stable: 1.0.1 → 1.0.2 (patch) / 1.1.0 (minor) / 2.0.0 (major)
#    - Pre-release iteration: 1.1.0-pre.1 → 1.1.0-pre.2 (used during
#      active debugging with the user; NOT for public release)

# 2. Build + test
node scripts/test-sync-units.js && node build.js && node --check main.js

# 3. Commit (only manifest.json + main.js + touched src/*, keep noise low)
git add manifest.json main.js src/<changed-files>
git commit -m "<conventional-commit-message>"

# 4. Push
git push

# 5. Publish release with the three required assets
gh release create <version> main.js manifest.json styles.css \
  --repo onlymykazari/obsidian-nextcloud-deck \
  --title "<version> — <one-line-summary>" \
  --notes "<changelog>" \
  [--prerelease]   # add ONLY for -pre.x tags
```

### Version rules

- **Tag ≡ manifest version**, NO `v` prefix (`1.0.1`, not `v1.0.1`)
- **Strict semver**. Obsidian's updater rejects funky suffixes for stable channel
- **Pre-release naming**: `<next-stable>-pre.<n>` (e.g. `1.1.0-pre.3`). Always pass `--prerelease` to `gh release create`, otherwise BRAT and the official updater treat it as stable
- **Never** overwrite an existing release tag. Bump and re-release
- **Assets**: exactly three files — `main.js`, `manifest.json`, `styles.css`. Version inside the release-asset `manifest.json` MUST match the tag

### Two file copies of manifest.json

There are two `manifest.json`s that must stay in sync:

1. **Repo root** (`manifest.json`) — read by Obsidian's review bot from the default branch
2. **Release asset** — downloaded by users' updater

Since the release CLI takes the file from disk, the standard flow above (bump → commit → release) keeps them aligned automatically. **Do NOT** hand-edit them separately.

## 4. Code conventions

### Obsidian plugin compliance (audited by the community-plugins review bot)

- ❌ **Never** use `innerHTML` / `outerHTML` / `insertAdjacentHTML`. Use `createEl` / `createDiv` / `setText` / `empty()` from Obsidian's DOM helpers
- ❌ **Never** use raw `fetch` / `XMLHttpRequest` for external HTTP. Use `requestUrl` from `obsidian` (CORS-free, mobile-safe)
- ❌ **Never** use `eval` / `new Function()` / `document.write`
- ❌ **Never** `detachLeavesOfType` in `onunload` — the base Plugin class handles this and doing it manually closes user tabs on hot-reload
- ✅ **Always** wrap long-lived timers with `this.registerInterval(...)` so unload cleans them up
- ✅ **Console output**: `console.error` allowed for error paths only. **No `console.log`** in shipped code
- ✅ **Vault writes** go through `vault.modify` / `vault.create`. `vault.adapter.write` is a documented fallback only when the file index is stale — always guarded by an `exists` check and logged

### Project-specific patterns

- **`this.reconciling` flag** ([plugin.js](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/plugin.js)): set to `true` around any vault write that the plugin itself initiates during sync, so `queueCardFolderSync` skips its own writes. Forgetting this creates infinite loops (see §5 pitfall #1).
- **Sync log**: use `this.plugin.pushSyncLog({ event, ... })` for anything a diagnosing user might paste back. `this.plugin.debugLog(...)` for verbose internal state (only visible when Debug logging is on).
- **card.baseline**: three-way merges compare `local` vs `baseline` vs `remote`. Always call `snapshotBaseline(card)` after a successful push/pull. Missing baselines silently break conflict detection.
- **Encrypted App Password**: never log the plaintext. `plugin.debugLog` and `pushSyncLog` filter secrets — reuse them, don't roll your own logger.
- **Two data structures for labels**:
  - `board.labels` (`title, color, remoteId`) — per-board catalog, used for push reconciliation
  - `data.labels` (`name, color`) — global picker list, shown in `LabelPickerModal`
  - Sync must promote board→global (`mergeBoardLabelsIntoGlobal`) or the picker looks truncated.

### File organization

- `src/plugin.js` — main class, vault glue, commands
- `src/sync-manager.js` — pull/push/reap phases
- `src/sync-mapper.js` — pure functions: remote↔local card/board/list shape conversion
- `src/deck-client.js` — Nextcloud Deck REST + OCS + WebDAV wrappers
- `src/attachment-sync.js` — attachment discovery + upload/download queue
- `src/conflict.js` — baseline snapshots + field-level diff
- `src/modals.js` — every Modal (Card, Label, Date, Conflict, …)
- `src/board-view.js` — the kanban view itself
- `src/helpers.js` — tiny pure utilities; safe to import anywhere

## 5. Known pitfalls (things we've paid for)

### 1. Vault event feedback loop after pull

Symptom: lists (or cards, or boards) appear to duplicate after every sync.

Cause: pull rebuilds `localBoard.lists` with fresh uids, then `writeCardFile` writes a card, which fires a vault "modify" event, which triggers `queueCardFolderSync` after 250ms, which reads the **stale** board index file (never updated by pull), sees old uids that don't exist in memory, and re-creates them as empty structures.

Fix: at the end of pull, rewrite each affected board's index file inside `this.plugin.reconciling = true`. See `runNextcloudSync` in `src/sync-manager.js`.

**Rule of thumb**: any code path in sync that writes to the vault MUST be inside `reconciling = true` OR the resulting event handler must be idempotent against the current in-memory state.

### 2. Modal shows stale data while board view shows fresh data

Symptom: after a webui-side label change syncs down, the board tile shows the new label but opening the card modal shows the old one.

Cause: `CardModal.load()` calls `plugin.hydrateCardFromFile(card)` which reads labels/title/details from disk and **overwrites** the in-memory model. Sync used to update memory + `data.json` but never rewrote the `.md` files.

Fix: at the end of `pullCards`, call `plugin.writeCardFile(card)` for every card whose in-memory model was updated by remote. See the `dirtyForDisk` loop in `sync-manager.js`.

### 3. Labels revert on next sync

Symptom: user changes label on Deck webui, syncs from Obsidian while the card has some *other* unsynced local change (e.g. checklist edit). Labels revert to the pre-webui state.

Cause: `mergeRemoteCardOntoLocal` used a coarse `if (!localDirty)` guard that preserved ALL user-editable fields wholesale. Since the card was locally dirty on the checklist, labels were kept from local too — even though they hadn't been touched locally.

Fix: labels get their own three-way merge inside the dirty branch, using `signatureOfLabels(local)` vs `baseline.labelsSignature`. Same principle applies to any future field-level merge: don't inherit dirtiness from siblings.

### 4. Deck ≥ 1.3.0 uses `type=file` attachments (not `type=deck_file`)

Symptom: attachment downloads fail with 403 on `/index.php/apps/deck/api/v1.0/cards/{id}/attachment/{aid}`.

Cause: modern Deck stores attachments in the user's Nextcloud Files under `/Deck/`, not in Deck's private table. The old `attachment` endpoint only works for `type=deck_file` (Deck < 1.3.0).

Fix: `downloadAttachment` uses WebDAV: `GET /remote.php/dav/files/{username}/{extendedData.path}` with the App Password. The old endpoint stays as a fallback when `extendedData` is missing.

### 5. Deck REST list endpoint returns slim boards

Symptom: `pushCardLabels` gets a duplicate-title 400 when creating labels.

Cause: `getBoards()` returns board summaries **without** the labels array on some Nextcloud deployments. `pullBoard` treated them as authoritative, so `catalogByTitle` was empty, so every existing label looked "new" to push, hence the duplicate-title error.

Fix: `pullBoard` explicitly calls `getBoard(id)` after the list to hydrate `labels[]`. Also has a 400 recovery path that re-hydrates and matches by title.

### 6. `boardBindings` map vs `data.boards` divergence

Symptom: "phantom empty boards" multiplying in the tab bar.

Cause: an older code path (`restoreBoardsFromIndexFiles`) could mint a fresh `uid("board")` while `bindings` still referenced the previous id; both then coexisted in `data.boards`.

Fix: `pruneDuplicateBoards(boundLocalIds)` runs at the end of every pull. Keeps this-sync's bound boards, drops anything shadowing them by remoteId / folderPath / name.

## 6. Community Plugins submission

**As of late 2025, Obsidian moved plugin submission from the `obsidian-releases` PR flow to a self-service developer dashboard.** The old workflow (fork `obsidianmd/obsidian-releases`, add an entry to `community-plugins.json`, open a PR) is deprecated. Do **NOT** submit updates to `obsidian-releases`.

### New submission flow

1. Sign in to the [Obsidian Community developer portal](https://community.obsidian.md/account/plugins/new) with the same GitHub account that owns the plugin repo (permission scope granted at sign-in).
2. Open **Developer Dashboard → New plugin**, pick the repo (`onlymykazari/obsidian-nextcloud-deck`) and target release tag.
3. Fill in the plugin metadata that the form asks for (id / name / description come from the release-asset `manifest.json` — keep them clean before submitting).
4. Submit. The **Automated Review System** runs a code + safety scan and returns a verdict within minutes right in the dashboard.

Once the plugin is approved, new GitHub releases **still auto-distribute** — Obsidian's client pulls the latest tagged release from the linked repo. You never resubmit through the dashboard for a version bump; just publish a new release with matching `manifest.json`.

### Submission gotchas we already hit

- **`manifest.id` cannot start with `obsidian-`** — the form rejects it. Ours is `nextdeck`. If you rename, keep §9 (avoid renaming) in mind — but if you must, do it BEFORE the first submission, not after.
- The dashboard reads `manifest.json` from the selected release asset, not from the repo's default branch. Always double-check the release you're pointing at has the correct fields.
- Community Plugins currently ignores `authorUrl` — put a link in the plugin's Settings tab if you want it visible (we already do in the "Support" section).
- `fundingUrl` renders as a ❤️ icon on the plugin's card in the browser once accepted.

### Legacy note (kept for context, don't act on it)

`.trae/documents/community-plugin-submission.md` was written for the old PR-based flow and is retained for archival reasons only. Its PR template / reviewer-playbook sections are obsolete. If you touch it, add a header pointing here.

## 7. Debugging with users

The plugin has a Sync log ring buffer (last ~200 events). Users can:
- Open **Settings → NextDeck → Sync log → View sync log**
- Click **Copy diagnostics** → paste JSON

The diagnostics blob is redacted: server hostname only, no App Password, no card contents. When a user reports a bug, ask for this blob and drop it into the repo root as `log.json` — agents can then `Read` / `Grep` it.

Common event names to grep for:
- `sync.pull.boards` — start of a pull, has `localBoards` / `bindings` counts
- `sync.pull.card` — per-card pull, has `matched` / `title`
- `sync.push.*` — push variants
- `labels.*` — label reconciliation events
- `sync.prune-duplicate-boards` — phantom cleanup
- `sync.board-index-rewrite-failed` — index rewrite failure (rare)
- `attachment-download-failed` — attachment sync issue (often WebDAV path)
- `card-writeback-failed` — post-pull md flush failure

## 8. Style and tone for user-facing text

- English for all in-code strings and log events
- Chinese for conversation with the maintainer, unless requested otherwise (see the maintainer's chat preferences)
- Never use "Obsidian" or "Plugin" as a prefix in `manifest.name` — the review bot rejects it
- Sync log event names use `dot.separated.snake-case`, values use plain camelCase JSON

## 9. What NOT to do without discussion

- Renaming `manifest.id` — breaks all existing installs, users lose their data.json
- Adding a new external dependency — currently ZERO npm deps; keep it that way
- Removing the mock server or unit tests — they're the fastest way to iterate on sync logic without a Nextcloud instance
- Rewriting the bundler — the hand-rolled 70-line `build.js` is intentional, keeps auditability high
- Making network calls with anything other than `requestUrl` — will break iOS
- Force-pushing `main` or rewriting release history — releases are immutable public API
