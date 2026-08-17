# Minimal Autopilon Public API client (Phase 17.1 §4). No third-party
# dependencies — built entirely on the standard library (urllib), matching
# the JS SDK's (sdk/js/) dependency-free philosophy. Covers exactly the
# endpoints documented in ../../../PUBLIC_API.md; nothing here wraps an
# endpoint that doesn't exist server-side.
import json
import mimetypes
import urllib.error
import urllib.parse
import urllib.request
import uuid


class AutopilonApiError(Exception):
    """Raised for any non-2xx Public API response, or a non-JSON HTTP error."""

    def __init__(self, code, message, request_id=None, status=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.request_id = request_id
        self.status = status

    def __repr__(self):
        return f"AutopilonApiError(code={self.code!r}, status={self.status!r}, message={self.message!r}, request_id={self.request_id!r})"


def _idempotency_headers(idempotency_key):
    return {"Idempotency-Key": idempotency_key} if idempotency_key else None


def _encode_multipart(fields, file_field_name, filename, file_bytes, content_type):
    """Hand-rolled multipart/form-data body — stdlib has no built-in encoder.
    Returns (body_bytes, content_type_header)."""
    boundary = uuid.uuid4().hex
    parts = []
    for key, value in fields.items():
        if value is None:
            continue
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode("utf-8")
        )
    parts.append(
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field_name}"; filename="{filename}"\r\n'
            f"Content-Type: {content_type or 'application/octet-stream'}\r\n\r\n"
        ).encode("utf-8")
        + file_bytes
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


class AutopilonClient:
    def __init__(self, api_key, base_url="http://localhost:4000/api/v1"):
        if not api_key:
            raise ValueError("AutopilonClient: api_key is required.")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")

        self.agents = AgentsResource(self)
        self.runs = RunsResource(self)
        self.automations = AutomationsResource(self)
        self.tasks = TasksResource(self)
        self.projects = ProjectsResource(self)
        self.files = FilesResource(self)
        self.content = ContentResource(self)
        self.integrations = IntegrationsResource(self)
        self.marketplace = MarketplaceResource(self)
        self.webhooks = WebhooksResource(self)

    # Core request. Every resource method funnels through here so auth
    # headers, error parsing, and request-id propagation live in exactly
    # one place — same design as the JS SDK's AutopilonClient.request().
    def request(self, method, path, query=None, body=None, headers=None, raw_body=None, raw_content_type=None):
        url = self.base_url + path
        if query:
            clean = {k: v for k, v in query.items() if v is not None and v != ""}
            if clean:
                url = f"{url}?{urllib.parse.urlencode(clean)}"

        req_headers = {"Authorization": f"Bearer {self.api_key}"}
        data = None
        if raw_body is not None:
            data = raw_body
            if raw_content_type:
                req_headers["Content-Type"] = raw_content_type
        elif body is not None:
            data = json.dumps(body).encode("utf-8")
            req_headers["Content-Type"] = "application/json"
        if headers:
            req_headers.update(headers)

        req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
        try:
            with urllib.request.urlopen(req) as res:
                return self._parse_response(res, res.status, is_error=False)
        except urllib.error.HTTPError as err:
            return self._parse_response(err, err.code, is_error=True)

    def _parse_response(self, res, status, is_error):
        request_id = res.headers.get("X-Request-ID")
        content_type = res.headers.get("Content-Type", "") or ""
        raw = res.read()

        if "application/json" not in content_type:
            if is_error:
                raise AutopilonApiError("HTTP_ERROR", f"Request failed with HTTP {status}.", request_id, status)
            return raw  # e.g. files.download_content() reads raw bytes itself

        payload = json.loads(raw.decode("utf-8")) if raw else {}
        if is_error:
            err = payload.get("error") or {}
            raise AutopilonApiError(
                err.get("code", "UNKNOWN_ERROR"),
                err.get("message", f"Request failed with HTTP {status}."),
                err.get("request_id", request_id),
                status,
            )
        return payload

    # Walks every page of a cursor-paginated list endpoint. NOT usable
    # against /marketplace/assets, which isn't cursor-paginated (see
    # PUBLIC_API.md's Pagination section).
    def paginate(self, path, query=None):
        query = dict(query or {})
        cursor = None
        while True:
            q = dict(query)
            if cursor:
                q["cursor"] = cursor
            page = self.request("GET", path, query=q)
            for item in page.get("data", []):
                yield item
            pagination = page.get("pagination") or {}
            if not pagination.get("hasMore"):
                return
            cursor = pagination.get("nextCursor")


