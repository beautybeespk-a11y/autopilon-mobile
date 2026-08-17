import { Router } from "express";
import { requireApiKey, requireScope } from "./auth.js";
import { apiRateLimit } from "./rateLimit.js";
import { apiError, apiErrorFromException } from "./errors.js";
import { parsePagination, paginate, cursorWhereClause } from "./pagination.js";
import { listOrgTasks, getOrgTask, createOrgTask, updateOrgTask, completeOrgTask, archiveOrgTask } from "../orchestrator/taskApiService.js";

const router = Router();
router.use(requireApiKey, apiRateLimit());

router.get("/", requireScope("tasks:read"), (req, res) => {
  const { limit, cursor } = parsePagination(req);
  const rows = listOrgTasks(req.orgId, { limit, cursorClause: cursorWhereClause(cursor) });
  const { data, pagination } = paginate(rows, limit);
  res.json({ data, pagination });
});

router.get("/:id", requireScope("tasks:read"), (req, res) => {
  const task = getOrgTask(req.orgId, req.params.id);
  if (!task) return apiError(res, 404, "RESOURCE_NOT_FOUND", "The requested task was not found.");
  res.json(task);
});

router.post("/", requireScope("tasks:write"), (req, res) => {
  try {
    const task = createOrgTask(req.orgId, req.apiKey.userId, req.body || {});
    res.status(201).json(task);
  } catch (err) {
    apiErrorFromException(res, err, "Could not create task.");
  }
});

router.patch("/:id", requireScope("tasks:write"), (req, res) => {
  try {
    res.json(updateOrgTask(req.orgId, req.params.id, req.body || {}));
  } catch (err) {
    apiErrorFromException(res, err, "Could not update task.");
  }
});

router.post("/:id/complete", requireScope("tasks:write"), (req, res) => {
  try {
    res.json(completeOrgTask(req.orgId, req.params.id));
  } catch (err) {
    apiErrorFromException(res, err, "Could not complete task.");
  }
});

router.delete("/:id", requireScope("tasks:write"), (req, res) => {
  try {
    res.json(archiveOrgTask(req.orgId, req.params.id));
  } catch (err) {
    apiErrorFromException(res, err, "Could not archive task.");
  }
});

export default router;
