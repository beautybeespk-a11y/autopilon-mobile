// Minimal Autopilon Public API client (Phase 17 §55). No dependencies —
// relies on Node 18+'s global fetch/FormData/Blob, or a browser. Covers
// exactly the endpoints documented in ../../PUBLIC_API.md; nothing here
// wraps an endpoint that doesn't exist server-side. ESM, matching the
// rest of this repo's server/client code.

export class AutopilonApiError extends Error {
  constructor({ code, message, requestId, status }) {
    super(message);
    this.name = "AutopilonApiError";
    this.code = code;
    this.requestId = requestId || null;
    this.status = status;
  }
}

function buildQuery(url, query) {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
}

export class AutopilonClient {
  constructor({ apiKey, baseUrl = "http://localhost:4000/api/v1", fetchImpl } = {}) {
    if (!apiKey) throw new Error("AutopilonClient: apiKey is required.");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this._fetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    if (!this._fetch) throw new Error("AutopilonClient: no fetch implementation available — pass { fetchImpl } on Node < 18.");

    this.agents = new AgentsResource(this);
    this.runs = new RunsResource(this);
    this.automations = new AutomationsResource(this);
    this.tasks = new TasksResource(this);
    this.projects = new ProjectsResource(this);
    this.files = new FilesResource(this);
    this.content = new ContentResource(this);
    this.integrations = new IntegrationsResource(this);
    this.marketplace = new MarketplaceResource(this);
    this.webhooks = new WebhooksResource(this);
  }

  // Core JSON request. Every resource method funnels through here so
  // auth headers, error parsing, and request-id propagation live in
  // exactly one place.
  async request(method, path, { query, body, headers } = {}) {
    const url = new URL(this.baseUrl + path);
    buildQuery(url, query);
    const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
    const res = await this._fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(isFormData ? {} : body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body),
    });
    const requestId = res.headers.get("x-request-id");
    const contentType = res.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {
      if (!res.ok) {
        throw new AutopilonApiError({ code: "HTTP_ERROR", message: `Request failed with HTTP ${res.status}.`, requestId, status: res.status });
      }
      return res; // caller (e.g. downloadFileContent) reads the raw body itself
    }

    const json = await res.json();
    if (!res.ok) {
      const err = json?.error || {};
      throw new AutopilonApiError({
        code: err.code || "UNKNOWN_ERROR",
        message: err.message || `Request failed with HTTP ${res.status}.`,
        requestId: err.request_id || requestId,
        status: res.status,
      });
    }
    return json;
  }

  // Transparently walks every page of a cursor-paginated list endpoint —
  // NOT usable against /marketplace/assets, which isn't cursor-paginated
  // (see PUBLIC_API.md's Pagination section).
  async *paginate(path, { query = {} } = {}) {
    let cursor;
    for (;;) {
      const page = await this.request("GET", path, { query: { ...query, cursor } });
      for (const item of page.data) yield item;
      if (!page.pagination?.hasMore) return;
      cursor = page.pagination.nextCursor;
    }
  }
}

// Turns an optional idempotencyKey into the {headers} shape request() expects.
// Shared by every resource method below that wraps a write endpoint
// supporting Idempotency-Key (see PUBLIC_API.md's Idempotency section for
// exactly which ones).
function idempotencyHeaders(idempotencyKey) {
  return idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : {};
}

class AgentsResource {
  constructor(client) { this._c = client; }
  list(opts = {}) { return this._c.request("GET", "/agents", { query: opts }); }
  get(id) { return this._c.request("GET", `/agents/${encodeURIComponent(id)}`); }
  listRuns(id, opts = {}) { return this._c.request("GET", `/agents/${encodeURIComponent(id)}/runs`, { query: opts }); }
  execute(id, { message, conversationId, async: runAsync, idempotencyKey } = {}) {
    return this._c.request("POST", `/agents/${encodeURIComponent(id)}/execute`, { body: { message, conversationId, async: runAsync }, ...idempotencyHeaders(idempotencyKey) });
  }
  sendMessage(id, { message, conversationId, idempotencyKey } = {}) {
    return this._c.request("POST", `/agents/${encodeURIComponent(id)}/messages`, { body: { message, conversationId }, ...idempotencyHeaders(idempotencyKey) });
  }
}

class RunsResource {
  constructor(client) { this._c = client; }
  get(id) { return this._c.request("GET", `/runs/${encodeURIComponent(id)}`); }
}

class AutomationsResource {
  constructor(client) { this._c = client; }
  list(opts = {}) { return this._c.request("GET", "/automations", { query: opts }); }
  get(id) { return this._c.request("GET", `/automations/${encodeURIComponent(id)}`); }
  run(id, { variables, idempotencyKey } = {}) { return this._c.request("POST", `/automations/${encodeURIComponent(id)}/run`, { body: { variables }, ...idempotencyHeaders(idempotencyKey) }); }
  listRuns(id, opts = {}) { return this._c.request("GET", `/automations/${encodeURIComponent(id)}/runs`, { query: opts }); }
  getRun(runId) { return this._c.request("GET", `/automations/runs/${encodeURIComponent(runId)}`); }
}

