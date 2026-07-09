const {
  remoteBoardToLocal,
  reconcileBoardStructure,
  mergeRemoteCardOntoLocal,
  localCardToDeckPatch,
  localCardToDeckCreate,
  remoteCardToLocal,
} = require("./sync-mapper");
const { DeckApiError } = require("./deck-client");
const { detectFieldConflicts, applyPolicy, snapshotBaseline } = require("./conflict");
const { ConflictModal } = require("./conflict-modal");
const { AttachmentSyncer } = require("./attachment-sync");

// Coordinates two-way sync with Nextcloud Deck.
//
// `runSync` executes three phases in a single "tick":
//   1. Pull:  fetch remote state, reconcile boards/stacks, merge remote cards
//             onto local ones (respecting `localDirty`).
//   2. Push:  for every dirty local card, compute a 3-way field diff against
//             the freshly pulled remote and either auto-apply or prompt the
//             user based on the configured conflict policy.
//   3. Reap:  drain the pending deletions queue.
//
// The manager coalesces concurrent triggers (`this.running`) so a manual
// button press during a scheduled tick is a no-op.

const STATUS_IDLE = "idle";
const STATUS_RUNNING = "running";
const STATUS_ERROR = "error";
const STATUS_OK = "ok";

class SyncManager {
  constructor(plugin) {
    this.plugin = plugin;
    this.status = { state: STATUS_IDLE, at: 0, message: "" };
    this.running = null;
    this.attachments = new AttachmentSyncer(plugin);
  }

  getStatus() { return this.status; }

  async runPull({ manual = false } = {}) {
    return this.runSync({ manual });
  }

  async runSync({ manual = false } = {}) {
    if (this.running) return this.running;
    this.running = this.syncOnce({ manual }).finally(() => { this.running = null; });
    return this.running;
  }

  async syncOnce({ manual }) {
    const client = await this.plugin.getDeckClient();
    if (!client) {
      this.status = { state: STATUS_ERROR, at: Date.now(), message: "Nextcloud is not connected." };
      return this.status;
    }
    this.status = { state: STATUS_RUNNING, at: Date.now(), message: manual ? "Syncing…" : "Background sync…" };

    try {
      // ---- Phase 1: Pull ----------------------------------------------------
      const { data: remoteBoards } = await client.getBoards();
      if (!Array.isArray(remoteBoards)) throw new Error("Unexpected boards response.");
      this.plugin.debugLog({ event: "sync.pull.boards", count: remoteBoards.length });

      const bindings = this.getBindings();
      const boardMap = new Map(this.plugin.data.boards.map((board) => [board.id, board]));
      const boundLocalIds = new Set();
      const boardContext = new Map(); // localBoardId -> { remoteBoard, remoteStacks }

      for (const remoteBoard of remoteBoards) {
        const localBoardId = this.findOrBindLocalBoard(remoteBoard, bindings, boardMap);
        boundLocalIds.add(localBoardId);
        const remoteStacks = await this.pullBoard(client, remoteBoard, localBoardId);
        boardContext.set(localBoardId, { remoteBoard, remoteStacks });
        this.plugin.debugLog({
          event: "sync.pull.board-done",
          boardId: localBoardId,
          remoteId: remoteBoard.id,
          stackCount: (remoteStacks || []).length,
        });
      }

      this.plugin.data.nextcloud.boardBindings = bindings;

      // ---- Phase 2: Push ---------------------------------------------------
      let pushed = 0;
      let conflicts = 0;
      for (const [localBoardId, ctx] of boardContext.entries()) {
        const localBoard = this.plugin.data.boards.find((b) => b.id === localBoardId);
        if (!localBoard) continue;
        const result = await this.pushBoard(client, localBoard, ctx);
        pushed += result.pushed;
        conflicts += result.conflicts;
      }

      // ---- Phase 3: Reap deletions ----------------------------------------
      const reaped = await this.reapDeletions(client);
      const attachmentsReaped = await this.attachments.reap(client);

      this.plugin.data.nextcloud.lastSyncAt = Date.now();
      await this.plugin.savePluginData();
      this.plugin.refreshViews();

      const parts = [`Pulled ${remoteBoards.length} board${remoteBoards.length === 1 ? "" : "s"}`];
      if (pushed) parts.push(`pushed ${pushed} card${pushed === 1 ? "" : "s"}`);
      if (reaped) parts.push(`deleted ${reaped} remote card${reaped === 1 ? "" : "s"}`);
      if (attachmentsReaped) parts.push(`removed ${attachmentsReaped} attachment${attachmentsReaped === 1 ? "" : "s"}`);
      if (conflicts) parts.push(`${conflicts} conflict${conflicts === 1 ? "" : "s"} skipped`);

      this.status = { state: STATUS_OK, at: Date.now(), message: `${parts.join(", ")}.` };
    } catch (error) {
      const message = error instanceof DeckApiError
        ? `Deck API ${error.status || "error"}: ${error.message}`
        : (error && error.message) || String(error);
      this.status = { state: STATUS_ERROR, at: Date.now(), message };
      this.plugin.pushSyncLog({ event: "sync-failed", message });
    }
    return this.status;
  }

