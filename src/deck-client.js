const { requestUrl } = require("obsidian");

const { normalizeServerUrl } = require("./nextcloud-auth");

// Thin REST client for the Nextcloud Deck API.
// https://deck.readthedocs.io/en/latest/API/
//
// All traffic goes through Obsidian's `requestUrl`, which bypasses the browser
// CORS layer and works identically on desktop and mobile. Responses carry an
// `ETag` (or `Last-Modified`) header that the sync layer will use for
// incremental refreshes.
//
// The client is intentionally small — it just maps method + path + params to a
// request and normalises errors. Higher-level sync semantics (dirty tracking,
// conflict resolution, retries beyond transient network / 429) live in
// sync-manager.js so the client stays reusable and testable in isolation.

const DECK_API_PREFIX = "/index.php/apps/deck/api/v1.0";
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 60000;

class DeckApiError extends Error {
  constructor(message, { status = 0, url = "", body = null } = {}) {
    super(message);
    this.name = "DeckApiError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

class DeckClient {
  /**
   * @param {{ serverUrl: string, username: string, appPassword: string,
   *   maxRetries?: number, userAgent?: string, logger?: (event: object) => void }} options
   */
  constructor(options) {
    if (!options || !options.serverUrl || !options.username || !options.appPassword) {
      throw new Error("DeckClient requires serverUrl, username, and appPassword.");
    }
    this.serverUrl = normalizeServerUrl(options.serverUrl);
    this.username = options.username;
    this.appPassword = options.appPassword;
    this.maxRetries = Number.isFinite(options.maxRetries) ? options.maxRetries : 4;
    this.userAgent = options.userAgent || "Obsidian Nextcloud Deck";
    this.logger = typeof options.logger === "function" ? options.logger : null;
  }

  // High-level endpoints ---------------------------------------------------

  getBoards({ etag } = {}) {
    return this.request({ method: "GET", path: "/boards", etag });
  }

  getBoard(boardId, { etag } = {}) {
    return this.request({ method: "GET", path: `/boards/${encodeURIComponent(boardId)}`, etag });
  }

  createBoard({ title, color = "0082c9" }) {
    return this.request({ method: "POST", path: "/boards", body: { title, color } });
  }

  updateBoard(boardId, { title, color, archived }) {
    const body = {};
    if (title !== undefined) body.title = title;
    if (color !== undefined) body.color = color;
    if (archived !== undefined) body.archived = archived;
    return this.request({ method: "PUT", path: `/boards/${encodeURIComponent(boardId)}`, body });
  }

  deleteBoard(boardId) {
    return this.request({ method: "DELETE", path: `/boards/${encodeURIComponent(boardId)}` });
  }

  getStacks(boardId, { etag } = {}) {
    return this.request({ method: "GET", path: `/boards/${encodeURIComponent(boardId)}/stacks`, etag });
  }

  createStack(boardId, { title, order }) {
    const body = { title };
    if (order !== undefined) body.order = order;
    return this.request({ method: "POST", path: `/boards/${encodeURIComponent(boardId)}/stacks`, body });
  }

  updateStack(boardId, stackId, { title, order }) {
    const body = {};
    if (title !== undefined) body.title = title;
    if (order !== undefined) body.order = order;
    return this.request({
      method: "PUT",
      path: `/boards/${encodeURIComponent(boardId)}/stacks/${encodeURIComponent(stackId)}`,
      body,
    });
  }

  deleteStack(boardId, stackId) {
    return this.request({
      method: "DELETE",
      path: `/boards/${encodeURIComponent(boardId)}/stacks/${encodeURIComponent(stackId)}`,
    });
  }

  getCard(boardId, stackId, cardId, { etag } = {}) {
    return this.request({
      method: "GET",
      path: `/boards/${encodeURIComponent(boardId)}/stacks/${encodeURIComponent(stackId)}/cards/${encodeURIComponent(cardId)}`,
      etag,
    });
  }

  createCard(boardId, stackId, { title, description = "", type = "plain", order }) {
    const body = { title, description, type };
    if (order !== undefined) body.order = order;
    return this.request({
      method: "POST",
      path: `/boards/${encodeURIComponent(boardId)}/stacks/${encodeURIComponent(stackId)}/cards`,
      body,
    });
  }

  updateCard(boardId, stackId, cardId, patch) {
    return this.request({
      method: "PUT",
      path: `/boards/${encodeURIComponent(boardId)}/stacks/${encodeURIComponent(stackId)}/cards/${encodeURIComponent(cardId)}`,
      body: patch,
    });
  }

  deleteCard(boardId, stackId, cardId) {
    return this.request({
      method: "DELETE",
      path: `/boards/${encodeURIComponent(boardId)}/stacks/${encodeURIComponent(stackId)}/cards/${encodeURIComponent(cardId)}`,
    });
  }

  /** Move a card. Deck's endpoint: PUT /cards/{cardId}/reorder. */
  reorderCard(boardId, stackId, cardId, { targetStackId, order }) {
    return this.request({
      method: "PUT",
      path: `/boards/${encodeURIComponent(boardId)}/stacks/${encodeURIComponent(stackId)}/cards/${encodeURIComponent(cardId)}/reorder`,
      body: { stackId: targetStackId, order },
    });
  }

  createLabel(boardId, { title, color = "31CC7C" }) {
    return this.request({
      method: "POST",
      path: `/boards/${encodeURIComponent(boardId)}/labels`,
      body: { title, color },
    });
  }

  updateLabel(boardId, labelId, { title, color }) {
    return this.request({
      method: "PUT",
      path: `/boards/${encodeURIComponent(boardId)}/labels/${encodeURIComponent(labelId)}`,
      body: { title, color },
    });
  }

  deleteLabel(boardId, labelId) {
    return this.request({
      method: "DELETE",
      path: `/boards/${encodeURIComponent(boardId)}/labels/${encodeURIComponent(labelId)}`,
    });
  }

  assignLabel(boardId, stackId, cardId, labelId) {
    return this.request({
      method: "PUT",
      path: `/boards/${encodeURIComponent(boardId)}/stacks/${encodeURIComponent(stackId)}/cards/${encodeURIComponent(cardId)}/assignLabel`,
      body: { labelId },
    });
  }

  removeLabel(boardId, stackId, cardId, labelId) {
    return this.request({
      method: "PUT",
      path: `/boards/${encodeURIComponent(boardId)}/stacks/${encodeURIComponent(stackId)}/cards/${encodeURIComponent(cardId)}/removeLabel`,
      body: { labelId },
    });
  }

  getBoardAcl(boardId) {
    return this.request({ method: "GET", path: `/boards/${encodeURIComponent(boardId)}/acl` });
  }

  // Attachments (used by Phase 4 — kept here so the client remains complete).
  getAttachments(boardId, stackId, cardId) {
    return this.request({
      method: "GET",
      path: `/boards/${encodeURIComponent(boardId)}/stacks/${encodeURIComponent(stackId)}/cards/${encodeURIComponent(cardId)}/attachments`,
    });
  }

  // Low-level plumbing ------------------------------------------------------

  buildUrl(path, query) {
    let url = `${this.serverUrl}${DECK_API_PREFIX}${path}`;
    if (query && Object.keys(query).length) {
      const params = Object.entries(query)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      if (params.length) url += `?${params.join("&")}`;
    }
    return url;
  }

  buildHeaders({ etag } = {}) {
    const headers = {
      "OCS-APIRequest": "true",
      "Accept": "application/json",
      "Content-Type": "application/json",
      "User-Agent": this.userAgent,
      "Authorization": `Basic ${window.btoa(`${this.username}:${this.appPassword}`)}`,
    };
    if (etag) headers["If-None-Match"] = etag;
    return headers;
  }

  /**
   * Send one request. Retries transient network / retryable HTTP failures with
   * exponential backoff (1s → 2s → 4s → …, capped at 60s). On success returns
   * { status, etag, data, headers }; a 304 is returned as { status: 304 } with
   * `data: null` so callers can keep their cached copy.
   *
   * On non-retryable failures throws a DeckApiError; a 401 flags the caller
   * (settings/sync) to force re-authentication.
   */
  async request({ method, path, body, query, etag, signal }) {
    const url = this.buildUrl(path, query);
    const headers = this.buildHeaders({ etag });
    const payload = body === undefined ? undefined : JSON.stringify(body);

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal && signal.aborted) throw new DeckApiError("Request aborted", { url });

      let response;
      let transportError = null;
      try {
        response = await requestUrl({
          url,
          method,
          headers,
          body: payload,
          contentType: "application/json",
          throw: false,
          // requestUrl doesn't expose AbortSignal directly; the signal check
          // above catches cancellation between retries which is sufficient
          // for our sync scheduler.
        });
      } catch (error) {
        transportError = error;
        response = { status: 0 };
      }

      const status = response.status || 0;
      const etagOut = pickHeader(response, "etag") || pickHeader(response, "ETag") || null;

      this.log({ url, method, status, attempt });

      // Success paths.
      if (status === 304) return { status, etag: etagOut, data: null, headers: response.headers || {} };
      if (status >= 200 && status < 300) {
        return {
          status,
          etag: etagOut,
          data: parseBody(response),
          headers: response.headers || {},
        };
      }

      // Non-retryable failures: bail out immediately so the caller sees the
      // exact HTTP status. 401 in particular must not be silently retried —
      // the sync layer needs it to flip the credential state.
      if (status && !RETRYABLE_STATUS.has(status)) {
        throw new DeckApiError(`Deck API ${method} ${path} failed (${status}).`, {
          status,
          url,
          body: parseBody(response),
        });
      }

      attempt += 1;
      if (attempt > this.maxRetries) {
        if (transportError) {
          throw new DeckApiError(`Deck API ${method} ${path} unreachable: ${transportError.message || transportError}.`, {
            status: 0,
            url,
          });
        }
        throw new DeckApiError(`Deck API ${method} ${path} kept failing (${status}).`, {
          status,
          url,
          body: parseBody(response),
        });
      }

      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * (2 ** (attempt - 1)));
      await sleep(backoff);
    }
  }

  log(event) {
    if (this.logger) {
      try { this.logger(event); } catch (error) { /* ignore logger faults */ }
    }
  }
}

function pickHeader(response, name) {
  if (!response || !response.headers) return null;
  // requestUrl normalises headers to lowercase on some platforms but not
  // others; probe both to be safe.
  const headers = response.headers;
  if (headers[name] !== undefined) return headers[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return null;
}

function parseBody(response) {
  if (!response) return null;
  if (response.json && typeof response.json === "object") return response.json;
  const text = response.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return text;
  }
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

module.exports = {
  DeckClient,
  DeckApiError,
  RETRYABLE_STATUS,
};
