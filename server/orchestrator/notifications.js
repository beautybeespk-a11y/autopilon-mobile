import db from "../db.js";
import { cryptoRandom } from "../middleware.js";

const now = () => new Date().toISOString();

export function createNotification(userId, { type, title, body, link }) {
  const id = cryptoRandom();
  db.prepare("INSERT INTO notifications (id, userId, type, title, body, link, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, type, title, body || null, link || null, now());
  return id;
}

export function listNotifications(userId, { unreadOnly = false, limit = 30 } = {}) {
  const clause = unreadOnly ? "AND read = 0" : "";
  return db.prepare(`SELECT * FROM notifications WHERE userId = ? ${clause} ORDER BY createdAt DESC LIMIT ?`).all(userId, limit);
}

export function unreadCount(userId) {
  return db.prepare("SELECT COUNT(*) c FROM notifications WHERE userId = ? AND read = 0").get(userId).c;
}

export function markRead(userId, id) {
  db.prepare("UPDATE notifications SET read = 1 WHERE id = ? AND userId = ?").run(id, userId);
  return { read: true };
}

export function markAllRead(userId) {
  db.prepare("UPDATE notifications SET read = 1 WHERE userId = ? AND read = 0").run(userId);
  return { read: true };
}
