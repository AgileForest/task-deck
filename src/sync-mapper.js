const { uid, cleanColor, cleanDate } = require("./helpers");
const { snapshotBaseline } = require("./conflict");

// Nextcloud Deck ↔ local board model translators.
//
// Everything here is a pure function so it can be exercised by node's own
// assert module without spinning up Obsidian. The sync manager is the only
// caller; the plugin talks to that instead of poking these helpers directly.

/** Convert Deck's #rrggbb-ish "0082c9" into our "#0082c9" convention. */
function decodeDeckColor(raw) {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return cleanColor(withHash) || "";
}

/** Convert Deck's ISO 8601 duedate string into our YYYY-MM-DD storage form. */
function decodeDeckDate(raw) {
  if (!raw) return null;
  // Deck emits "2026-07-15T00:00:00+00:00"; cleanDate already tolerates that.
  return cleanDate(String(raw).slice(0, 10));
}

/**
 * Convert a remote card payload into the local card shape. Assignees are
 * preserved as-is (uid + display name) so future team support can round-trip
 * cleanly, but the MVP UI won't render them.
 */
function remoteCardToLocal(remoteCard, { boardId, listId }) {
  if (!remoteCard) return null;
  const labels = Array.isArray(remoteCard.labels)
    ? remoteCard.labels.map((label) => ({
        name: String(label.title || "").trim(),
        color: decodeDeckColor(label.color) || "#d43c35",
      })).filter((label) => label.name)
    : [];

  const assignees = Array.isArray(remoteCard.assignedUsers)
    ? remoteCard.assignedUsers
        .map((entry) => {
          const p = entry && entry.participant ? entry.participant : entry;
          if (!p) return null;
          return {
            email: p.email || p.primaryKey || p.uid || "",
            name: p.displayname || p.uid || "",
            color: "#8b5cf6",
          };
        })
        .filter((a) => a && a.email)
    : [];

  const card = {
    id: uid("card"),
    remoteId: remoteCard.id ?? null,
    etag: remoteCard.ETag || null,
    remoteUpdatedAt: remoteCard.lastModified || 0,
    baseline: null, // filled in below after we know the final field values
    localDirty: false,
    boardId,
    listId,
    title: String(remoteCard.title || "").trim() || "Untitled card",
    details: typeof remoteCard.description === "string" ? remoteCard.description : "",
    labels,
    assignees,
    checklist: [], // Deck has no first-class checklist; extraction from description is deferred
    completed: !!remoteCard.done, // Deck cards may carry `done` when archived; treat as complete for UX parity
    startDate: null,
    dueDate: decodeDeckDate(remoteCard.duedate),
    filePath: "", // assigned when the note is written to the vault
    position: typeof remoteCard.order === "number" ? remoteCard.order : null,
  };
  card.baseline = snapshotBaseline(card);
  return card;
}

/**
 * Merge a freshly pulled remote card onto an existing local card. Fields the
 * user hasn't touched locally (`localDirty === false`) are overwritten; the
 * local id and file path are preserved so vault notes don't churn.
 */
function mergeRemoteCardOntoLocal(existing, remoteCard, { boardId, listId }) {
  const remote = remoteCardToLocal(remoteCard, { boardId, listId });
  if (!existing) return remote;

  const merged = { ...existing };
  merged.remoteId = remote.remoteId;
  merged.etag = remote.etag;
  merged.remoteUpdatedAt = remote.remoteUpdatedAt;
  merged.listId = remote.listId;
  merged.boardId = remote.boardId;
  merged.position = remote.position;

  // Only overwrite user-editable fields when the local copy has no unsynced
  // changes. Field-level three-way merges live in sync-manager (M3+) which
  // will hand us a resolved card before it calls this. For the vanilla
  // "nothing local changed" case, remote wins wholesale.
  if (!existing.localDirty) {
    merged.title = remote.title;
    merged.details = remote.details;
    merged.labels = remote.labels;
    merged.assignees = remote.assignees;
    merged.completed = remote.completed;
    merged.dueDate = remote.dueDate;
    merged.startDate = remote.startDate;
  }
  // Baseline always tracks the *remote* view so the next push has an accurate
  // starting point for 3-way diffs.
  merged.baseline = remote.baseline;
  return merged;
}

/**
 * Build the JSON payload for `PUT /boards/{bid}/stacks/{sid}/cards/{cid}`.
 * Deck requires `title`, `type`, and `owner`; we omit fields we don't manage
 * (checklist etc.) so the server's canonical shape wins for them.
 */
function localCardToDeckPatch(card, { owner } = {}) {
  const payload = {
    title: card.title || "Untitled card",
    type: "plain",
    description: card.details || "",
    order: typeof card.position === "number" ? card.position : 0,
    duedate: card.dueDate ? new Date(`${card.dueDate}T00:00:00Z`).toISOString() : null,
  };
  if (owner) payload.owner = owner;
  return payload;
}

/** Body for the initial `POST /cards` call. Same shape as the update payload. */
function localCardToDeckCreate(card, opts) {
  return localCardToDeckPatch(card, opts);
}

/**
 * Build a fresh local board shape from a remote board + its stacks. Cards live
 * separately in the plugin's `data.cards` map, so this helper only returns the
 * board skeleton; the sync manager stitches cards in afterwards.
 */
function remoteBoardToLocal(remoteBoard, remoteStacks, { boardId, folderPath }) {
  const color = decodeDeckColor(remoteBoard.color);
  const lists = (remoteStacks || [])
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((stack) => ({
      id: uid("list"),
      remoteId: stack.id,
      title: String(stack.title || "").trim() || "List",
      color: color || "",
      cardIds: [],
    }));

  return {
    id: boardId || uid("board"),
    remoteId: remoteBoard.id,
    etag: remoteBoard.ETag || null,
    name: String(remoteBoard.title || "").trim() || "Board",
    folderPath: folderPath || "",
    lists,
    deletedListIds: [],
  };
}

/**
 * Given an existing local board and a fresh remote board + stacks, return an
 * updated board (immutable style). Stacks are keyed by `remoteId` so a rename
 * on Nextcloud doesn't rip the list apart.
 */
function reconcileBoardStructure(existingBoard, remoteBoard, remoteStacks) {
  const color = decodeDeckColor(remoteBoard.color);
  const known = new Map();
  (existingBoard.lists || []).forEach((list) => {
    if (list && list.remoteId != null) known.set(list.remoteId, list);
  });

  const nextLists = (remoteStacks || [])
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((stack) => {
      const prior = known.get(stack.id);
      if (prior) {
        return {
          ...prior,
          title: String(stack.title || "").trim() || prior.title,
          color: prior.color || color || "",
        };
      }
      return {
        id: uid("list"),
        remoteId: stack.id,
        title: String(stack.title || "").trim() || "List",
        color: color || "",
        cardIds: [],
      };
    });

  return {
    ...existingBoard,
    remoteId: remoteBoard.id,
    etag: remoteBoard.ETag || existingBoard.etag || null,
    name: String(remoteBoard.title || "").trim() || existingBoard.name,
    lists: nextLists,
  };
}

/** Utility used by tests: card is considered "remotely tracked" iff it has a numeric remoteId. */
function isRemoteTracked(card) {
  return !!(card && card.remoteId != null);
}

module.exports = {
  decodeDeckColor,
  decodeDeckDate,
  remoteCardToLocal,
  mergeRemoteCardOntoLocal,
  localCardToDeckPatch,
  localCardToDeckCreate,
  remoteBoardToLocal,
  reconcileBoardStructure,
  isRemoteTracked,
};