class AgentsResource:
    def __init__(self, client):
        self._c = client

    def list(self, limit=None, cursor=None):
        return self._c.request("GET", "/agents", query={"limit": limit, "cursor": cursor})

    def get(self, agent_id):
        return self._c.request("GET", f"/agents/{agent_id}")

    def list_runs(self, agent_id, limit=None, cursor=None):
        return self._c.request("GET", f"/agents/{agent_id}/runs", query={"limit": limit, "cursor": cursor})

    def execute(self, agent_id, message, conversation_id=None, run_async=False, idempotency_key=None):
        body = {"message": message, "conversationId": conversation_id, "async": run_async}
        return self._c.request("POST", f"/agents/{agent_id}/execute", body=body, headers=_idempotency_headers(idempotency_key))

    def send_message(self, agent_id, message, conversation_id=None, idempotency_key=None):
        body = {"message": message, "conversationId": conversation_id}
        return self._c.request("POST", f"/agents/{agent_id}/messages", body=body, headers=_idempotency_headers(idempotency_key))


class RunsResource:
    def __init__(self, client):
        self._c = client

    def get(self, run_id):
        return self._c.request("GET", f"/runs/{run_id}")


class AutomationsResource:
    def __init__(self, client):
        self._c = client

    def list(self, limit=None, cursor=None):
        return self._c.request("GET", "/automations", query={"limit": limit, "cursor": cursor})

    def get(self, automation_id):
        return self._c.request("GET", f"/automations/{automation_id}")

    def run(self, automation_id, variables=None, idempotency_key=None):
        return self._c.request("POST", f"/automations/{automation_id}/run", body={"variables": variables}, headers=_idempotency_headers(idempotency_key))

    def list_runs(self, automation_id, limit=None, cursor=None):
        return self._c.request("GET", f"/automations/{automation_id}/runs", query={"limit": limit, "cursor": cursor})

    def get_run(self, run_id):
        return self._c.request("GET", f"/automations/runs/{run_id}")


class TasksResource:
    def __init__(self, client):
        self._c = client

    def list(self, limit=None, cursor=None):
        return self._c.request("GET", "/tasks", query={"limit": limit, "cursor": cursor})

    def get(self, task_id):
        return self._c.request("GET", f"/tasks/{task_id}")

    def create(self, title, description=None, priority=None, due_date=None, idempotency_key=None):
        body = {"title": title, "description": description, "priority": priority, "dueDate": due_date}
        return self._c.request("POST", "/tasks", body=body, headers=_idempotency_headers(idempotency_key))

    def update(self, task_id, **patch):
        return self._c.request("PATCH", f"/tasks/{task_id}", body=patch)

    def complete(self, task_id):
        return self._c.request("POST", f"/tasks/{task_id}/complete")

    def archive(self, task_id):
        return self._c.request("DELETE", f"/tasks/{task_id}")


class ProjectsResource:
    def __init__(self, client):
        self._c = client

    def list(self, limit=None, cursor=None):
        return self._c.request("GET", "/projects", query={"limit": limit, "cursor": cursor})

    def get(self, project_id):
        return self._c.request("GET", f"/projects/{project_id}")

    def create(self, workspace_id, name=None, description=None, idempotency_key=None):
        body = {"workspaceId": workspace_id, "name": name, "description": description}
        return self._c.request("POST", "/projects", body=body, headers=_idempotency_headers(idempotency_key))

    def update(self, project_id, **patch):
        return self._c.request("PATCH", f"/projects/{project_id}", body=patch)

    def archive(self, project_id):
        return self._c.request("DELETE", f"/projects/{project_id}")

    def list_items(self, project_id):
        return self._c.request("GET", f"/projects/{project_id}/items")

    def add_item(self, project_id, item_type, item_id):
        return self._c.request("POST", f"/projects/{project_id}/items", body={"itemType": item_type, "itemId": item_id})

    def remove_item(self, project_id, item_type, item_id):
        return self._c.request("DELETE", f"/projects/{project_id}/items/{item_type}/{item_id}")


