import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { createAgent, setAgentStatus, updateAgent } from "./agentManager.js";
import { createAutomation, setAutomationStatus, updateAutomation } from "../automation/engine.js";
import { getAsset } from "./marketplace.js";
import { hasPurchased } from "./marketplacePayments.js";

const now = () => new Date().toISOString();

function versionById(assetId, versionId) {
  const row = db.prepare("SELECT * FROM asset_versions WHERE id = ? AND assetId = ?").get(versionId, assetId);
  if (!row) throw new Error("Version not found.");
  return { ...row, manifest: JSON.parse(row.manifest) };
}

// Creates the real entity a manifest describes. Installs are always
// personal (orgId null) — an installer can move the result into an
// organization afterward through the normal edit UI, same as any agent or
// automation they'd built by hand. This keeps "which org?" out of the
// install flow entirely rather than guessing.
function materialize(userId, assetType, manifest, name, description) {
  if (assetType === "agent") {
    const agent = createAgent(userId, {
      name, description, instructions: manifest.instructions, personality: manifest.personality,
      category: manifest.category, aiProvider: manifest.aiProvider, aiModel: manifest.aiModel, skillIds: manifest.skillIds || [],
    });
    return { entityType: "agent", entityIds: [agent.id] };
  }
  if (assetType === "automation") {
    const id = createAutomation(userId, {
      name, description, triggerType: manifest.triggerType, triggerConfig: manifest.triggerConfig,
      variables: manifest.variables, steps: manifest.steps, status: "draft", // never auto-activates a stranger's automation
    });
    return { entityType: "automation", entityIds: [id] };
  }
  if (assetType === "prompt") {
    const id = cryptoRandom();
    db.prepare(
      "INSERT INTO knowledge_items (id, userId, type, title, category, tags, content, sourceUrls, visibility, editable, crossUserVisibility, crossUserEditable, createdAt) VALUES (?, ?, 'note', ?, 'prompt', '[]', ?, '[]', 'shared', 'editable', 'private', 'read_only', ?)"
    ).run(id, userId, name, JSON.stringify({ note: manifest.promptText }), now());
    return { entityType: "knowledge_item", entityIds: [id] };
  }
  if (assetType === "knowledge_pack") {
    const ids = (manifest.items || []).map((item) => {
      const id = cryptoRandom();
      db.prepare(
        "INSERT INTO knowledge_items (id, userId, type, title, category, tags, content, sourceUrls, visibility, editable, crossUserVisibility, crossUserEditable, createdAt) VALUES (?, ?, 'note', ?, ?, ?, ?, '[]', 'shared', 'editable', 'private', 'read_only', ?)"
      ).run(id, userId, item.title, item.category || "imported", JSON.stringify(item.tags || []), JSON.stringify(item.content), now());
      return id;
    });
    return { entityType: "knowledge_item", entityIds: ids };
  }
  throw new Error(`Don't know how to install asset type "${assetType}".`);
}

