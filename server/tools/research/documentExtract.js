import fs from "fs";
import { createRequire } from "module";
import mammoth from "mammoth";

// pdf-parse is a CommonJS package whose default export isn't always
// detected cleanly through Node's ESM/CJS interop — createRequire sidesteps
// that entirely by loading it exactly as CommonJS would.
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

// Plain-text-ish formats we can just read directly.
const PLAIN_TEXT_EXTENSIONS = new Set(["txt", "md", "csv", "json", "log"]);

function extOf(filename) {
  const i = filename.lastIndexOf(".");
  return i === -1 ? "" : filename.slice(i + 1).toLowerCase();
}

/**
 * Extracts readable text from an uploaded file so it can be stored in a
 * knowledge_items row and picked up by the existing search_knowledge tool
 * (which does a LIKE search over the `content` column). Returns
 * { text, note } — `text` is empty and `note` explains why when a format
 * isn't supported, rather than throwing and failing the whole upload.
 */
export async function extractTextFromFile(filePath, originalFilename, mimeType) {
  const ext = extOf(originalFilename);

  try {
    if (ext === "pdf" || mimeType === "application/pdf") {
      const buffer = fs.readFileSync(filePath);
      const parsed = await pdfParse(buffer);
      const text = (parsed.text || "").trim();
      return text
        ? { text, note: null }
        : { text: "", note: "This PDF appears to have no extractable text (it may be a scanned image)." };
    }

    if (
      ext === "docx" ||
      mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const result = await mammoth.extractRawText({ path: filePath });
      const text = (result.value || "").trim();
      return text ? { text, note: null } : { text: "", note: "No text could be extracted from this document." };
    }

    if (PLAIN_TEXT_EXTENSIONS.has(ext) || (mimeType || "").startsWith("text/")) {
      const text = fs.readFileSync(filePath, "utf8").trim();
      return { text, note: null };
    }

    // .doc (legacy binary Word), images, spreadsheets, etc. — stored and
    // downloadable, but not text-searchable yet.
    return { text: "", note: `Text extraction isn't supported yet for .${ext || "this"} files — the file is saved, but its contents won't be searchable by agents.` };
  } catch (err) {
    return { text: "", note: `Couldn't extract text from this file: ${err.message}` };
  }
}
