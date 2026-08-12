// Automation/agent tools for the File & Document Management system. Every
// one of these goes through the exact same executor.js lifecycle (planning
// -> confirmation if required -> running -> completed/failed) as every
// other tool — no separate execution path, and every call ultimately runs
// through fileService.js/fileVersions.js/fileShare.js, so it's bound by the
// exact same permission checks a human clicking around the File Manager UI
// would be.
import { registerTool } from "./registry.js";
import { chatComplete } from "../ai/provider.js";
import {
  listFiles, requireFileAccess, renameFile, moveFile, copyFile, trashFile, withTags,
} from "../orchestrator/fileService.js";
import { createFolder } from "../orchestrator/folderService.js";
import { createShare } from "../orchestrator/fileShare.js";

registerTool({
  name: "find_files",
  description: "Searches files by name, tag, extension, or folder. Use search_file_content instead if you need to search inside document contents.",
  category: "files",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Matches against filename" },
      tag: { type: "string" },
      extension: { type: "string" },
      folderId: { type: "string" },
    },
    required: [],
  },
  requiredPermissions: ["files"],
  async execute(parameters, context) {
    const files = listFiles(context.userId, { q: parameters.query, tag: parameters.tag, extension: parameters.extension, folderId: parameters.folderId });
    return { files: files.map((f) => ({ id: f.id, filename: f.filename, extension: f.extension, sizeBytes: f.sizeBytes, folderId: f.folderId, tags: f.tags })), count: files.length };
  },
});

registerTool({
  name: "search_file_content",
  description: "Full-text search across the content of files that support text extraction (PDF, DOCX, TXT, CSV, XLSX). Returns files whose extracted text matches.",
  category: "files",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  requiredPermissions: ["files"],
  async execute(parameters, context) {
    const files = listFiles(context.userId, { q: parameters.query });
    return {
      files: files.map((f) => ({ id: f.id, filename: f.filename, snippet: (f.extractedText || "").slice(0, 300) })),
      count: files.length,
    };
  },
});

registerTool({
  name: "get_file_metadata",
  description: "Returns full metadata for one file: size, type, owner, folder, tags, processing status, versions.",
  category: "files",
  parameters: { type: "object", properties: { fileId: { type: "string" } }, required: ["fileId"] },
  requiredPermissions: ["files"],
  async execute(parameters, context) {
    const file = requireFileAccess(context.userId, parameters.fileId, "view");
    return withTags(file);
  },
});

registerTool({
  name: "move_file",
  description: "Moves a file into a different folder (or to the root, if folderId is omitted).",
  category: "files",
  parameters: { type: "object", properties: { fileId: { type: "string" }, folderId: { type: "string" } }, required: ["fileId"] },
  requiredPermissions: ["files"],
  async execute(parameters, context) {
    return moveFile(context.userId, parameters.fileId, parameters.folderId || null);
  },
});

registerTool({
  name: "copy_file",
  description: "Creates an independent copy of a file, optionally into a different folder.",
  category: "files",
  parameters: { type: "object", properties: { fileId: { type: "string" }, folderId: { type: "string" } }, required: ["fileId"] },
  requiredPermissions: ["files"],
  async execute(parameters, context) {
    return copyFile(context.userId, parameters.fileId, { folderId: parameters.folderId });
  },
});

registerTool({
  name: "rename_file",
  description: "Renames a file.",
  category: "files",
  parameters: { type: "object", properties: { fileId: { type: "string" }, filename: { type: "string" } }, required: ["fileId", "filename"] },
  requiredPermissions: ["files"],
  async execute(parameters, context) {
    return renameFile(context.userId, parameters.fileId, parameters.filename);
  },
});

registerTool({
  name: "delete_file",
  description: "Moves a file to Trash. Same as clicking Delete in the File Manager — it isn't permanently removed and can be restored.",
  category: "files",
  parameters: { type: "object", properties: { fileId: { type: "string" } }, required: ["fileId"] },
  requiredPermissions: ["files"],
  requiresConfirmation: true, // Even a soft (trash) delete needs explicit approval, same principle as delete_memory.
  async execute(parameters, context) {
    return trashFile(context.userId, parameters.fileId);
  },
});

registerTool({
  name: "create_folder",
  description: "Creates a new folder, optionally nested inside another folder.",
  category: "files",
  parameters: { type: "object", properties: { name: { type: "string" }, parentFolderId: { type: "string" } }, required: ["name"] },
  requiredPermissions: ["files"],
  async execute(parameters, context) {
    return createFolder({ userId: context.userId, name: parameters.name, parentFolderId: parameters.parentFolderId });
  },
});

registerTool({
  name: "share_file",
  description: "Creates a shareable link for a file. Use an expiresAt (ISO date) and/or password for sensitive files.",
  category: "files",
  parameters: {
    type: "object",
    properties: {
      fileId: { type: "string" },
      expiresAt: { type: "string", description: "ISO 8601 date; link stops working after this time" },
      password: { type: "string" },
    },
    required: ["fileId"],
  },
  requiredPermissions: ["files"],
  requiresConfirmation: true, // Sharing something outside the platform's own permission model is exactly the kind of action that must never happen without explicit approval.
  async execute(parameters, context) {
    const share = createShare(context.userId, parameters.fileId, { expiresAt: parameters.expiresAt, password: parameters.password });
    return { shareId: share.id, token: share.token, expiresAt: share.expiresAt, hasPassword: Boolean(share.passwordHash) };
  },
});

const SUMMARY_SYSTEM_PROMPT = `You summarize documents for a busy reader. Given a document's extracted
text, respond with ONLY a single JSON object, no other text, in this exact shape:
{"summary": "<3-6 sentence summary>", "keyPoints": ["<point>", ...]}
Base everything strictly on the provided text — never invent details that aren't in it.
Output raw JSON only — no markdown fences, no commentary.`;

function safeParseSummary(text) {
  const cleaned = text.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return { summary: text.trim(), keyPoints: [] };
  }
}

registerTool({
  name: "summarize_document",
  description: "Summarizes a file's extracted text content using AI. Only works for files with text extraction support (PDF, DOCX, TXT, CSV, XLSX) that have already been processed.",
  category: "files",
  parameters: { type: "object", properties: { fileId: { type: "string" } }, required: ["fileId"] },
  requiredPermissions: ["files"],
  // Goes through the EXACT SAME chatComplete() abstraction every other AI
  // tool in this codebase uses (see generateReport.js) — not a separate
  // document-AI path. Same known limitation those tools already have: this
  // doesn't thread through an agent's own provider/model choice or BYOK key,
  // matching generateReport.js's existing behavior rather than introducing
  // new plumbing just for this one tool.
  async execute(parameters, context) {
    const file = requireFileAccess(context.userId, parameters.fileId, "view");
    if (!file.textExtractionSupport || !file.extractedText) {
      const err = new Error(`"${file.filename}" doesn't have extracted text available to summarize (unsupported format, or nothing was extracted).`);
      err.code = "UNSUPPORTED";
      throw err;
    }
    const raw = (await chatComplete({
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: file.extractedText.slice(0, 30000) }],
    })).text;
    const result = safeParseSummary(raw);
    return { fileId: file.id, filename: file.filename, ...result };
  },
});
