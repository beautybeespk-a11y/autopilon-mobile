// Thin fetch wrapper. Always sends the session cookie.
async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.detail = data?.detail;
    err.data = data;
    throw err;
  }
  return data;
}

// Separate from `request` because a multipart body must NOT have a manually
// set Content-Type — the browser needs to add its own boundary parameter,
// which it can only do if we let fetch set the header itself.
async function upload(path, formData) {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    credentials: "include",
    body: formData,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// For endpoints that return raw audio (text-to-speech) instead of JSON —
// everything else about the request (session cookie, JSON body) is the same
// as `request`, just the response handling differs.
async function postBlob(path, body) {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.detail = data?.detail;
    err.data = data;
    throw err;
  }
  return res.blob();
}

export const api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: "POST", body }),
  patch: (p, body) => request(p, { method: "PATCH", body }),
  del: (p) => request(p, { method: "DELETE" }),
  upload,
  postBlob,
};
