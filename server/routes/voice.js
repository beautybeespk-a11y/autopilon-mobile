import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";
import { sttStatus, ttsStatus, listVoices, transcribeAudio, synthesizeSpeech } from "../ai/speech.js";
import { recordVoiceUsage, TTS_CENTS_PER_CHAR } from "../orchestrator/voiceUsage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "voice");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Generous for a voice message (a few minutes of compressed audio), tiny
// next to the 15MB document/image cap in research.js.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: MAX_UPLOAD_BYTES } });

// Rough estimates for the usage dashboard/audit trail — not what OpenAI
// actually bills the org (that depends on their own OpenAI account), just
// enough for the platform to show a directionally-correct cost figure per
// spec's "Estimated Cost" usage field. Whisper: $0.006/min. TTS (tts-1): $15
// per 1M characters.
const STT_CENTS_PER_SECOND = 0.6 / 60;

const router = Router();
router.use(requireAuth);

router.get("/status", (req, res) => {
  res.json({ stt: sttStatus(), tts: ttsStatus(), voices: listVoices() });
});

function defaultSettings(userId) {
  return {
    userId, voice: "alloy", language: null, speed: 1.0, volume: 1.0,
    autoPlay: true, voiceMode: "tap", captions: true,
  };
}

function rowToSettings(row) {
  if (!row) return null;
  return {
    voice: row.voice, language: row.language, speed: row.speed, volume: row.volume,
    autoPlay: Boolean(row.autoPlay), voiceMode: row.voiceMode, captions: Boolean(row.captions),
  };
}

router.get("/settings", (req, res) => {
  const row = db.prepare("SELECT * FROM voice_settings WHERE userId = ?").get(req.session.userId);
  res.json(rowToSettings(row) || rowToSettings({ ...defaultSettings(req.session.userId), autoPlay: 1, captions: 1 }));
});

router.patch("/settings", (req, res) => {
  const userId = req.session.userId;
  const { voice, language, speed, volume, autoPlay, voiceMode, captions } = req.body || {};
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT userId FROM voice_settings WHERE userId = ?").get(userId);
  const current = rowToSettings(db.prepare("SELECT * FROM voice_settings WHERE userId = ?").get(userId)) || {
    voice: "alloy", language: null, speed: 1.0, volume: 1.0, autoPlay: true, voiceMode: "tap", captions: true,
  };
  const next = {
    voice: voice ?? current.voice,
    language: language === undefined ? current.language : language,
    speed: speed ?? current.speed,
    volume: volume ?? current.volume,
    autoPlay: autoPlay ?? current.autoPlay,
    voiceMode: voiceMode ?? current.voiceMode,
    captions: captions ?? current.captions,
  };
  if (existing) {
    db.prepare(
      `UPDATE voice_settings SET voice = ?, language = ?, speed = ?, volume = ?, autoPlay = ?, voiceMode = ?, captions = ?, updatedAt = ? WHERE userId = ?`
    ).run(next.voice, next.language, next.speed, next.volume, next.autoPlay ? 1 : 0, next.voiceMode, next.captions ? 1 : 0, now, userId);
  } else {
    db.prepare(
      `INSERT INTO voice_settings (userId, voice, language, speed, volume, autoPlay, voiceMode, captions, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(userId, next.voice, next.language, next.speed, next.volume, next.autoPlay ? 1 : 0, next.voiceMode, next.captions ? 1 : 0, now);
  }
  res.json(next);
});

// Speech in, text out. The client is expected to show the transcript as an
// editable preview and only THEN send it through the ordinary POST
// /chat/message — this endpoint never talks to the AI Orchestrator itself,
// so a voice message goes through exactly the same permission/approval/
// quota/audit path as anything typed, just with an STT step in front of it.
router.post("/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No audio uploaded." });
  const { language, agentId, conversationId } = req.body || {};
  const filePath = req.file.path;
  try {
    const result = await transcribeAudio({
      filePath, filename: req.file.originalname, mimeType: req.file.mimetype, language: language || undefined,
    });
    recordVoiceUsage({
      userId: req.session.userId, kind: "stt", provider: result.provider,
      durationSeconds: result.durationSeconds, estimatedCostCents: (result.durationSeconds || 0) * STT_CENTS_PER_SECOND,
      agentId, conversationId,
    });
    logActivity(db, req.session.userId, "voice_transcribed", `Transcribed a ${Math.round(result.durationSeconds || 0)}s voice message`, { req });
    res.json({ text: result.text, language: result.language, durationSeconds: result.durationSeconds });
  } catch (err) {
    console.error("[voice/transcribe] error:", err);
    if (err.code === "PROVIDER_NOT_CONFIGURED") {
      return res.status(503).json({ error: "Speech-to-text is not configured", detail: err.detail });
    }
    res.status(502).json({ error: "Speech-to-text failed", detail: err.message });
  } finally {
    // No persistent voice-message storage in this pass (Phase 13 §11
    // deliberately defers a real file-storage subsystem to Phase 14) — the
    // raw audio only ever needs to exist long enough to run STT on it.
    fs.unlink(filePath, () => {});
  }
});

// Text in, speech out — called separately by the client with whatever text
// it wants spoken (typically the AI's own reply that already came back from
// POST /chat/message), so this never needs to know about conversations,
// tools, or permissions at all.
router.post("/speak", async (req, res) => {
  const { text, voice, speed, agentId, conversationId } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: "text is required." });
  if (text.length > 4000) return res.status(400).json({ error: "Text is too long to speak in one request (max 4000 characters)." });
  try {
    const result = await synthesizeSpeech({ text, voice, speed });
    recordVoiceUsage({
      userId: req.session.userId, kind: "tts", provider: result.provider,
      characters: text.length, estimatedCostCents: text.length * TTS_CENTS_PER_CHAR,
      agentId, conversationId,
    });
    res.set("Content-Type", result.mimeType);
    res.send(result.audio);
  } catch (err) {
    console.error("[voice/speak] error:", err);
    if (err.code === "PROVIDER_NOT_CONFIGURED") {
      return res.status(503).json({ error: "Text-to-speech is not configured", detail: err.detail });
    }
    res.status(502).json({ error: "Text-to-speech failed", detail: err.message });
  }
});

export default router;
