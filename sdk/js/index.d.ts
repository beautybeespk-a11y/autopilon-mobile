// Type declarations for @autopilon/sdk. Hand-written to match index.js and
// PUBLIC_API.md exactly — every method here has a real implementation and a
// real server endpoint behind it; nothing speculative is declared.

export interface AutopilonClientOptions {
  /** Bearer API key from your organization's Developer Console (ap_live_...). */
  apiKey: string;
  /** Base URL including /api/v1, e.g. "https://your-deployment/api/v1". */
  baseUrl?: string;
  /** Override fetch (needed on Node < 18, which has no global fetch). */
  fetchImpl?: typeof fetch;
}

export class AutopilonApiError extends Error {
  code: string;
  requestId: string | null;
  status: number;
  constructor(init: { code: string; message: string; requestId?: string | null; status: number });
}

export interface Pagination {
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}
export interface PaginatedResponse<T> {
  data: T[];
  pagination: Pagination;
}
export interface ListOpts {
  limit?: number;
  cursor?: string;
}
export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface Agent {
  id: string; name: string; description: string | null; personality: string | null;
  status: string; category: string | null; scope: string;
  createdAt: string; updatedAt: string;
}
export interface Run {
  id: string; agentId: string; conversationId: string | null; jobId: string | null;
  mode: "sync" | "async"; status: "queued" | "running" | "completed" | "failed";
  response: string | null; usage: Usage; error: string | null;
  createdAt: string; completedAt: string | null;
}
export interface Automation {
  id: string; name: string; description: string | null; triggerType: string; status: string;
  agentId: string | null; lastRunAt: string | null; nextRunAt: string | null;
  createdAt: string; updatedAt: string;
}
export interface AutomationRun {
  id: string; automationId: string; status: string; variables: Record<string, unknown>; createdAt: string;
  [key: string]: unknown;
}
export interface Task {
  id: string; title: string; description: string | null;
  status: "todo" | "in_progress" | "completed" | "archived";
  priority: string; dueDate: string | null; assignedToUserId: string | null;
  createdAt: string; updatedAt: string;
}
export interface Project {
  id: string; workspaceId: string; name: string; description: string | null; status: string;
  createdAt: string; updatedAt: string;
}
export interface FileObject {
  id: string; filename: string; mimeType: string | null; extension: string | null;
  sizeBytes: number; folderId: string | null; visibility: string; status: string;
  processingStatus: string | null; createdAt: string; updatedAt: string;
}
export interface ContentAsset {
  id: string; contentType: string; title: string | null; textContent: string | null;
  fileId: string | null; status: string; createdAt: string;
}
export interface Integration {
  provider: string; status: string; createdAt: string;
}
export interface Webhook {
  id: string; url: string; description: string | null; events: string[];
  status: "active" | "disabled"; createdAt: string; updatedAt: string;
}
export interface WebhookWithSecret extends Webhook {
  secret: string;
}
export interface WebhookDelivery {
  id: string; eventType: string; eventId: string; httpStatus: number | null;
  responseTimeMs: number | null; attempts: number; lastAttemptAt: string | null;
  error: string | null; status: string; createdAt: string;
}
export interface TestEventResult {
  eventId: string; eventType: string; payload: Record<string, unknown>;
  httpStatus: number | null; responseTimeMs: number; error: string | null;
}

