import { Router } from "express";
import db from "../db.js";
import { requireAuth } from "../middleware.js";
import { resumeAfterConfirmation } from "../orchestrator/executor.js";
import { resumeRunAfterApproval } from "../automation/runner.js";

const router = Router();
router.use(requireAuth);

function loadOwnedConfirmation(id, userId) {
  return db.prepare("SELECT * FROM confirmation_requests WHERE id = ? AND userId = ?").get(id, userId);
}

// Lists everything currently waiting on the user's yes/no — both chat-
// initiated confirmations and ones that came from a workflow run (which
// don't appear in any chat conversation, since they weren't created there).
router.get("/pending", (req, res) => {
  const rows = db.prepare(
    `SELECT c.*, r.automationId, a.name AS automationName
     FROM confirmation_requests c
     LEFT JOIN automation_runs r ON r.id = c.automationRunId
     LEFT JOIN automations a ON a.id = r.automationId
     WHERE c.userId = ? AND c.status = 'pending'
     ORDER BY c.createdAt DESC`
  ).all(req.session.userId);
  res.json(rows);
});

router.post("/:id/approve", async (req, res) => resolve(req, res, true));
router.post("/:id/reject", async (req, res) => resolve(req, res, false));

async function resolve(req, res, approved) {
  const confirmation = loadOwnedConfirmation(req.params.id, req.session.userId);
  if (!confirmation) return res.status(404).json({ error: "Confirmation not found" });
  if (confirmation.status !== "pending") {
    return res.status(409).json({ error: `This confirmation was already ${confirmation.status}.` });
  }
  if (new Date(confirmation.expiresAt) < new Date()) {
    db.prepare("UPDATE confirmation_requests SET status = 'expired', resolvedAt = ? WHERE id = ?").run(new Date().toISOString(), confirmation.id);
    // An expired confirmation must not leave its workflow run stuck at
    // "awaiting_approval" forever — there's no other path back to it once
    // it's expired, since it also drops out of the /pending list.
    if (confirmation.automationRunId) {
      db.prepare("UPDATE automation_runs SET status = 'failed', error = 'Approval expired before it was resolved (15-minute window)', endedAt = ? WHERE id = ? AND status = 'awaiting_approval'")
        .run(new Date().toISOString(), confirmation.automationRunId);
    }
    return res.status(410).json({ error: "This confirmation has expired. Run the workflow again to get a fresh approval window." });
  }

  db.prepare("UPDATE confirmation_requests SET status = ?, resolvedAt = ? WHERE id = ?")
    .run(approved ? "approved" : "rejected", new Date().toISOString(), confirmation.id);

  try {
    const outcome = await resumeAfterConfirmation({ executionId: confirmation.executionId, approved });
    if (confirmation.automationRunId) {
      // Fire-and-forget — the run continues in the background; the caller
      // (chat confirmation UI) doesn't need to wait on the rest of the workflow.
      resumeRunAfterApproval(confirmation.automationRunId, approved).catch((err) =>
        console.error("Automation resume error:", err.message)
      );
    }
    res.json({ confirmationId: confirmation.id, ...outcome });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Called on an interval (see index.js) to catch confirmations nobody ever
// acted on — without this, a workflow run whose approval step is simply
// ignored would stay "awaiting_approval" forever, since expiry was
// otherwise only detected lazily when someone tried to approve/reject it.
export function sweepExpiredConfirmations() {
  const now = new Date().toISOString();
  const expired = db.prepare(
    "SELECT * FROM confirmation_requests WHERE status = 'pending' AND expiresAt < ?"
  ).all(now);
  for (const confirmation of expired) {
    db.prepare("UPDATE confirmation_requests SET status = 'expired', resolvedAt = ? WHERE id = ?").run(now, confirmation.id);
    if (confirmation.automationRunId) {
      db.prepare("UPDATE automation_runs SET status = 'failed', error = 'Approval expired before it was resolved (15-minute window)', endedAt = ? WHERE id = ? AND status = 'awaiting_approval'")
        .run(now, confirmation.automationRunId);
    }
  }
}

export default router;
