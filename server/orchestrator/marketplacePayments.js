import db from "../db.js";

export function hasPurchased(userId, assetId) {
  return Boolean(db.prepare("SELECT 1 FROM asset_purchases WHERE buyerUserId = ? AND assetId = ? AND status = 'completed'").get(userId, assetId));
}

export function listMyPurchases(userId) {
  return db.prepare(
    `SELECT ap.*, ma.name AS assetName, ma.assetType FROM asset_purchases ap
     JOIN marketplace_assets ma ON ma.id = ap.assetId
     WHERE ap.buyerUserId = ? ORDER BY ap.createdAt DESC`
  ).all(userId);
}

export function getSellerRevenue(userId) {
  const totals = db.prepare(
    "SELECT COALESCE(SUM(sellerNetCents), 0) net, COALESCE(SUM(amountCents), 0) gross, COUNT(*) c FROM asset_purchases WHERE sellerUserId = ? AND status = 'completed'"
  ).get(userId);
  return { netCents: totals.net, grossCents: totals.gross, saleCount: totals.c };
}
