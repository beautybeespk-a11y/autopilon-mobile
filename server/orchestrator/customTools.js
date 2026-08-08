import crypto from "crypto";
import db from "../db.js";
import { cryptoRandom } from "../middleware.js";

const now = () => new Date().toISOString();

function slugify(name) {
  return "custom." + name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/(^_|_$)/g, "");
}

export function createCustomTool(userId, { name, description, parametersSchema, webhookUrl, requiresConfirmation }) {
  if (!name?.trim()) throw new Error("Tool name is required.");
  if (!description?.trim()) throw new Error("Description is required — this is what the AI reads to decide when to use it.");
  if (!webhookUrl?.trim() || !/^https?:\/\//.test(webhookUrl)) throw new Error("A valid webhook URL is required.");
  let schema = { type: "object", properties: {}, required: [] };
  if (parametersSchema) {
    try { schema = typeof parametersSchema === "string" ? JSON.parse(parametersSchema) : parametersSchema; }
    catch { throw new Error("parametersSchema must be valid JSON."); }
  }
  const toolName = slugify(name);
  if (db.prepare("SELECT 1 FROM custom_tools WHERE name = ?").get(toolName)) {
    throw new Error(`A tool named "${toolName}" already exists — pick a different name.`);
  }
  const id = cryptoRandom();
  const webhookSecret = crypto.randomBytes(24).toString("hex");
  const ts = now();
  db.prepare(
    `INSERT INTO custom_tools (id, creatorUserId, name, description, parametersSchema, webhookUrl, webhookSecret, requiresConfirmation, status, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
  ).run(id, userId, toolName, description, JSON.stringify(schema), webhookUrl, webhookSecret, requiresConfirmation === false ? 0 : 1, ts, ts);
  return getMyCustomTool(userId, id);
}

export function listMyCustomTools(userId) {
  return db.prepare("SELECT * FROM custom_tools WHERE creatorUserId = ? ORDER BY updatedAt DESC").all(userId)
    .map((t) => ({ ...t, parametersSchema: JSON.parse(t.parametersSchema) }));
}

function getMyCustomTool(userId, id) {
  const row = db.prepare("SELECT * FROM custom_tools WHERE id = ? AND creatorUserId = ?").get(id, userId);
  if (!row) return null;
  return { ...row, parametersSchema: JSON.parse(row.parametersSchema) };
}

export function updateCustomTool(userId, id, fields) {
  const existing = db.prepare("SELECT id FROM custom_tools WHERE id = ? AND creatorUserId = ?").get(id, userId);
  if (!existing) throw new Error("Tool not found, or you don't own it.");
  const { description, webhookUrl, parametersSchema, requiresConfirmation } = fields;
  let schemaJson;
  if (parametersSchema !== undefined) {
    try { schemaJson = JSON.stringify(typeof parametersSchema === "string" ? JSON.parse(parametersSchema) : parametersSchema); }
    catch { throw new Error("parametersSchema must be valid JSON."); }
  }
  db.prepare(
    `UPDATE custom_tools SET description = COALESCE(?, description), webhookUrl = COALESCE(?, webhookUrl),
     parametersSchema = COALESCE(?, parametersSchema), requiresConfirmation = COALESCE(?, requiresConfirmation), updatedAt = ?
     WHERE id = ?`
  ).run(description, webhookUrl, schemaJson, requiresConfirmation != null ? (requiresConfirmation ? 1 : 0) : null, now(), id);
  return getMyCustomTool(userId, id);
}

export function setCustomToolStatus(userId, id, status) {
  if (!["draft", "published", "disabled"].includes(status)) throw new Error("Invalid status.");
  const r = db.prepare("UPDATE custom_tools SET status = ?, updatedAt = ? WHERE id = ? AND creatorUserId = ?").run(status, now(), id, userId);
  if (!r.changes) throw new Error("Tool not found, or you don't own it.");
  return getMyCustomTool(userId, id);
}

export function deleteCustomTool(userId, id) {
  const r = db.prepare("DELETE FROM custom_tools WHERE id = ? AND creatorUserId = ?").run(id, userId);
  if (!r.changes) throw new Error("Tool not found, or you don't own it.");
  return { deleted: true };
}

// The actual webhook call — used both for real agent tool calls (via the
// Tool Registry, see tools/registry.js) and for the developer's own "Test"
// button, so both paths exercise the exact same code.
export async function callCustomToolWebhook(tool, parameters, { userId, agentId } = {}) {
  const body = JSON.stringify({ tool: tool.name, parameters, userId, agentId, timestamp: new Date().toISOString() });
  const signature = crypto.createHmac("sha256", tool.webhookSecret).update(body).digest("hex");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let res;
  try {
    res = await fetch(tool.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-autopilon-signature": signature },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(err.name === "AbortError" ? "The tool's webhook took too long to respond (15s timeout)." : `Couldn't reach the tool's webhook: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`The tool's webhook didn't return valid JSON. Raw response: ${text.slice(0, 300)}`); }

  if (!res.ok) throw new Error(data?.error || `The tool's webhook returned an error (${res.status}).`);
  return data;
}