class TasksResource {
  constructor(client) { this._c = client; }
  list(opts = {}) { return this._c.request("GET", "/tasks", { query: opts }); }
  get(id) { return this._c.request("GET", `/tasks/${encodeURIComponent(id)}`); }
  create(body, { idempotencyKey } = {}) { return this._c.request("POST", "/tasks", { body, ...idempotencyHeaders(idempotencyKey) }); }
  update(id, patch) { return this._c.request("PATCH", `/tasks/${encodeURIComponent(id)}`, { body: patch }); }
  complete(id) { return this._c.request("POST", `/tasks/${encodeURIComponent(id)}/complete`); }
  archive(id) { return this._c.request("DELETE", `/tasks/${encodeURIComponent(id)}`); }
}

class ProjectsResource {
  constructor(client) { this._c = client; }
  list(opts = {}) { return this._c.request("GET", "/projects", { query: opts }); }
  get(id) { return this._c.request("GET", `/projects/${encodeURIComponent(id)}`); }
  create(body, { idempotencyKey } = {}) { return this._c.request("POST", "/projects", { body, ...idempotencyHeaders(idempotencyKey) }); }
  update(id, patch) { return this._c.request("PATCH", `/projects/${encodeURIComponent(id)}`, { body: patch }); }
  archive(id) { return this._c.request("DELETE", `/projects/${encodeURIComponent(id)}`); }
  listItems(id) { return this._c.request("GET", `/projects/${encodeURIComponent(id)}/items`); }
  addItem(id, { itemType, itemId }) { return this._c.request("POST", `/projects/${encodeURIComponent(id)}/items`, { body: { itemType, itemId } }); }
  removeItem(id, itemType, itemId) {
    return this._c.request("DELETE", `/projects/${encodeURIComponent(id)}/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}`);
  }
}

class FilesResource {
  constructor(client) { this._c = client; }
  list(opts = {}) { return this._c.request("GET", "/files", { query: opts }); }
  get(id) { return this._c.request("GET", `/files/${encodeURIComponent(id)}`); }
  delete(id) { return this._c.request("DELETE", `/files/${encodeURIComponent(id)}`); }
  createDownloadUrl(id, { expiresInSeconds } = {}) {
    return this._c.request("POST", `/files/${encodeURIComponent(id)}/download-url`, { body: { expiresInSeconds } });
  }

  // `file` must be a Blob/File (browser) or a Node 18+ Blob/Buffer-wrapped
  // Blob — this method builds the multipart body itself so callers never
  // have to know the field name the server expects.
  upload({ file, filename, folderId, visibility, tags } = {}) {
    const form = new FormData();
    form.append("file", file, filename);
    if (folderId) form.append("folderId", folderId);
    if (visibility) form.append("visibility", visibility);
    if (tags) form.append("tags", Array.isArray(tags) ? tags.join(",") : tags);
    return this._c.request("POST", "/files/upload", { body: form });
  }

  // Returns the raw fetch Response so the caller can pick .arrayBuffer(),
  // .blob(), or stream .body themselves — a single SDK-chosen return shape
  // would be wrong for at least one of those use cases.
  async downloadContent(id) {
    return this._c.request("GET", `/files/${encodeURIComponent(id)}/content`);
  }
}

class ContentResource {
  constructor(client) { this._c = client; }
  getAsset(id) { return this._c.request("GET", `/content/${encodeURIComponent(id)}`); }
  generateText(body, { idempotencyKey } = {}) { return this._c.request("POST", "/content/text", { body, ...idempotencyHeaders(idempotencyKey) }); }
  generateImage(body, { idempotencyKey } = {}) { return this._c.request("POST", "/content/image", { body, ...idempotencyHeaders(idempotencyKey) }); }
  generateVoice(body, { idempotencyKey } = {}) { return this._c.request("POST", "/content/voice", { body, ...idempotencyHeaders(idempotencyKey) }); }
}

class IntegrationsResource {
  constructor(client) { this._c = client; }
  list() { return this._c.request("GET", "/integrations"); }
  listActions(provider) { return this._c.request("GET", `/integrations/${encodeURIComponent(provider)}/actions`); }
  executeAction(provider, actionName, { agentId, parameters, idempotencyKey } = {}) {
    return this._c.request("POST", `/integrations/${encodeURIComponent(provider)}/actions/${encodeURIComponent(actionName)}/execute`, {
      body: { agentId, parameters }, ...idempotencyHeaders(idempotencyKey),
    });
  }
}

class MarketplaceResource {
  constructor(client) { this._c = client; }
  listAssets(opts = {}) { return this._c.request("GET", "/marketplace/assets", { query: opts }); }
  listCategories() { return this._c.request("GET", "/marketplace/categories"); }
}

class WebhooksResource {
  constructor(client) { this._c = client; }
  listEventTypes() { return this._c.request("GET", "/webhooks/event-types"); }
  list() { return this._c.request("GET", "/webhooks"); }
  get(id) { return this._c.request("GET", `/webhooks/${encodeURIComponent(id)}`); }
  create({ url, description, events }) { return this._c.request("POST", "/webhooks", { body: { url, description, events } }); }
  update(id, patch) { return this._c.request("PATCH", `/webhooks/${encodeURIComponent(id)}`, { body: patch }); }
  delete(id) { return this._c.request("DELETE", `/webhooks/${encodeURIComponent(id)}`); }
  getSecret(id) { return this._c.request("GET", `/webhooks/${encodeURIComponent(id)}/secret`); }
  sendTestEvent(id) { return this._c.request("POST", `/webhooks/${encodeURIComponent(id)}/test`); }
  listDeliveries(id, opts = {}) { return this._c.request("GET", `/webhooks/${encodeURIComponent(id)}/deliveries`, { query: opts }); }
}
