import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { runWorkflow } from "./runner.js";

const MAX_ATTEMPTS = 3;
const now = () => new Date().toISOString();

export function enqueueExecution({ eventId, automationId, userId }) {
  const id = cryptoRandom();
  db.prepare(
    "INSERT INTO automation_event_queue (id, eventId, automationId, userId, status, attempts, createdAt) VALUES (?, ?, ?, ?, 'queued', 0, ?)"
  ).run(id, eventId, automationId, userId, now());
  return id;
}

// Processes one batch of queued jobs. Called on an interval — see
// initializeQueueProcessor(). Kept small and synchronous-ish per job so a
// slow workflow doesn't block the whole tick from finishing.
export async function processQueueTick(batchSize = 5) {
  const jobs = db.prepare(
    "SELECT * FROM automation_event_queue WHERE status = 'queued' ORDER BY createdAt ASC LIMIT ?"
  ).all(batchSize);

  for (const job of jobs) {
    db.prepare("UPDATE automation_event_queue SET status = 'processing', attempts = attempts + 1 WHERE id = ?").run(job.id);

    const event = db.prepare("SELECT * FROM automation_events WHERE id = ?").get(job.eventId);
    const payload = event ? JSON.parse(event.payload || "{}") : {};

    try {
      const result = await runWorkflow(job.automationId, {
        userId: job.userId,
        triggerSource: event?.source || "event",
        initialVariables: payload,
      });
      if (result.status === "failed") throw new Error(result.error || "Workflow run failed");
      db.prepare("UPDATE automation_event_queue SET status = 'completed', processedAt = ? WHERE id = ?").run(now(), job.id);
    } catch (err) {
      const attempts = job.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        db.prepare("UPDATE automation_event_queue SET status = 'dead_letter', lastError = ?, processedAt = ? WHERE id = ?")
          .run(err.message, now(), job.id);
      } else {
        // Left as 'queued' (not 'processing') so the next tick retries it.
        db.prepare("UPDATE automation_event_queue SET status = 'queued', lastError = ? WHERE id = ?").run(err.message, job.id);
      }
    }
  }
}

let intervalHandle = null;
export function initializeQueueProcessor(intervalMs = 3000) {
  if (intervalHandle) return; // idempotent — don't stack multiple tickers on hot-reload
  intervalHandle = setInterval(() => {
    processQueueTick().catch((err) => console.error("Queue tick error:", err.message));
  }, intervalMs);
}

export function queueHealth(userId) {
  const counts = db.prepare(
    "SELECT status, COUNT(*) c FROM automation_event_queue WHERE userId = ? GROUP BY status"
  ).all(userId);
  const byStatus = Object.fromEntries(counts.map((r) => [r.status, r.c]));
  return {
    queued: byStatus.queued || 0,
    processing: byStatus.processing || 0,
    completed: byStatus.completed || 0,
    failed: byStatus.failed || 0,
    deadLetter: byStatus.dead_letter || 0,
  };
}