declare class AgentsResource {
  list(opts?: ListOpts): Promise<PaginatedResponse<Agent>>;
  get(id: string): Promise<Agent>;
  listRuns(id: string, opts?: ListOpts): Promise<PaginatedResponse<Run>>;
  execute(id: string, opts: { message: string; conversationId?: string; async?: boolean }): Promise<Run>;
  sendMessage(id: string, opts: { message: string; conversationId?: string }): Promise<{ conversationId: string; response: string; usage: Usage }>;
}
declare class RunsResource {
  get(id: string): Promise<Run>;
}
declare class AutomationsResource {
  list(opts?: ListOpts): Promise<PaginatedResponse<Automation>>;
  get(id: string): Promise<Automation>;
  run(id: string, opts?: { variables?: Record<string, unknown> }): Promise<AutomationRun>;
  listRuns(id: string, opts?: ListOpts): Promise<PaginatedResponse<AutomationRun>>;
  getRun(runId: string): Promise<AutomationRun>;
}
declare class TasksResource {
  list(opts?: ListOpts): Promise<PaginatedResponse<Task>>;
  get(id: string): Promise<Task>;
  create(body: { title: string; description?: string; priority?: string; dueDate?: string }): Promise<Task>;
  update(id: string, patch: Partial<Pick<Task, "title" | "description" | "status" | "priority" | "dueDate">>): Promise<Task>;
  complete(id: string): Promise<Task>;
  archive(id: string): Promise<Task>;
}
declare class ProjectsResource {
  list(opts?: ListOpts): Promise<PaginatedResponse<Project>>;
  get(id: string): Promise<Project>;
  create(body: { workspaceId: string; name?: string; description?: string }): Promise<Project>;
  update(id: string, patch: Partial<Pick<Project, "name" | "description" | "status">>): Promise<Project>;
  archive(id: string): Promise<Project>;
  listItems(id: string): Promise<unknown[]>;
  addItem(id: string, opts: { itemType: string; itemId: string }): Promise<unknown>;
  removeItem(id: string, itemType: string, itemId: string): Promise<unknown>;
}
declare class FilesResource {
  list(opts?: ListOpts & { folderId?: string }): Promise<PaginatedResponse<FileObject>>;
  get(id: string): Promise<FileObject>;
  delete(id: string): Promise<unknown>;
  createDownloadUrl(id: string, opts?: { expiresInSeconds?: number }): Promise<{ url: string; expiresAt: string }>;
  upload(opts: { file: Blob; filename?: string; folderId?: string; visibility?: string; tags?: string | string[] }): Promise<FileObject>;
  downloadContent(id: string): Promise<Response>;
}
declare class ContentResource {
  getAsset(id: string): Promise<ContentAsset>;
  generateText(body: { contentType: string; brief: string; tone?: string; targetAudience?: string; keywords?: string[]; title?: string; agentId?: string }): Promise<ContentAsset>;
  generateImage(body: { prompt: string; negativePrompt?: string; size?: string; quality?: string; numImages?: number; title?: string; agentId?: string }): Promise<ContentAsset[]>;
  generateVoice(body: { text: string; voice?: string; speed?: number; title?: string; agentId?: string }): Promise<ContentAsset>;
}
declare class IntegrationsResource {
  list(): Promise<{ data: Integration[] }>;
}
declare class MarketplaceResource {
  listAssets(opts?: { q?: string; assetType?: string; categoryId?: string; sort?: string; limit?: number }): Promise<{ data: unknown[]; pagination: { limit: number } }>;
  listCategories(): Promise<{ data: unknown[] }>;
}
declare class WebhooksResource {
  listEventTypes(): Promise<{ data: string[] }>;
  list(): Promise<{ data: Webhook[] }>;
  get(id: string): Promise<Webhook>;
  create(opts: { url: string; description?: string; events: string[] }): Promise<WebhookWithSecret>;
  update(id: string, patch: Partial<Pick<Webhook, "url" | "description" | "events" | "status">>): Promise<Webhook>;
  delete(id: string): Promise<{ deleted: boolean }>;
  getSecret(id: string): Promise<{ secret: string; masked: string }>;
  sendTestEvent(id: string): Promise<TestEventResult>;
  listDeliveries(id: string, opts?: { limit?: number }): Promise<{ data: WebhookDelivery[] }>;
}

export class AutopilonClient {
  constructor(options: AutopilonClientOptions);
  agents: AgentsResource;
  runs: RunsResource;
  automations: AutomationsResource;
  tasks: TasksResource;
  projects: ProjectsResource;
  files: FilesResource;
  content: ContentResource;
  integrations: IntegrationsResource;
  marketplace: MarketplaceResource;
  webhooks: WebhooksResource;

  /** Low-level escape hatch — every resource method above is built on this. */
  request<T = unknown>(method: string, path: string, opts?: { query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string> }): Promise<T>;

  /** Walks every page of a cursor-paginated list endpoint. Not valid for /marketplace/assets. */
  paginate<T = unknown>(path: string, opts?: { query?: Record<string, unknown> }): AsyncGenerator<T, void, unknown>;
}
