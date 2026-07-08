const {
  remoteBoardToLocal,
  reconcileBoardStructure,
  mergeRemoteCardOntoLocal,
} = require("./sync-mapper");
const { DeckApiError } = require("./deck-client");

// Coordinates read-only pulls from Nextcloud Deck. Writes (M3) will land here
// as well so the plugin only needs one entry point (`runSync`) regardless of
// direction.
//
// The manager is stateful only in memory: `this.status` tracks the last run,
// while persistent bindings (localBoardId ↔ remoteBoardId) live in
// `plugin.data.nextcloud.boardBindings` so a restart still knows which local
// board mirrors which remote one.

const STATUS_IDLE = "idle";
const STATUS_RUNNING = "running";
const STATUS_ERROR = "error";
const STATUS_OK = "ok";

class SyncManager {
  constructor(plugin) {
    this.plugin = plugin;
    this.status = { state: STATUS_IDLE, at: 0, message: "" };
    this.running = null; // in-flight promise so concurrent calls coalesce
  }

  getStatus() { return this.status; }

  /**
   * Kick off (or join) a pull. Always resolves — errors are surfaced through
   * `this.status.state === "error"` so callers can render a badge instead of
   * having to catch.
   */
  async runPull({ manual = false } = {}) {
    if (this.running) return this.running;
    this.running = this.pullOnce({ manual }).finally(() => { this.running = null; });
    return this.running;
  }

  async pullOnce({ manual }) {
    const client = await this.plugin.getDeckClient();
    if (!client) {
      this.status = { state: STATUS_ERROR, at: Date.now(), message: "Nextcloud is not connected." };
      return this.status;
    }
    this.status = { state: STATUS_RUNNING, at: Date.now(), message: manual ? "Manual pull…" : "Pulling from Nextcloud…" };

    try {
      const { data: remoteBoards } = await client.getBoards();
      if (!Array.isArray(remoteBoards)) throw new Error("Unexpected boards response.");

      const bindings = this.getBindings();
      const boardMap = new Map(this.plugin.data.boards.map((board) => [board.id, board]));
      const boundLocalIds = new Set();

      for (const remoteBoard of remoteBoards) {
        const localBoardId = this.findOrBindLocalBoard(remoteBoard, bindings, boardMap);
        boundLocalIds.add(localBoardId);
        await this.pullBoard(client, remoteBoard, localBoardId);
      }

      this.plugin.data.nextcloud.boardBindings = bindings;
      this.plugin.data.nextcloud.lastSyncAt = Date.now();
      await this.plugin.savePluginData();
      this.plugin.refreshViews();
      this.status = {
        state: STATUS_OK,
        at: Date.now(),
        message: `Pulled ${remoteBoards.length} board${remoteBoards.length === 1 ? "" : "s"}.`,
      };
    } catch (error) {
      const message = error instanceof DeckApiError
        ? `Deck API ${error.status || "error"}: ${error.message}`
        : (error && error.message) || String(error);
      this.status = { state: STATUS_ERROR, at: Date.now(), message };
      this.plugin.pushSyncLog({ event: "pull-failed", message });
    }
    return this.status;
  }

  // ---- Board-level pull ---------------------------------------------------

  async pullBoard(client, remoteBoard, localBoardId) {
    const localBoard = this.plugin.data.boards.find((board) => board.id === localBoardId);
    if (!localBoard) {
      // Freshly minted binding — build the board from scratch.
      const { data: stacks } = await client.getStacks(remoteBoard.id);
      const created = remoteBoardToLocal(remoteBoard, stacks || [], { boardId: localBoardId, folderPath: this.suggestFolder(remoteBoard) });
      this.plugin.data.boards.push(created);
      await this.pullCards(client, remoteBoard.id, created, stacks || []);
      return;
    }

    // Existing board: only refresh stack structure + cards.
    const { data: stacks } = await client.getStacks(remoteBoard.id);
    const reconciled = reconcileBoardStructure(localBoard, remoteBoard, stacks || []);
    // Splice-replace to preserve reference identity of the boards array
    const index = this.plugin.data.boards.indexOf(localBoard);
    this.plugin.data.boards[index] = reconciled;
    await this.pullCards(client, remoteBoard.id, reconciled, stacks || []);
  }

