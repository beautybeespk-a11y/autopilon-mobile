import { defineIntegration } from "../sdk/index.js";
import { getConnection } from "../manager.js";
import { checkSite } from "./api.js";

defineIntegration({
  id: "wordpress",
  name: "WordPress",
  category: "cms",
  authType: "application_password",
  requiredScopes: [],
  permissions: {
    "wordpress.read": "List posts, pages, media, categories, tags, comments, users",
    "wordpress.write": "Create, update, and delete posts and pages; upload media",
  },
  tools: [
    { name: "wordpress.list_posts" }, { name: "wordpress.create_post" }, { name: "wordpress.update_post" },
    { name: "wordpress.delete_post" }, { name: "wordpress.list_pages" }, { name: "wordpress.create_page" },
    { name: "wordpress.upload_image" }, { name: "wordpress.list_categories" }, { name: "wordpress.list_tags" },
    { name: "wordpress.list_comments" }, { name: "wordpress.list_users" },
  ],
  triggers: ["wordpress_post_published"],
  async healthCheck(userId) {
    const conn = getConnection(userId, "wordpress");
    if (!conn || conn.status !== "connected") return { connected: false, reason: "Not connected" };
    const meta = JSON.parse(conn.meta || "{}");
    try {
      const info = await checkSite(meta.siteUrl, meta.username, conn.accessToken);
      return { connected: true, details: info };
    } catch (err) {
      return { connected: false, reason: err.message };
    }
  },
});
