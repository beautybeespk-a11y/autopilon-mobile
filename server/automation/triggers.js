import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { evaluateConditionGroups } from "./conditions.js";
import { enqueueExecution } from "./eventQueue.js";

const now = () => new Date().toISOString();

// The one function every event source calls — WhatsApp's webhook, a Meta
// tool completing, an internal action, an external webhook. None of them
// know anything about workflows; they just publish what happened and what
// variables it exposes. This function does everything else: dedup, match,
// filter, enqueue, log. No business logic belongs in the integrations
// themselves — it all lives here.
//
// eventId: pass the source's own id when it has one (a WhatsApp message id,
// a tool_executions id) so a redelivery collides on the (source, eventId)
// unique index and is silently skipped, exactly like Phase 5's dedup did
// for WhatsApp alone. If the source has no natural id (an internal event
// like "task created"), a random one is fine — there's nothing to redeliver.
export function publishEvent(userId, source, eventType, payload = {}, eventId = cryptoRandom()) {
  const id = cryptoRandom();
  try {
    db.prepare(
      "INSERT INTO automation_events (id, userId, source, eventType, eventId, payload, matchedAutomations, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, '[]', 'received', ?)"
    ).run(id, userId, source, eventType, eventId, JSON.stringify(payload), now());
  } catch {
    return { duplicate: true }; // (source, eventId) collision — already processed, skip silently
  }

  const automations = db.prepare(
    "SELECT * FROM automations WHERE userId = ? AND triggerType = ? AND status = 'active'"
  ).all(userId, eventType);

  const matched = [];
  for (const automation of automations) {
    const config = JSON.parse(automation.triggerConfig || "{}");
    const passesFilter = !config.filter || evaluateConditionGroups(config.filter, payload);
    if (!passesFilter) continue;
    enqueueExecution({ eventId: id, automationId: automation.id, userId });
    matched.push(automation.id);
  }

  db.prepare("UPDATE automation_events SET matchedAutomations = ?, status = ? WHERE id = ?")
    .run(JSON.stringify(matched), matched.length ? "queued" : "received", id);

  return { eventId: id, matched };
}

// Kept for backward compatibility with anywhere still calling the Phase 6
// name directly — same behavior, just the event-driven name going forward.
export const fireTrigger = (userId, triggerType, context) => publishEvent(userId, "internal", triggerType, context);

export function recentEvents(userId, limit = 20) {
  const rows = db.prepare("SELECT * FROM automation_events WHERE userId = ? ORDER BY createdAt DESC LIMIT ?").all(userId, limit);
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload || "{}"), matchedAutomations: JSON.parse(r.matchedAutomations || "[]") }));
}

export function eventSourceStats(userId) {
  return db.prepare(
    "SELECT source, COUNT(*) c FROM automation_events WHERE userId = ? GROUP BY source ORDER BY c DESC"
  ).all(userId);
}
