import { Router } from "express";
import { requireApiKey, requireScope } from "./auth.js";
import { requireCapability } from "./featureGate.js";
import { apiRateLimit } from "./rateLimit.js";
import { apiError, apiErrorFromException } from "./errors.js";
import { parsePagination, paginate, cursorWhereClause } from "./pagination.js";
import {
  listOrgProjects, getOrgProject, createOrgProject, updateOrgProject, archiveOrgProject,
  listOrgProjectItems, addOrgProjectItem, removeOrgProjectItem,
} from "../orchestrator/projectApiService.js";

const router = Router();
router.use(requireApiKey, requireCapability("public_api_projects"), apiRateLimit());

router.get("/", requireScope("projects:read"), (req, res) => {
  const { limit, cursor } = parsePagination(req);
  const rows = listOrgProjects(req.orgId, { limit, cursorClause: cursorWhereClause(cursor) });
  const { data, pagination } = paginate(rows, limit);
  res.json({ data, pagination });
});

router.get("/:id", requireScope("projects:read"), (req, res) => {
  const project = getOrgProject(req.orgId, req.params.id);
  if (!project) return apiError(res, 404, "RESOURCE_NOT_FOUND", "The requested project was not found.");
  res.json(project);
});

router.post("/", requireScope("projects:write"), (req, res) => {
  const { workspaceId, name, description } = req.body || {};
  if (!workspaceId) return apiError(res, 400, "INVALID_REQUEST", "workspaceId is required.");
  try {
    const project = createOrgProject(req.orgId, workspaceId, req.apiKey.userId, { name, description });
    res.status(201).json(project);
  } catch (err) {
    apiErrorFromException(res, err, "Could not create project.");
  }
});

router.patch("/:id", requireScope("projects:write"), (req, res) => {
  try {
    res.json(updateOrgProject(req.orgId, req.params.id, req.apiKey.userId, req.body || {}));
  } catch (err) {
    apiErrorFromException(res, err, "Could not update project.");
  }
});

router.delete("/:id", requireScope("projects:write"), (req, res) => {
  try {
    res.json(archiveOrgProject(req.orgId, req.params.id, req.apiKey.userId));
  } catch (err) {
    apiErrorFromException(res, err, "Could not archive project.");
  }
});

router.get("/:id/items", requireScope("projects:read"), (req, res) => {
  try {
    res.json(listOrgProjectItems(req.orgId, req.params.id, req.apiKey.userId));
  } catch (err) {
    apiErrorFromException(res, err, "Could not list project items.");
  }
});

router.post("/:id/items", requireScope("projects:write"), (req, res) => {
  const { itemType, itemId } = req.body || {};
  if (!itemType || !itemId) return apiError(res, 400, "INVALID_REQUEST", "itemType and itemId are required.");
  try {
    res.json(addOrgProjectItem(req.orgId, req.params.id, req.apiKey.userId, itemType, itemId));
  } catch (err) {
    apiErrorFromException(res, err, "Could not add project item.");
  }
});

router.delete("/:id/items/:itemType/:itemId", requireScope("projects:write"), (req, res) => {
  try {
    res.json(removeOrgProjectItem(req.orgId, req.params.id, req.apiKey.userId, req.params.itemType, req.params.itemId));
  } catch (err) {
    apiErrorFromException(res, err, "Could not remove project item.");
  }
});

export default router;
