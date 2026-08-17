#!/usr/bin/env python3
"""Smoke test for the Autopilon Python SDK (Phase 17.1 §4) — a plain script
against a REAL, already-booted server with a real API key, same style as
server/test/*.js. No test framework required (this SDK has zero
dependencies, including for testing itself). Run with:

    AUTOPILON_API_KEY=ap_live_... AUTOPILON_BASE_URL=http://localhost:4000/api/v1 \\
        python3 smoke_test.py

Exits non-zero if any check fails.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from autopilon import AutopilonClient, AutopilonApiError  # noqa: E402

BASE_URL = os.environ.get("AUTOPILON_BASE_URL", "http://localhost:4000/api/v1")
API_KEY = os.environ.get("AUTOPILON_API_KEY")

if not API_KEY:
    print("AUTOPILON_API_KEY is required (export it or pass inline).")
    sys.exit(1)

client = AutopilonClient(api_key=API_KEY, base_url=BASE_URL)

results = []


def check(name, fn):
    try:
        fn()
        results.append((name, True, None))
        print(f"PASS  {name}")
    except Exception as err:  # noqa: BLE001 - intentionally broad, this is a test harness
        results.append((name, False, str(err)))
        print(f"FAIL  {name}: {err}")


def check_agents_list():
    page = client.agents.list(limit=10)
    assert isinstance(page.get("data"), list), "data is not a list"
    assert "hasMore" in page.get("pagination", {}), "missing pagination.hasMore"


def check_task_roundtrip():
    task = client.tasks.create(title="Python SDK smoke test task", priority="high")
    assert task["title"] == "Python SDK smoke test task"
    fetched = client.tasks.get(task["id"])
    assert fetched["id"] == task["id"]
    updated = client.tasks.update(task["id"], description="updated via python sdk")
    assert updated["description"] == "updated via python sdk"
    completed = client.tasks.complete(task["id"])
    assert completed["status"] == "completed"
    archived = client.tasks.archive(task["id"])
    assert archived["status"] == "archived"


def check_pagination():
    client.tasks.create(title="Second python sdk task")
    seen = []
    for item in client.paginate("/tasks", query={"limit": 1}):
        seen.append(item["id"])
        if len(seen) > 10:
            break
    assert len(seen) >= 2, f"expected >=2 tasks via pagination, got {len(seen)}"


def check_not_found_error_shape():
    try:
        client.agents.get("does-not-exist")
        raise AssertionError("expected AutopilonApiError")
    except AutopilonApiError as err:
        assert err.code == "RESOURCE_NOT_FOUND", f"wrong code: {err.code}"
        assert err.status == 404, f"wrong status: {err.status}"
        assert err.request_id, "missing request_id"


def check_webhook_roundtrip():
    webhook = client.webhooks.create(url="https://example.com/hooks/python-sdk-test", events=["task.created"])
    assert webhook["secret"].startswith("whsec_"), "no secret returned on create"
    secret = client.webhooks.get_secret(webhook["id"])
    assert secret["secret"] == webhook["secret"], "secret mismatch on re-fetch"
    listing = client.webhooks.list()
    assert any(w["id"] == webhook["id"] for w in listing["data"]), "created webhook not in list"
    test_result = client.webhooks.send_test_event(webhook["id"])
    assert isinstance(test_result.get("responseTimeMs"), int), "test event missing responseTimeMs"
    client.webhooks.delete(webhook["id"])


def check_project_validation_error():
    try:
        client.projects.create(workspace_id=None, name="no workspace")
        raise AssertionError("expected AutopilonApiError")
    except AutopilonApiError as err:
        assert err.code == "INVALID_REQUEST", f"wrong code: {err.code}"


def check_marketplace():
    assets = client.marketplace.list_assets(limit=5)
    assert isinstance(assets.get("data"), list)
    categories = client.marketplace.list_categories()
    assert isinstance(categories.get("data"), list)


def check_file_roundtrip():
    content = b"hello from the python sdk smoke test"
    uploaded = client.files.upload(content, filename="python-sdk-test.txt", content_type="text/plain")
    assert uploaded["filename"] == "python-sdk-test.txt"
    fetched = client.files.get(uploaded["id"])
    assert fetched["id"] == uploaded["id"]
    downloaded = client.files.download_content(uploaded["id"])
    assert downloaded == content, f"content mismatch: {downloaded!r}"
    client.files.delete(uploaded["id"])


def check_idempotency():
    key = f"python-sdk-smoke-{time.time()}"
    first = client.tasks.create(title="Python SDK idempotency test", idempotency_key=key)
    second = client.tasks.create(title="Python SDK idempotency test", idempotency_key=key)
    assert first["id"] == second["id"], "expected the same task id on replay"


def check_integration_actions_not_found():
    try:
        client.integrations.list_actions("gmail")
        raise AssertionError("expected AutopilonApiError")
    except AutopilonApiError as err:
        assert err.status == 404, f"expected 404 for an unconnected provider, got {err.status}"


check("agents.list() returns a paginated shape", check_agents_list)
check("tasks create/get/update/complete/archive round-trip", check_task_roundtrip)
check("client.paginate() walks tasks without manual cursors", check_pagination)
check("agents.get(nonexistent) raises AutopilonApiError with RESOURCE_NOT_FOUND", check_not_found_error_shape)
check("webhooks create/get_secret/send_test_event/list/delete round-trip", check_webhook_roundtrip)
check("projects.create requires a workspace_id (INVALID_REQUEST)", check_project_validation_error)
check("marketplace.list_assets + list_categories return real shapes", check_marketplace)
check("files upload/get/download_content/delete round-trip", check_file_roundtrip)
check("tasks.create with idempotency_key replays on retry", check_idempotency)
check("integrations.list_actions(unconnected provider) -> 404", check_integration_actions_not_found)

passed = sum(1 for _, ok, _ in results if ok)
print(f"\n{passed}/{len(results)} checks passed.")
sys.exit(0 if passed == len(results) else 1)
