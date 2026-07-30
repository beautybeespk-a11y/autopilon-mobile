import { registerTool } from "../registry.js";
import { requireValidToken, getConnection } from "../../integrations/manager.js";
import * as wp from "../../integrations/wordpress/api.js";
import { publishEvent } from "../../automation/triggers.js";

function site(userId) {
  const accessToken = requireValidToken(userId, "wordpress"); // app password, stored as the "token"
  const conn = getConnection(userId, "wordpress");
  const meta = JSON.parse(conn.meta || "{}");
  if (!meta.siteUrl || !meta.username) {
    const err = new Error("WordPress is connected but missing site details. Reconnect it in Integrations.");
    err.code = "INTEGRATION_NOT_CONNECTED";
    throw err;
  }
  return { siteUrl: meta.siteUrl, username: meta.username, appPassword: accessToken };
}

registerTool({
  name: "wordpress.list_posts",
  description: "Lists posts on the connected WordPress site.",
  category: "wordpress",
  parameters: { type: "object", properties: { search: { type: "string" }, status: { type: "string" }, perPage: { type: "number" } }, required: [] },
  requiredPermissions: ["wordpress.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { siteUrl, username, appPassword } = site(context.userId);
    const posts = await wp.listPosts(siteUrl, username, appPassword, {
      search: parameters.search || "", status: parameters.status || "publish", per_page: parameters.perPage || 10,
    });
    return { posts: posts.map((p) => ({ id: p.id, title: p.title?.rendered, status: p.status, link: p.link, date: p.date })) };
  },
});

registerTool({
  name: "wordpress.create_post",
  description: "Creates a new WordPress post (draft by default — set status to 'publish' to publish immediately).",
  category: "wordpress",
  parameters: {
    type: "object",
    properties: { title: { type: "string" }, content: { type: "string" }, status: { type: "string" }, categories: { type: "array" }, tags: { type: "array" } },
    required: ["title", "content"],
  },
  requiredPermissions: ["wordpress.write"],
  requiresConfirmation: true, // Publishing/creating public content is worth confirming, especially if status is "publish".
  async execute(parameters, context) {
    const { siteUrl, username, appPassword } = site(context.userId);
    const post = await wp.createPost(siteUrl, username, appPassword, parameters);
    if (post.status === "publish") {
      publishEvent(context.userId, "wordpress", "wordpress_post_published", { postId: post.id, title: parameters.title, link: post.link });
    }
    return { postId: post.id, status: post.status, link: post.link };
  },
});

registerTool({
  name: "wordpress.update_post",
  description: "Updates an existing WordPress post.",
  category: "wordpress",
  parameters: {
    type: "object",
    properties: { postId: { type: "number" }, title: { type: "string" }, content: { type: "string" }, status: { type: "string" } },
    required: ["postId"],
  },
  requiredPermissions: ["wordpress.write"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const { siteUrl, username, appPassword } = site(context.userId);
    const { postId, ...fields } = parameters;
    const post = await wp.updatePost(siteUrl, username, appPassword, postId, fields);
    if (fields.status === "publish") {
      publishEvent(context.userId, "wordpress", "wordpress_post_published", { postId: post.id, title: post.title?.rendered, link: post.link });
    }
    return { postId: post.id, status: post.status, link: post.link };
  },
});

registerTool({
  name: "wordpress.delete_post",
  description: "Deletes (or trashes) a WordPress post.",
  category: "wordpress",
  parameters: { type: "object", properties: { postId: { type: "number" }, force: { type: "boolean" } }, required: ["postId"] },
  requiredPermissions: ["wordpress.write"],
  requiresConfirmation: true, // Deletion — always confirm, especially with force (permanent) delete.
  async execute(parameters, context) {
    const { siteUrl, username, appPassword } = site(context.userId);
    await wp.deletePost(siteUrl, username, appPassword, parameters.postId, parameters.force || false);
    return { postId: parameters.postId, deleted: true, permanent: Boolean(parameters.force) };
  },
});

registerTool({
  name: "wordpress.list_pages",
  description: "Lists pages on the connected WordPress site.",
  category: "wordpress",
  parameters: { type: "object", properties: { search: { type: "string" } }, required: [] },
  requiredPermissions: ["wordpress.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { siteUrl, username, appPassword } = site(context.userId);
    const pages = await wp.listPages(siteUrl, username, appPassword, { search: parameters.search || "" });
    return { pages: pages.map((p) => ({ id: p.id, title: p.title?.rendered, status: p.status, link: p.link })) };
  },
});

registerTool({
  name: "wordpress.create_page",
  description: "Creates a new WordPress page.",
  category: "wordpress",
  parameters: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, status: { type: "string" } }, required: ["title", "content"] },
  requiredPermissions: ["wordpress.write"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const { siteUrl, username, appPassword } = site(context.userId);
    const page = await wp.createPage(siteUrl, username, appPassword, parameters);
    return { pageId: page.id, status: page.status, link: page.link };
  },
});

registerTool({
  name: "wordpress.upload_image",
  description: "Uploads an image to the WordPress media library from a public image URL.",
  category: "wordpress",
  parameters: { type: "object", properties: { imageUrl: { type: "string" }, filename: { type: "string" } }, required: ["imageUrl"] },
  requiredPermissions: ["wordpress.write"],
  requiresConfirmation: false, // Uploading to the media library alone doesn't publish anything publicly.
  async execute(parameters, context) {
    const { siteUrl, username, appPassword } = site(context.userId);
    const media = await wp.uploadImageFromUrl(siteUrl, username, appPassword, parameters.imageUrl, parameters.filename);
    return { mediaId: media.id, url: media.source_url };
  },
});

registerTool({
  name: "wordpress.list_categories",
  description: "Lists categories on the connected WordPress site.",
  category: "wordpress",
  parameters: { type: "object", properties: {}, required: [] },
  requiredPermissions: ["wordpress.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { siteUrl, username, appPassword } = site(context.userId);
    const categories = await wp.listCategories(siteUrl, username, appPassword);
    return { categories: categories.map((c) => ({ id: c.id, name: c.name, count: c.count })) };
  },
});

registerTool({
  name: "wordpress.list_tags",
  description: "Lists tags on the connected WordPress site.",
  category: "wordpress",
  parameters: { type: "object", properties: {}, required: [] },
  requiredPermissions: ["wordpress.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { siteUrl, username, appPassword } = site(context.userId);
    const tags = await wp.listTags(siteUrl, username, appPassword);
    return { tags: tags.map((t) => ({ id: t.id, name: t.name, count: t.count })) };
  },
});

registerTool({
  name: "wordpress.list_comments",
  description: "Lists recent comments on the connected WordPress site.",
  category: "wordpress",
  parameters: { type: "object", properties: { postId: { type: "number" } }, required: [] },
  requiredPermissions: ["wordpress.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { siteUrl, username, appPassword } = site(context.userId);
    const comments = await wp.listComments(siteUrl, username, appPassword, parameters.postId ? { post: parameters.postId } : {});
    return { comments: comments.map((c) => ({ id: c.id, author: c.author_name, content: c.content?.rendered, date: c.date })) };
  },
});

registerTool({
  name: "wordpress.list_users",
  description: "Lists users on the connected WordPress site.",
  category: "wordpress",
  parameters: { type: "object", properties: {}, required: [] },
  requiredPermissions: ["wordpress.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { siteUrl, username, appPassword } = site(context.userId);
    const users = await wp.listUsers(siteUrl, username, appPassword);
    return { users: users.map((u) => ({ id: u.id, name: u.name, roles: u.roles })) };
  },
});