  async pullCards(client, remoteBoardId, localBoard, remoteStacks) {
    // Deck's `getStacks` already returns cards as an embedded array on each
    // stack; we prefer that over N follow-up requests. Fall back to a per-card
    // GET only when the embedded array is missing (older Deck versions).
    const cardMap = new Map(); // remoteCardId -> existing local card
    Object.values(this.plugin.data.cards).forEach((card) => {
      if (card.boardId === localBoard.id && card.remoteId != null) cardMap.set(card.remoteId, card);
    });

    // Reset card lists — we rebuild them from the remote order.
    localBoard.lists.forEach((list) => { list.cardIds = []; });

    for (const stack of remoteStacks) {
      const localList = localBoard.lists.find((list) => list.remoteId === stack.id);
      if (!localList) continue;

      const cards = Array.isArray(stack.cards) && stack.cards.length
        ? stack.cards
        : await this.fallbackFetchStackCards(client, remoteBoardId, stack.id);

      const sorted = cards.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      for (const remoteCard of sorted) {
        const existing = cardMap.get(remoteCard.id);
        const merged = mergeRemoteCardOntoLocal(existing, remoteCard, { boardId: localBoard.id, listId: localList.id });
        const cardId = existing ? existing.id : merged.id;
        merged.id = cardId;
        merged.boardId = localBoard.id;
        merged.listId = localList.id;
        this.plugin.data.cards[cardId] = merged;
        localList.cardIds.push(cardId);
        cardMap.delete(remoteCard.id);
      }
    }

    // Cards left in `cardMap` were on Nextcloud last time but not now. For M2
    // (read-only) we remove them locally — this matches the "Nextcloud is the
    // source of truth for tracked cards" model. Cards without a remoteId are
    // untouched.
    cardMap.forEach((orphan) => {
      if (orphan.boardId === localBoard.id) {
        delete this.plugin.data.cards[orphan.id];
      }
    });
  }

  async fallbackFetchStackCards(client, boardId, stackId) {
    // Not all Deck versions embed cards; if we ever hit that, iterate what the
    // stack payload gave us (may still be empty), and let the sync log surface
    // the shortfall. A real per-card fetch would need a card index which the
    // Deck API doesn't expose without an extra call chain; keep it minimal.
    this.plugin.pushSyncLog({ event: "stack-embed-missing", boardId, stackId });
    return [];
  }

  // ---- Bindings -----------------------------------------------------------

  getBindings() {
    const bindings = this.plugin.data.nextcloud.boardBindings || {};
    return typeof bindings === "object" ? { ...bindings } : {};
  }

  findOrBindLocalBoard(remoteBoard, bindings, boardMap) {
    for (const [localId, remoteId] of Object.entries(bindings)) {
      if (Number(remoteId) === Number(remoteBoard.id) && boardMap.get(localId)) return localId;
    }
    // Try to reuse an existing local board with the same name (helpful when
    // the user set both sides up manually before signing in).
    const nameMatch = this.plugin.data.boards.find(
      (board) => !bindings[board.id] && board.name && board.name.trim() === String(remoteBoard.title || "").trim(),
    );
    if (nameMatch) {
      bindings[nameMatch.id] = remoteBoard.id;
      return nameMatch.id;
    }
    // Otherwise reserve a fresh local id — the board itself is materialised
    // by `pullBoard` below.
    const created = `board-${remoteBoard.id}`;
    bindings[created] = remoteBoard.id;
    return created;
  }

  suggestFolder(remoteBoard) {
    // Simple, deterministic folder placement: Nextcloud Deck/<title>. The user
    // can rename the folder afterwards; the binding table keeps the mapping.
    const title = String(remoteBoard.title || "Board").replace(/[\\/:*?"<>|]/g, " ").trim() || "Board";
    return `Nextcloud Deck/${title}`;
  }
}

module.exports = {
  SyncManager,
  STATUS_IDLE,
  STATUS_RUNNING,
  STATUS_ERROR,
  STATUS_OK,
};