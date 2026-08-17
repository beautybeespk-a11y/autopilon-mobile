// The Public API v1 router (Phase 17 §1) — a dedicated layer, mounted
// separately from routes/ (internal, session-authenticated) and
// routes/platformAdmin.js (admin-only). Nothing internal is exposed here
// directly: every sub-router under this one is purpose-built for external
// developers, going through requireApiKey + requireScope + apiRateLimit,
// never the session-based requireAuth the rest of the app uses.
//
// v2 preparation (§30): resource sub-routers live in their own files
// (agents.js, automations.js, ...) exporting a factory, not inline here,
// specifically so a future /api/v2 mount can reuse or override individual
// resource routers without duplicating this file's cross-cutting setup.
import { Router } from "express";
import { requestId } from "./requestId.js";
import { requestLog } from "./requestLog.js";
import agentsRouter from "./agents.js";
import runsRouter from "./runs.js";

const router = Router();

router.use(requestId);
router.use(requestLog);

router.use("/agents", agentsRouter);
router.use("/runs", runsRouter);

// Unauthenticated root — lets a developer confirm the API is reachable and
// which version they're on before ever needing a key, same reasoning as
// /api/health/live staying public.
router.get("/", (req, res) => {
  res.json({
    name: "Autopilon Public API",
    version: "v1",
    status: "beta",
    documentation: "https://github.com/beautybeespk-a11y/autopilon-mobile/blob/main/PUBLIC_API.md",
  });
});

export default router;
