import cron from "node-cron";
import db from "../db.js";

// Frequency presets translate to standard cron expressions; a raw
// expression is used as-is when frequency === "cron".
function toCronExpression(config = {}) {
  const hour = config.hour ?? 9;
  const minute = config.minute ?? 0;
  switch (config.frequency) {
    case "every_minute": return "* * * * *";
    case "hourly": return `${minute} * * * *`;
    case "daily": return `${minute} ${hour} * * *`;
    case "weekly": return `${minute} ${hour} * * ${config.dayOfWeek ?? 1}`;
    case "monthly": return `${minute} ${hour} ${config.dayOfMonth ?? 1} * *`;
    case "cron": return config.cron;
    default: return `${minute} ${hour} * * *`; // default: daily at 9am
  }
}

// A rough but real "next run" estimate, used for the dashboard's "Upcoming
// Schedules" and for missed-execution recovery on boot — not a full cron
// parser, just enough to know roughly when the next tick lands.
export function computeNextRun(config = {}) {
  const now = new Date();
  const next = new Date(now);
  const hour = config.hour ?? 9;
  const minute = config.minute ?? 0;

  switch (config.frequency) {
    case "every_minute":
      next.setSeconds(0, 0);
      next.setMinutes(next.getMinutes() + 1);
      return next.toISOString();
    case "hourly":
      next.setMinutes(minute, 0, 0);
      if (next <= now) next.setHours(next.getHours() + 1);
      return next.toISOString();
    case "weekly": {
      next.setHours(hour, minute, 0, 0);
      const targetDay = config.dayOfWeek ?? 1;
      while (next.getDay() !== targetDay || next <= now) next.setDate(next.getDate() + 1);
      return next.toISOString();
    }
    case "monthly": {
      next.setDate(config.dayOfMonth ?? 1);
      next.setHours(hour, minute, 0, 0);
      if (next <= now) next.setMonth(next.getMonth() + 1);
      return next.toISOString();
    }
    case "cron":
      return null; // arbitrary cron expressions aren't estimated here — node-cron still runs them correctly
    case "daily":
    default:
      next.setHours(hour, minute, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      return next.toISOString();
  }
}

const scheduledJobs = new Map(); // automationId -> node-cron task

export function registerSchedule(automation, onFire) {
  unregisterSchedule(automation.id);
  const config = JSON.parse(automation.triggerConfig || "{}");
  const expression = toCronExpression(config);
  if (!cron.validate(expression)) {
    console.error(`Invalid cron expression for automation ${automation.id}: "${expression}"`);
    return;
  }
  const task = cron.schedule(expression, () => onFire(automation.id), {
    timezone: config.timezone || undefined,
  });
  scheduledJobs.set(automation.id, task);
}

export function unregisterSchedule(automationId) {
  const existing = scheduledJobs.get(automationId);
  if (existing) {
    existing.stop();
    scheduledJobs.delete(automationId);
  }
}

// Re-registers every active scheduled automation on server boot, and fires
// an immediate catch-up run for any whose computed next-run time has
// already passed — a simple, honest version of "missed execution recovery"
// rather than a full persistent job queue.
export function initializeSchedulesOnBoot(onFire) {
  const automations = db.prepare("SELECT * FROM automations WHERE status = 'active' AND triggerType = 'schedule'").all();
  const now = new Date();
  for (const automation of automations) {
    registerSchedule(automation, onFire);
    if (automation.nextRunAt && new Date(automation.nextRunAt) < now) {
      onFire(automation.id).catch((err) => console.error(`Missed-run catch-up failed for ${automation.id}:`, err.message));
    }
  }
}
