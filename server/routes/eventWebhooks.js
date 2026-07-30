import { Router } from "express";
import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { evaluateConditionGroups } from "../automation/conditions.js";
import { enqueueExecution } from "../automation/eventQueue.js";

const router = Router();

// Intentionally NOT behind requireAuth — external apps have no session here.
// Authentication is the per-automation secret instead, checked below.
router.post("/webhook/:automationId", (req, res) => {
  const automation = db.prepare(
    "SELECT * FROM automations WHERE id = ? AND triggerType = 'webhook' AND status = 'active'"
  ).get(req.params.automationId);
  if (!automation) return res.status(404).json({ error: "No active webhook automation with this ID." });

  const config = JSON.parse(automation.triggerConfig || "{}");
  const providedSecret = req.get("x-webhook-secret") || req.query.secret;
  if (!config.secret || providedSecret !== config.secret) {
    return res.status(401).json({ error: "Invalid or missing webhook secret." });
  }

  const payload = req.body || {};
  // Replay protection: an external caller can supply their own event id via
  // this header (e.g. Stripe/GitHub-style delivery ids); without one, every
  // call is treated as distinct — there's nothing to dedupe against.
  const eventId = req.get("x-event-id") || cryptoRandom();

  const eventRowId = cryptoRandom();
  try {
    db.prepare(
      "INSERT INTO automation_events (id, userId, source, eventType, eventId, payload, matchedAutomations, status, createdAt) VALUES (?, ?, 'webhook', 'webhook', ?, ?, '[]', 'received', ?)"
    ).run(eventRowId, automation.userId, eventId, JSON.stringify(payload), new Date().toISOString());
  } catch {
    return res.json({ ok: true, duplicate: true }); // (source, eventId) collision — already processed
  }

  const passesFilter = !config.filter || evaluateConditionGroups(config.filter, payload);
  if (passesFilter) {
    enqueueExecution({ eventId: eventRowId, automationId: automation.id, userId: automation.userId });
    db.prepare("UPDATE automation_events SET matchedAutomations = ?, status = 'queued' WHERE id = ?")
      .run(JSON.stringify([automation.id]), eventRowId);
  }

  res.json({ ok: true, matched: passesFilter });
});

export default router;
