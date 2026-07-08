# Obsidian Nextcloud Deck

[![Obsidian](https://img.shields.io/badge/Obsidian-1.5%2B-7c3aed?logo=obsidian&logoColor=white)](https://obsidian.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-f1c40f.svg)](LICENSE)

Obsidian Nextcloud Deck is a Kanban board plugin for Obsidian, with every card stored as a real Markdown note in your vault. Optional Nextcloud Deck sync (in development) keeps your boards consistent across Obsidian desktop, Obsidian mobile, Nextcloud Web, and the official Nextcloud Deck apps.

Forked from [Task Deck](https://github.com/ismailivanov/task-deck) and refocused on Nextcloud as the sync backend, so you keep full ownership of your data on your own server.

## Features

- Kanban lists with drag-and-drop ordering
- Unlimited boards
- Each board stores cards as Markdown notes in its own board folder
- Inline card creation and renaming
- Global colored labels
- Start and due dates with a compact date picker
- Checklist progress on cards
- Card details rendered as Markdown
- Picks up Markdown cards you create outside the board
- **(coming)** Optional Nextcloud Deck sync via App Password / Login Flow v2

## Usage

- Run `Open board` from the command palette.
- Create a board with the name you want to use.
- Switch between boards from the board picker or the boards screen.
- Use `Add list` to create a new list.
- Use `Add card` under a list, then type the card name inline.
- Click a card to edit labels, details, dates, and checklist items.
- Use `Open note` when you want to work with the card as a normal Markdown file.
- Drag cards between lists and drag list headers to reorder columns.

If you create a Markdown card directly inside a board folder, Obsidian Nextcloud Deck will pick it up and show it on that board.

## Nextcloud sync (roadmap)

Sync uses the [Nextcloud Deck REST API](https://deck.readthedocs.io/en/latest/API/). Authentication is via **Login Flow v2** (recommended) or a manually generated **App Password**. All API traffic goes through Obsidian's built-in `requestUrl`, so no browser CORS restrictions apply and no third-party proxy is needed.

Roadmap:

1. **M1** — Sign in, encrypted credential storage, connection test.
2. **M2** — Read-only pull of remote boards, stacks, and cards.
3. **M3** — Two-way incremental sync with field-level conflict resolution.
4. **M4** — Attachment sync using Deck's native `deck_file` / `file` attachments (no S3, entirely Nextcloud-hosted).
5. **M5** — Mobile validation, diagnostics, and docs.

Nextcloud Deck ≥ 1.9 and Nextcloud ≥ 25 are recommended.

## Install

Download the release files and place them here:

```text
Your Vault/.obsidian/plugins/obsidian-nextcloud-deck/
```

Then enable **Obsidian Nextcloud Deck** from Obsidian's *Community plugins* settings.

## Development

Source files live in `src/`. After changing them, run:

```bash
node build.js
```

Obsidian loads the generated `main.js` file.

## Credits

- Upstream Kanban implementation by [Ismail Ivanov (Task Deck)](https://github.com/ismailivanov/task-deck) — MIT licensed.
- Nextcloud Deck backend by the Nextcloud community — [nextcloud/deck](https://github.com/nextcloud/deck).

## License

[MIT](LICENSE)
