// Deliberately NOT behind requireAuth — a share link's whole point is
// working for someone without an Autopilon account. Every safety property
// (expiry, revocation, password) is enforced inside fileShare.js itself,
// not by this route.
import { Router } from "express";
import { getShareInfo, resolveShare } from "../orchestrator/fileShare.js";
import { getStorageProvider } from "../storage/provider.js";

const router = Router();

const ERROR_STATUS = { NOT_FOUND: 404, REVOKED: 410, EXPIRED: 410, PASSWORD_REQUIRED: 401, WRONG_PASSWORD: 401 };

router.get("/:token", (req, res) => {
  const info = getShareInfo(req.params.token);
  if (!info.valid) return res.status(404).json({ error: "This link is invalid, expired, or has been revoked." });
  res.json(info);
});

// POST rather than GET so a password never lands in a URL, server log, or
// browser history.
router.post("/:token/content", async (req, res) => {
  try {
    const { file } = resolveShare(req.params.token, { password: req.body?.password });
    const provider = getStorageProvider(file.storageProvider);
    const buffer = await provider.download({ key: file.storageKey });
    res.set("Content-Type", file.mimeType || "application/octet-stream");
    res.set("Content-Disposition", `attachment; filename="${encodeURIComponent(file.filename)}"`);
    res.send(buffer);
  } catch (err) {
    res.status(ERROR_STATUS[err.code] || 500).json({ error: err.message });
  }
});

export default router;
