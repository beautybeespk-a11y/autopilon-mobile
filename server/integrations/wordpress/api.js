// WordPress REST API client. Auth is an "application password" (generated
// in WP Admin → Users → Profile → Application Passwords) sent as HTTP Basic
// Auth — no OAuth dance needed, same pattern as the user's existing Store
// Manager project.

function authHeader(username, appPassword) {
  return "Basic " + Buffer.from(`${username}:${appPassword}`).toString("base64");
}

async function wpFetch(siteUrl, username, appPassword, path, { method = "GET", body, isFormData } = {}) {
  const url = `${siteUrl.replace(/\/$/, "")}/wp-json/wp/v2${path}`;
  const headers = { authorization: authHeader(username, appPassword) };
  if (!isFormData && body) headers["content-type"] = "application/json";
  const res = await fetch(url, { method, headers, body: isFormData ? body : body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.message || `WordPress API error ${res.status}`);
    err.code = res.status;
    throw err;
  }
  return data;
}

export async function checkSite(siteUrl, username, appPassword) {
  const res = await fetch(`${siteUrl.replace(/\/$/, "")}/wp-json`, { headers: { authorization: authHeader(username, appPassword) } });
  if (!res.ok) throw new Error(`Could not reach WordPress site (${res.status})`);
  const data = await res.json();
  return { name: data.name, description: data.description, url: data.url };
}

export const listPosts = (site, u, p, params = {}) =>
  wpFetch(site, u, p, `/posts?${new URLSearchParams(params)}`);

export const createPost = (site, u, p, { title, content, status = "draft", categories, tags }) =>
  wpFetch(site, u, p, "/posts", { method: "POST", body: { title, content, status, categories, tags } });

export const updatePost = (site, u, p, postId, fields) =>
  wpFetch(site, u, p, `/posts/${postId}`, { method: "POST", body: fields }); // WP REST API uses POST for partial updates

export const deletePost = (site, u, p, postId, force = false) =>
  wpFetch(site, u, p, `/posts/${postId}?force=${force}`, { method: "DELETE" });

export const listPages = (site, u, p, params = {}) =>
  wpFetch(site, u, p, `/pages?${new URLSearchParams(params)}`);

export const createPage = (site, u, p, { title, content, status = "draft" }) =>
  wpFetch(site, u, p, "/pages", { method: "POST", body: { title, content, status } });

export const listCategories = (site, u, p) => wpFetch(site, u, p, "/categories?per_page=100");
export const listTags = (site, u, p) => wpFetch(site, u, p, "/tags?per_page=100");
export const listComments = (site, u, p, params = {}) => wpFetch(site, u, p, `/comments?${new URLSearchParams(params)}`);
export const listUsers = (site, u, p) => wpFetch(site, u, p, "/users?per_page=50");

// Media upload takes raw bytes fetched from a public URL — the AI supplies
// a URL (from generated art, research, etc.), not a local file, since the
// backend has no user-uploaded-file storage wired to this tool.
export async function uploadImageFromUrl(site, u, p, imageUrl, filename) {
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Could not fetch image from ${imageUrl}`);
  const buffer = Buffer.from(await imgRes.arrayBuffer());
  const contentType = imgRes.headers.get("content-type") || "image/jpeg";
  const url = `${site.replace(/\/$/, "")}/wp-json/wp/v2/media`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: authHeader(u, p),
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename || "image.jpg"}"`,
    },
    body: buffer,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `Media upload failed (${res.status})`);
  return data;
}
