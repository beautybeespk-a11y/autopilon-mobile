import fs from "fs";
import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { orchestrate } from "./index.js";
import { requireFileAccess } from "./fileService.js";
import { getStorageProvider } from "../storage/provider.js";
import { logFileActivity } from "./fileActivity.js";

// Everything a new inbound message needs to go through, regardless of which
// channel it arrived on (web chat or WhatsApp): build the agent's system
// prompt, load + enrich history, run the Orchestrator, persist the reply.
// Both routes/chat.js and the WhatsApp webhook call this — neither
// duplicates it.
// Capped so a large attached file doesn't blow out the LLM's context window
// (or the API cost) on a single turn. The full text is still saved to the
// Knowledge Library by the upload endpoint, so nothing is lost — just not
// all of it is pasted into this one prompt.
const MAX_ATTACHMENT_CHARS = 8000;

export async function handleIncomingMessage({
  userId, agentId, conversationId, content, attachmentTitle = null, attachmentText = null, attachmentImageId = null, attachmentFileId = null, skipUserInsert = false,
}) {
  const now = new Date().toISOString();

  // What gets stored and shown in the chat transcript stays short — just a
  // 📎 marker and the user's own words. The full attachment text is only
  // added to what the LLM sees for THIS turn (below), not persisted into
  // the visible message, so re-opening the conversation later doesn't show
  // a wall of pasted file content.
  const displayContent = attachmentTitle ? `📎 ${attachmentTitle}${content?.trim() ? `\n\n${content}` : ""}` : content;

  if (!skipUserInsert) {
    db.prepare("INSERT INTO messages (id, conversationId, role, content, createdAt) VALUES (?, ?, 'user', ?, ?)")
      .run(cryptoRandom(), conversationId, displayContent, now);
  }

  // Passed to orchestrate() as `extraContext` — appended to what the MODEL
  // sees for this turn only (see orchestrator/index.js), not stored in the
  // DB. `history` below still reflects the short displayContent.
  let extraContext = null;
  if (attachmentText) {
    const truncated = attachmentText.length > MAX_ATTACHMENT_CHARS;
    const clipped = attachmentText.slice(0, MAX_ATTACHMENT_CHARS);
    extraContext =
      `[Attached file: "${attachmentTitle}". Contents:\n"""\n${clipped}` +
      `${truncated ? "\n[...truncated...]" : ""}\n"""]`;
  }

  // An attached image never comes through as a base64 body field (that would
  // blow past the API's JSON body-size limit) — the client already uploaded
  // it to /research/knowledge/upload and just passes the resulting item id.
  // Re-read the bytes off disk here, scoped to this user, and hand them to
  // orchestrate() as a vision input for this turn only (same "not persisted
  // into future turns" rule as extraContext above).
  let extraImage = null;
  if (attachmentImageId) {
    const row = db.prepare("SELECT content FROM knowledge_items WHERE id = ? AND userId = ? AND type = 'image'")
      .get(attachmentImageId, userId);
    if (row) {
      const meta = JSON.parse(row.content || "{}");
      if (meta.storagePath && fs.existsSync(meta.storagePath)) {
        extraImage = { mimeType: meta.mimeType, base64: fs.readFileSync(meta.storagePath).toString("base64") };
        // The model only SEES the pixels via extraImage above — it has no
        // way to refer back to this specific photo in a later tool call
        // unless told the id as text too. wordpress.upload_chat_image
        // (tools/wordpress/content.js) accepts this same id to re-read the
        // file and upload it somewhere the model can't reach directly.
        const imageNote = `[The user attached a photo (reference id: "${attachmentImageId}"). If asked to use this photo somewhere that needs a real image URL (e.g. as a product image), call wordpress.upload_chat_image with imageReferenceId "${attachmentImageId}" first to get one — you cannot pass this id directly to a tool expecting a URL.]`;
        extraContext = extraContext ? `${extraContext}\n\n${imageNote}` : imageNote;
      }
    }
    // Temporary diagnostic — remove once image attachments are confirmed
    // working end-to-end.
    console.log("[conversationService] resolving attachmentImageId:", {
      attachmentImageId,
      foundKnowledgeRow: Boolean(row),
      resolvedImage: extraImage ? { mimeType: extraImage.mimeType, base64Length: extraImage.base64.length } : null,
    });
  }

  // A file attached from the centralized File Manager (Phase 14) — resolved
  // through requireFileAccess(), the EXACT same permission check any other
  // access to that file goes through. An agent/automation can never see a
  // file this way that the user themselves couldn't open in the File
  // Manager, and a permission failure here fails closed: no file content
  // reaches the model, the turn just proceeds without it.
  if (attachmentFileId) {
    try {
      const file = requireFileAccess(userId, attachmentFileId, "view");
      if (file.aiAnalysisSupport && !file.textExtractionSupport) {
        const buffer = await getStorageProvider(file.storageProvider).download({ key: file.storageKey });
        extraImage = extraImage || { mimeType: file.mimeType, base64: buffer.toString("base64") };
      } else if (file.extractedText) {
        const truncated = file.extractedText.length > MAX_ATTACHMENT_CHARS;
        const clipped = file.extractedText.slice(0, MAX_ATTACHMENT_CHARS);
        const fileContext = `[Attached file: "${file.filename}". Contents:\n"""\n${clipped}${truncated ? "\n[...truncated...]" : ""}\n"""]`;
        extraContext = extraContext ? `${extraContext}\n\n${fileContext}` : fileContext;
      }
      logFileActivity(attachmentFileId, "ai_access", { userId, agentId, conversationId, orgId: file.orgId, workspaceId: file.workspaceId });
    } catch (err) {
      console.error("[conversationService] attachmentFileId resolution failed:", err.message);
    }
  }

  let systemPrompt = "You are a helpful AI assistant inside the AI Agent Platform.";
  if (agentId) {
    // Callers (routes/chat.js, the Public API's agent execution) are
    // expected to have already run canAccessAgent() before reaching here —
    // this lookup being ownership-only (userId, not org/workspace-aware)
    // was previously silently swallowing a real access gap: any org
    // teammate who wasn't the agent's exact creator got this generic
    // fallback prompt instead of the agent's actual configured personality,
    // even though they were allowed to use the agent at all.
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
    if (agent) systemPrompt = `You are "${agent.name}". Personality: ${agent.personality}. ${agent.instructions || ""}`.trim();
  }

  // Prior tool results are folded into history so a follow-up referencing an
  // earlier result by name (e.g. a campaign, a task) can still resolve back
  // to its real ID — see the Phase 4 cross-turn memory fix for why this matters.
  const rawHistory = db.prepare("SELECT role, content, meta FROM messages WHERE conversationId = ? ORDER BY createdAt ASC").all(conversationId);
  const history = rawHistory.map((m) => {
    if (m.role !== "assistant" || !m.meta) return { role: m.role, content: m.content };
    const parsedMeta = JSON.parse(m.meta);
    const successes = (parsedMeta.toolResults || []).filter((r) => !r.error);
    if (!successes.length) return { role: m.role, content: m.content };
    const dataNote = successes.map((r) => `${r.toolName} returned: ${JSON.stringify(r.result)}`).join("\n");
    return { role: m.role, content: `${m.content}\n\n[Underlying tool data from this turn, for your own reference in follow-ups — do not repeat verbatim: ${dataNote}]` };
  });

  const { reply, trace, toolResults, confirmation, usage } = await orchestrate({
    userId,
    agentId: agentId || null,
    conversationId,
    userMessage: content || "",
    history,
    agentSystemPrompt: systemPrompt,
    extraContext,
    extraImage,
  });

  const replyAt = new Date().toISOString();
  const meta = JSON.stringify({ trace, toolResults, confirmation });
  const assistantMessageId = cryptoRandom();
  db.prepare("INSERT INTO messages (id, conversationId, role, content, createdAt, meta) VALUES (?, ?, 'assistant', ?, ?, ?)")
    .run(assistantMessageId, conversationId, reply, replyAt, meta);
  db.prepare("UPDATE conversations SET updatedAt = ? WHERE id = ?").run(replyAt, conversationId);

  return { conversationId, reply, trace, toolResults, confirmation, assistantMessageId, usage };
}