class FilesResource:
    def __init__(self, client):
        self._c = client

    def list(self, limit=None, cursor=None, folder_id=None):
        return self._c.request("GET", "/files", query={"limit": limit, "cursor": cursor, "folderId": folder_id})

    def get(self, file_id):
        return self._c.request("GET", f"/files/{file_id}")

    def delete(self, file_id):
        return self._c.request("DELETE", f"/files/{file_id}")

    def create_download_url(self, file_id, expires_in_seconds=None):
        return self._c.request("POST", f"/files/{file_id}/download-url", body={"expiresInSeconds": expires_in_seconds})

    def upload(self, file_bytes, filename, folder_id=None, visibility=None, tags=None, content_type=None):
        fields = {"folderId": folder_id, "visibility": visibility}
        if tags:
            fields["tags"] = ",".join(tags) if isinstance(tags, (list, tuple)) else tags
        guessed_type = content_type or mimetypes.guess_type(filename)[0]
        body, ct = _encode_multipart(fields, "file", filename, file_bytes, guessed_type)
        return self._c.request("POST", "/files/upload", raw_body=body, raw_content_type=ct)

    def download_content(self, file_id):
        """Returns the raw response bytes — caller decides how to save/use them."""
        return self._c.request("GET", f"/files/{file_id}/content")


class ContentResource:
    def __init__(self, client):
        self._c = client

    def get_asset(self, asset_id):
        return self._c.request("GET", f"/content/{asset_id}")

    def generate_text(self, content_type, brief, idempotency_key=None, **extra):
        body = {"contentType": content_type, "brief": brief, **extra}
        return self._c.request("POST", "/content/text", body=body, headers=_idempotency_headers(idempotency_key))

    def generate_image(self, prompt, idempotency_key=None, **extra):
        body = {"prompt": prompt, **extra}
        return self._c.request("POST", "/content/image", body=body, headers=_idempotency_headers(idempotency_key))

    def generate_voice(self, text, idempotency_key=None, **extra):
        body = {"text": text, **extra}
        return self._c.request("POST", "/content/voice", body=body, headers=_idempotency_headers(idempotency_key))


class IntegrationsResource:
    def __init__(self, client):
        self._c = client

    def list(self):
        return self._c.request("GET", "/integrations")

    def list_actions(self, provider):
        return self._c.request("GET", f"/integrations/{provider}/actions")

    def execute_action(self, provider, action_name, agent_id, parameters=None, idempotency_key=None):
        body = {"agentId": agent_id, "parameters": parameters or {}}
        return self._c.request("POST", f"/integrations/{provider}/actions/{action_name}/execute", body=body, headers=_idempotency_headers(idempotency_key))


class MarketplaceResource:
    def __init__(self, client):
        self._c = client

    def list_assets(self, q=None, asset_type=None, category_id=None, sort=None, limit=None):
        query = {"q": q, "assetType": asset_type, "categoryId": category_id, "sort": sort, "limit": limit}
        return self._c.request("GET", "/marketplace/assets", query=query)

    def list_categories(self):
        return self._c.request("GET", "/marketplace/categories")


class WebhooksResource:
    def __init__(self, client):
        self._c = client

    def list_event_types(self):
        return self._c.request("GET", "/webhooks/event-types")

    def list(self):
        return self._c.request("GET", "/webhooks")

    def get(self, webhook_id):
        return self._c.request("GET", f"/webhooks/{webhook_id}")

    def create(self, url, events, description=None):
        return self._c.request("POST", "/webhooks", body={"url": url, "description": description, "events": events})

    def update(self, webhook_id, **patch):
        return self._c.request("PATCH", f"/webhooks/{webhook_id}", body=patch)

    def delete(self, webhook_id):
        return self._c.request("DELETE", f"/webhooks/{webhook_id}")

    def get_secret(self, webhook_id):
        return self._c.request("GET", f"/webhooks/{webhook_id}/secret")

    def send_test_event(self, webhook_id):
        return self._c.request("POST", f"/webhooks/{webhook_id}/test")

    def list_deliveries(self, webhook_id, limit=None):
        return self._c.request("GET", f"/webhooks/{webhook_id}/deliveries", query={"limit": limit})