export function installAsset(userId, assetId) {
  const asset = getAsset(userId, assetId);
  if (!asset || !asset.latestVersion) throw new Error("Asset not found or has no published version.");
  if (asset.pricingType !== "free" && asset.creatorUserId !== userId && !hasPurchased(userId, assetId)) {
    const err = new Error(`This is a paid asset ($${(asset.priceCents / 100).toFixed(2)}) — purchase it first.`);
    err.code = "PURCHASE_REQUIRED";
    throw err;
  }
  const { entityType, entityIds } = materialize(userId, asset.assetType, asset.latestVersion.manifest, asset.name, asset.description);

  const id = cryptoRandom();
  db.prepare(
    `INSERT INTO marketplace_installs (id, assetId, installedVersionId, installedByUserId, installedEntityType, installedEntityIds, status, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  ).run(id, assetId, asset.latestVersion.id, userId, entityType, JSON.stringify(entityIds), now(), now());
  db.prepare("UPDATE marketplace_assets SET downloadCount = downloadCount + 1 WHERE id = ?").run(assetId);

  const missingNote = asset.assetType === "agent" && asset.latestVersion.manifest.requiredSkills?.length
    ? `This agent expects these skills enabled: ${asset.latestVersion.manifest.requiredSkills.join(", ")}. Enable them on its edit page if they aren't already.`
    : null;

  return { installId: id, entityType, entityIds, dependencyNote: missingNote };
}

export function listMyInstalls(userId) {
  return db.prepare(
    `SELECT mi.*, ma.name AS assetName, ma.assetType, av.version AS installedVersion,
            (SELECT version FROM asset_versions WHERE assetId = ma.id ORDER BY createdAt DESC LIMIT 1) AS latestVersion
     FROM marketplace_installs mi
     JOIN marketplace_assets ma ON ma.id = mi.assetId
     JOIN asset_versions av ON av.id = mi.installedVersionId
     WHERE mi.installedByUserId = ? ORDER BY mi.createdAt DESC`
  ).all(userId).map((r) => ({ ...r, entityIds: JSON.parse(r.installedEntityIds) }));
}

function loadInstall(userId, installId) {
  const install = db.prepare("SELECT * FROM marketplace_installs WHERE id = ? AND installedByUserId = ?").get(installId, userId);
  if (!install) throw new Error("Install not found.");
  return { ...install, entityIds: JSON.parse(install.installedEntityIds) };
}

// Re-applies a version's manifest onto the ALREADY-installed entity —
// updateAgent/updateAutomation are the exact same functions used for any
// normal edit, so an update behaves identically to the installer hand-
// editing their agent/automation to match the new version.
function applyVersion(userId, install, manifest) {
  if (install.installedEntityType === "agent") {
    updateAgent(userId, install.entityIds[0], {
      instructions: manifest.instructions, personality: manifest.personality,
      aiProvider: manifest.aiProvider, aiModel: manifest.aiModel, skillIds: manifest.skillIds || [],
    }, "Updated from marketplace");
  } else if (install.installedEntityType === "automation") {
    updateAutomation(userId, install.entityIds[0], {
      triggerType: manifest.triggerType, triggerConfig: manifest.triggerConfig, variables: manifest.variables, steps: manifest.steps,
      versionNote: "Updated from marketplace",
    });
  } else {
    throw new Error("Updating a knowledge pack/prompt install in place isn't supported — reinstall to get the latest version instead.");
  }
}

export function updateInstall(userId, installId) {
  const install = loadInstall(userId, installId);
  const asset = getAsset(userId, install.assetId);
  if (!asset?.latestVersion) throw new Error("Asset not found.");
  if (asset.latestVersion.id === install.installedVersionId) throw new Error("Already on the latest version.");
  applyVersion(userId, install, asset.latestVersion.manifest);
  db.prepare("UPDATE marketplace_installs SET installedVersionId = ?, updatedAt = ? WHERE id = ?").run(asset.latestVersion.id, now(), installId);
  return { updatedTo: asset.latestVersion.version };
}

export function rollbackInstall(userId, installId, targetVersionId) {
  const install = loadInstall(userId, installId);
  const version = versionById(install.assetId, targetVersionId);
  applyVersion(userId, install, version.manifest);
  db.prepare("UPDATE marketplace_installs SET installedVersionId = ?, updatedAt = ? WHERE id = ?").run(targetVersionId, now(), installId);
  return { rolledBackTo: version.version };
}

// Enable/disable reuse the exact same status functions as manually
// activating/deactivating an agent or pausing an automation — installed
// entities are ordinary entities, not a special marketplace-only state.
export function setInstallEnabled(userId, installId, enabled) {
  const install = loadInstall(userId, installId);
  if (install.installedEntityType === "agent") {
    setAgentStatus(userId, install.entityIds[0], enabled ? "active" : "inactive");
  } else if (install.installedEntityType === "automation") {
    setAutomationStatus(userId, install.entityIds[0], enabled ? "active" : "paused");
  }
  db.prepare("UPDATE marketplace_installs SET status = ?, updatedAt = ? WHERE id = ?").run(enabled ? "active" : "disabled", now(), installId);
  return { enabled };
}

export function uninstall(userId, installId) {
  const install = loadInstall(userId, installId);
  // Deactivate rather than delete the underlying entity — safer default;
  // the installer can delete it separately from its own page if they want
  // it gone entirely, same as any agent/automation they created by hand.
  if (install.installedEntityType === "agent") setAgentStatus(userId, install.entityIds[0], "inactive");
  else if (install.installedEntityType === "automation") setAutomationStatus(userId, install.entityIds[0], "paused");
  db.prepare("UPDATE marketplace_installs SET status = 'uninstalled', updatedAt = ? WHERE id = ?").run(now(), installId);
  return { uninstalled: true };
}
