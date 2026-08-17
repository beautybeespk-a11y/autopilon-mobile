#!/usr/bin/env node
// Smoke test for the Autopilon JS/TS SDK (Phase 17 §55) — a plain script
// against a REAL, already-booted server with a real API key, same style
// as server/test/*.js and sdk/python/smoke_test.py. Run with:
//
//   AUTOPILON_API_KEY=ap_live_... AUTOPILON_BASE_URL=http://localhost:4000/api/v1 \
//       node smoke_test.mjs
//
// Exits non-zero if any check fails.
import { AutopilonClient, AutopilonApiError } from "./index.js";

const BASE_URL = process.env.AUTOPILON_BASE_URL || "http://localhost:4000/api/v1";
const API_KEY = process.env.AUTOPILON_API_KEY;

if (!API_KEY) {
  console.error("AUTOPILON_API_KEY is required (export it or pass inline).");
  process.exit(1);
}

const client = new AutopilonClient({ apiKey: API_KEY, baseUrl: BASE_URL });
const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}

await check("agents.list() returns a paginated shape", async () => {
  const page = await client.agents.list({ limit: 10 });
  if (!Array.isArray(page.data)) throw new Error("data is not a list");
  if (!("hasMore" in (page.pagination || {}))) throw new Error("missing pagination.hasMore");
});

await check("tasks create/get/update/complete/archive round-trip", async () => {
  const task = await client.tasks.create({ title: "JS SDK smoke test task", priority: "high" });
  if (task.title !== "JS SDK smoke test task") throw new Error("title mismatch on create");
  const fetched = await client.tasks.get(task.id);
  if (fetched.id !== task.id) throw new Error("id mismatch on get");
  const updated = await client.tasks.update(task.id, { description: "updated via js sdk" });
  if (updated.description !== "updated via js sdk") throw new Error("description not updated");
  const completed = await client.tasks.complete(task.id);
  if (completed.status !== "completed") throw new Error("status not completed");
  const archived = await client.tasks.archive(task.id);
  if (archived.status !== "archived") throw new Error("status not archived");
});

await check("agents.get(nonexistent) raises AutopilonApiError with RESOURCE_NOT_FOUND", async () => {
  try {
    await client.agents.get("does-not-exist");
    throw new Error("expected AutopilonApiError");
  } catch (err) {
    if (!(err instanceof AutopilonApiError)) throw err;
    if (err.code !== "RESOURCE_NOT_FOUND") throw new Error(`wrong code: ${err.code}`);
    if (err.status !== 404) throw new Error(`wrong status: ${err.status}`);
    if (!err.requestId) throw new Error("missing requestId");
  }
});

await check("webhooks create/getSecret/sendTestEvent/list/delete round-trip", async () => {
  const webhook = await client.webhooks.create({ url: "https://example.com/hooks/js-sdk-test", events: ["task.created"] });
  if (!webhook.secret?.startsWith("whsec_")) throw new Error("no secret returned on create");
  const secret = await client.webhooks.getSecret(webhook.id);
  if (secret.secret !== webhook.secret) throw new Error("secret mismatch on re-fetch");
  const listing = await client.webhooks.list();
  if (!listing.data.some((w) => w.id === webhook.id)) throw new Error("created webhook not in list");
  const testResult = await client.webhooks.sendTestEvent(webhook.id);
  if (typeof testResult.responseTimeMs !== "number") throw new Error("test event missing responseTimeMs");
  await client.webhooks.delete(webhook.id);
});

await check("projects.create requires a workspaceId (INVALID_REQUEST)", async () => {
  try {
    await client.projects.create({ workspaceId: null, name: "no workspace" });
    throw new Error("expected AutopilonApiError");
  } catch (err) {
    if (!(err instanceof AutopilonApiError)) throw err;
    if (err.code !== "INVALID_REQUEST") throw new Error(`wrong code: ${err.code}`);
  }
});

await check("marketplace.listAssets + listCategories return real shapes", async () => {
  const assets = await client.marketplace.listAssets({ limit: 5 });
  if (!Array.isArray(assets.data)) throw new Error("assets.data is not a list");
  const categories = await client.marketplace.listCategories();
  if (!Array.isArray(categories.data)) throw new Error("categories.data is not a list");
});

await check("files upload/get/downloadContent/delete round-trip", async () => {
  const content = "hello from the js sdk smoke test";
  const blob = new Blob([content], { type: "text/plain" });
  const uploaded = await client.files.upload({ file: blob, filename: "js-sdk-test.txt" });
  if (uploaded.filename !== "js-sdk-test.txt") throw new Error("filename mismatch");
  const fetched = await client.files.get(uploaded.id);
  if (fetched.id !== uploaded.id) throw new Error("id mismatch on get");
  const downloadRes = await client.files.downloadContent(uploaded.id);
  const downloaded = await downloadRes.text();
  if (downloaded !== content) throw new Error(`content mismatch: ${downloaded}`);
  await client.files.delete(uploaded.id);
});

await check("tasks.create with idempotencyKey replays on retry", async () => {
  const key = `js-sdk-smoke-${Date.now()}`;
  const first = await client.tasks.create({ title: "JS SDK idempotency test" }, { idempotencyKey: key });
  const second = await client.tasks.create({ title: "JS SDK idempotency test" }, { idempotencyKey: key });
  if (first.id !== second.id) throw new Error("expected the same task id on replay");
});

await check("integrations.listActions(unconnected provider) -> 404", async () => {
  try {
    await client.integrations.listActions("gmail");
    throw new Error("expected AutopilonApiError");
  } catch (err) {
    if (!(err instanceof AutopilonApiError)) throw err;
    if (err.status !== 404) throw new Error(`expected 404, got ${err.status}`);
  }
});

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed.`);
process.exit(passed === results.length ? 0 : 1);
