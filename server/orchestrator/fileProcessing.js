import fs from "fs";
// Named imports, not `import * as XLSX` — xlsx's ESM interop doesn't expose
// readFile() as a named export (only via its default), but read()/utils()
// work cleanly as named imports and avoid the whole default-export
// ambiguity by working off an in-memory buffer instead of a file path.
import { read as readWorkbook, utils as sheetUtils } from "xlsx";
import { extractTextFromFile, isImageFile } from "../tools/research/documentExtract.js";

// Spec §3: don't assume every format is automatically AI-readable — track
// preview/text-extraction/AI-analysis support per extension instead. This
// is the single source of truth both the processing pipeline and the file
// detail UI read from.
export const EXTENSION_CAPABILITIES = {
  pdf: { preview: true, textExtraction: true, aiAnalysis: true },
  doc: { preview: false, textExtraction: false, aiAnalysis: false }, // legacy binary format — mammoth only reads .docx
  docx: { preview: false, textExtraction: true, aiAnalysis: true },
  txt: { preview: true, textExtraction: true, aiAnalysis: true },
  md: { preview: true, textExtraction: true, aiAnalysis: true },
  csv: { preview: true, textExtraction: true, aiAnalysis: true },
  xls: { preview: false, textExtraction: true, aiAnalysis: true },
  xlsx: { preview: false, textExtraction: true, aiAnalysis: true },
  ppt: { preview: false, textExtraction: false, aiAnalysis: false }, // no pptx/ppt parser wired up yet
  pptx: { preview: false, textExtraction: false, aiAnalysis: false },
  jpg: { preview: true, textExtraction: false, aiAnalysis: true },
  jpeg: { preview: true, textExtraction: false, aiAnalysis: true },
  png: { preview: true, textExtraction: false, aiAnalysis: true },
  webp: { preview: true, textExtraction: false, aiAnalysis: true },
  gif: { preview: true, textExtraction: false, aiAnalysis: true },
  svg: { preview: true, textExtraction: false, aiAnalysis: false }, // XML text, not a raster the vision providers accept
  mp3: { preview: true, textExtraction: false, aiAnalysis: false },
  wav: { preview: true, textExtraction: false, aiAnalysis: false },
  m4a: { preview: true, textExtraction: false, aiAnalysis: false },
  mp4: { preview: true, textExtraction: false, aiAnalysis: false },
  mov: { preview: false, textExtraction: false, aiAnalysis: false }, // not broadly browser-playable
  zip: { preview: false, textExtraction: false, aiAnalysis: false },
};

export function capabilitiesFor(extension) {
  return EXTENSION_CAPABILITIES[(extension || "").toLowerCase()] || { preview: false, textExtraction: false, aiAnalysis: false };
}

// Cap stored extractedText so one huge document doesn't blow up a SQLite
// row — same reasoning as MAX_ATTACHMENT_CHARS in conversationService.js,
// just a larger budget since this is the searchable record, not a per-turn
// prompt injection.
const MAX_EXTRACT_CHARS = 200_000;

function extractSpreadsheet(filePath) {
  const workbook = readWorkbook(fs.readFileSync(filePath), { type: "buffer" });
  return workbook.SheetNames
    .map((name) => `--- Sheet: ${name} ---\n${sheetUtils.sheet_to_csv(workbook.Sheets[name])}`)
    .join("\n\n")
    .trim();
}

/**
 * Runs synchronously, in-process, as part of the upload request — this
 * codebase has no durable background job queue yet (automation's
 * eventQueue.js is the closest thing, and it's scoped to automation runs,
 * not general file processing). Documented limitation for this pass: a
 * very large file's extraction blocks its own upload request a little
 * longer; it does not block other requests since Node's event loop still
 * yields on the file I/O. A future phase moving this behind a real queue
 * wouldn't need to change this function's signature.
 */
export async function processFile({ filePath, filename, mimeType, extension }) {
  const caps = capabilitiesFor(extension);
  const aiAnalysisSupport = caps.aiAnalysis || isImageFile(filename, mimeType);

  const result = {
    previewSupport: caps.preview,
    textExtractionSupport: caps.textExtraction,
    aiAnalysisSupport,
    extractedText: null,
    processingStatus: "ready",
    processingError: null,
    aiProcessingStatus: aiAnalysisSupport ? "ready" : "unsupported",
  };

  if (!caps.textExtraction) return result;

  try {
    const ext = (extension || "").toLowerCase();
    if (ext === "xlsx" || ext === "xls") {
      const text = extractSpreadsheet(filePath);
      result.extractedText = text ? text.slice(0, MAX_EXTRACT_CHARS) : null;
    } else {
      const { text, note } = await extractTextFromFile(filePath, filename, mimeType);
      result.extractedText = text ? text.slice(0, MAX_EXTRACT_CHARS) : null;
      if (!text && note) result.processingError = note;
    }
  } catch (err) {
    result.processingStatus = "failed";
    result.processingError = err.message;
  }

  return result;
}