  // ---- Pull ---------------------------------------------------------------

  async pullBoard(client, remoteBoard, localBoardId) {
    const localBoard = this.plugin.data.boards.find((board) => board.id === localBoardId);
    if (!localBoard) {
      const { data: stacks } = await client.getStacks(remoteBoard.id);
      const created = remoteBoardToLocal(remoteBoard, stacks || [], {
        boardId: localBoardId,
        folderPath: this.suggestFolder(remoteBoard),
      });
      this.plugin.data.boards.push(created);
      await this.pullCards(client, remoteBoard.id, created, stacks || []);
      return stacks || [];
    }

    const { data: stacks } = await client.getStacks(remoteBoard.id);
    const reconciled = reconcileBoardStructure(localBoard, remoteBoard, stacks || []);
    const index = this.plugin.data.boards.indexOf(localBoard);
    this.plugin.data.boards[index] = reconciled;
    await this.pullCards(client, remoteBoard.id, reconciled, stacks || []);
    return stacks || [];
  }

  async pullCards(client, remoteBoardId, localBoard, remoteStacks) {
    const cardMap = new Map();
    Object.values(this.plugin.data.cards).forEach((card) => {
      if (card.boardId === localBoard.id && card.remoteId != null) cardMap.set(card.remoteId, card);
    });

    // Track which lists were rebuilt so we can preserve the ordering of any
    // local-only (unsynced) cards on the same list.
    const rebuiltListIds = new Set();
    localBoard.lists.forEach((list) => { rebuiltListIds.add(list.id); list.cardIds = []; });

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

        // Fetch attachments for the card (only if feature-enabled).
        try {
          await this.attachments.pullCard(client, merged, localBoard, localList);
        } catch (error) {
          this.plugin.pushSyncLog({ event: "attachment-pull-failed", cardId, message: (error && error.message) || String(error) });
        }
      }
    }

    // Cards left in `cardMap` used to be on Nextcloud but no longer are; drop
    // them locally so Deck stays authoritative for tracked cards.
    cardMap.forEach((orphan) => {
      if (orphan.boardId === localBoard.id) delete this.plugin.data.cards[orphan.id];
    });

    // Fold local-only (never synced) cards back into their list. They stayed
    // in this.plugin.data.cards but were dropped from cardIds when we cleared
    // the lists above.
    Object.values(this.plugin.data.cards).forEach((card) => {
      if (card.boardId !== localBoard.id) return;
      if (card.remoteId != null) return;
      const list = localBoard.lists.find((l) => l.id === card.listId);
      if (list && !list.cardIds.includes(card.id)) list.cardIds.push(card.id);
    });
  }

  async fallbackFetchStackCards(client, boardId, stackId) {
    this.plugin.pushSyncLog({ event: "stack-embed-missing", boardId, stackId });
    return [];
  }

  // ---- Push ---------------------------------------------------------------

  async pushBoard(client, localBoard, { remoteBoard, remoteStacks }) {
    let pushed = 0;
    let conflicts = 0;
    const policy = this.plugin.data.nextcloud.conflictPolicy || "prompt";
    const remoteCardIndex = buildRemoteCardIndex(remoteStacks);

    // Snapshot the card list first — pushing mutates data.cards, and we don't
    // want to iterate while modifying.
    const dirtyCards = Object.values(this.plugin.data.cards)
      .filter((card) => card.boardId === localBoard.id && card.localDirty);

    for (const card of dirtyCards) {
      const listBinding = localBoard.lists.find((l) => l.id === card.listId);
      if (!listBinding || listBinding.remoteId == null) {
        // The card lives on a list that isn't bound to a remote stack yet.
        // Creating stacks on-demand is out of scope for M3; log and skip.
        this.plugin.pushSyncLog({ event: "push-skip-unbound-list", cardId: card.id });
        continue;
      }

      try {
        if (card.remoteId == null) {
          await this.pushCreate(client, localBoard, listBinding, card);
          pushed += 1;
          continue;
        }
        const remoteSnapshot = remoteCardIndex.get(card.remoteId);
        const outcome = await this.pushUpdate(client, localBoard, listBinding, card, remoteSnapshot, policy);
        if (outcome === "pushed") pushed += 1;
        else if (outcome === "conflict-skipped") conflicts += 1;
      } catch (error) {
        this.plugin.pushSyncLog({
          event: "push-failed",
          cardId: card.id,
          message: (error && error.message) || String(error),
        });
      }
    }

    return { pushed, conflicts };
  }

  async pushCreate(client, localBoard, list, card) {
    const payload = localCardToDeckCreate(card, { owner: this.plugin.data.nextcloud.username });
    this.plugin.debugLog({
      event: "sync.push.create.request",
      cardId: card.id,
      listRemoteId: list.remoteId,
      descriptionLen: (payload.description || "").length,
      hasChecklist: /(^|\n)#{1,6}\s*checklist/i.test(payload.description || ""),
      // First 200 chars of the payload description so we can see the exact
      // wire format going up to Deck. Debug-only, so users who don't enable
      // logging never leak card content.
      descriptionPreview: (payload.description || "").slice(0, 200),
      checklistLen: (card.checklist || []).length,
    });
    const { data: created } = await client.createCard(remoteBoard(localBoard), list.remoteId, payload);
    if (!created) throw new Error("Empty response from createCard");
    this.plugin.debugLog({ event: "sync.push.create.done", cardId: card.id, remoteId: created.id });
    this.applyRemoteToCard(card, created, localBoard.id, list.id);
    card.localDirty = false;
    await this.attachments.pushCard(client, card, localBoard, list).catch((error) => {
      this.plugin.pushSyncLog({ event: "attachment-push-failed", cardId: card.id, message: (error && error.message) || String(error) });
    });
  }

  async pushUpdate(client, localBoard, list, card, remoteSnapshot, policy) {
    // If the remote counterpart is gone, treat this as a create.
    if (!remoteSnapshot) {
      await this.pushCreate(client, localBoard, list, card);
      return "pushed";
    }

    const remoteView = remoteCardToLocal(remoteSnapshot, { boardId: localBoard.id, listId: list.id });
    const baseline = card.baseline || null;
    const diff = detectFieldConflicts(baseline, card, remoteView);

    // If the remote has autoApplied fields, fold them into the local card so
    // the push payload we send back is a full merge (Deck's PUT replaces the
    // whole record).
    Object.entries(diff.autoApplied).forEach(([field, value]) => {
      if (Object.prototype.hasOwnProperty.call(card, field)) card[field] = value;
    });

    if (diff.conflicts.length) {
      const { resolved, stillOpen } = applyPolicy(policy, diff.conflicts, {
        localUpdatedAt: card.remoteUpdatedAt,
        remoteUpdatedAt: remoteView.remoteUpdatedAt,
      });
      Object.entries(resolved).forEach(([field, value]) => { card[field] = value; });

      if (stillOpen.length) {
        // Only `prompt` policy leaves fields open; ask the user.
        const modal = new ConflictModal(this.plugin.app, {
          cardTitle: card.title,
          conflicts: stillOpen,
        });
        const answer = await modal.await();
        if (!answer) return "conflict-skipped";
        Object.entries(answer).forEach(([field, value]) => { card[field] = value; });
      }
    }

    const payload = localCardToDeckPatch(card, { owner: this.plugin.data.nextcloud.username });
    const board = remoteBoard(localBoard);
    this.plugin.debugLog({
      event: "sync.push.update.request",
      cardId: card.id,
      remoteId: card.remoteId,
      descriptionLen: (payload.description || "").length,
      hasChecklist: /(^|\n)#{1,6}\s*checklist/i.test(payload.description || ""),
      descriptionPreview: (payload.description || "").slice(0, 200),
      checklistLen: (card.checklist || []).length,
    });
    const { data: updated } = await client.updateCard(board, list.remoteId, card.remoteId, payload);
    if (!updated) throw new Error("Empty response from updateCard");
    this.plugin.debugLog({ event: "sync.push.update.done", cardId: card.id, remoteId: card.remoteId });
    this.applyRemoteToCard(card, updated, localBoard.id, list.id);
    card.localDirty = false;
    await this.attachments.pushCard(client, card, localBoard, list).catch((error) => {
      this.plugin.pushSyncLog({ event: "attachment-push-failed", cardId: card.id, message: (error && error.message) || String(error) });
    });
    return "pushed";
  }

  applyRemoteToCard(card, remoteResp, boardId, listId) {
    const remote = remoteCardToLocal(remoteResp, { boardId, listId });
    card.remoteId = remote.remoteId;
    card.etag = remote.etag;
    card.remoteUpdatedAt = remote.remoteUpdatedAt;
    // After a successful push, the *local* state is now the truth for the
    // baseline. Fields we didn't touch on Deck (checklist etc.) came back
    // unchanged, so hashing what we have is safe.
    card.baseline = snapshotBaseline(card);
  }

  // ---- Reap ---------------------------------------------------------------

  async reapDeletions(client) {
    const nc = this.plugin.data.nextcloud;
    if (!Array.isArray(nc.pendingDeletions) || !nc.pendingDeletions.length) return 0;
    const remaining = [];
    let removed = 0;
    for (const entry of nc.pendingDeletions) {
      try {
        await client.deleteCard(entry.boardRemoteId, entry.stackRemoteId, entry.remoteId);
        removed += 1;
      } catch (error) {
        // 404 means it's already gone — accept that as success.
        if (error instanceof DeckApiError && error.status === 404) {
          removed += 1;
        } else {
          this.plugin.pushSyncLog({ event: "reap-failed", entry, message: (error && error.message) || String(error) });
          remaining.push(entry);
        }
      }
    }
    nc.pendingDeletions = remaining;
    return removed;
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
    const nameMatch = this.plugin.data.boards.find(
      (board) => !bindings[board.id] && board.name && board.name.trim() === String(remoteBoard.title || "").trim(),
    );
    if (nameMatch) {
      bindings[nameMatch.id] = remoteBoard.id;
      return nameMatch.id;
    }
    const created = `board-${remoteBoard.id}`;
    bindings[created] = remoteBoard.id;
    return created;
  }

  suggestFolder(remoteBoard) {
    const title = String(remoteBoard.title || "Board").replace(/[\\/:*?"<>|]/g, " ").trim() || "Board";
    // User-configurable root, defaults to "Deck". Empty string means "put
    // boards at the vault root" — respect that literally.
    const raw = this.plugin.data.nextcloud && Object.prototype.hasOwnProperty.call(this.plugin.data.nextcloud, "rootFolder")
      ? this.plugin.data.nextcloud.rootFolder
      : "Deck";
    const root = typeof raw === "string" ? raw.trim().replace(/^\/+|\/+$/g, "") : "Deck";
    return root ? `${root}/${title}` : title;
  }
}

// ---- Local helpers --------------------------------------------------------

function remoteBoard(localBoard) {
  if (localBoard.remoteId == null) throw new Error("Board is not linked to Nextcloud yet.");
  return localBoard.remoteId;
}

function buildRemoteCardIndex(remoteStacks) {
  const index = new Map();
  (remoteStacks || []).forEach((stack) => {
    (stack.cards || []).forEach((card) => {
      if (card && card.id != null) index.set(card.id, card);
    });
  });
  return index;
}

module.exports = {
  SyncManager,
  STATUS_IDLE,
  STATUS_RUNNING,
  STATUS_ERROR,
  STATUS_OK,
};
