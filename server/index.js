import "dotenv/config";
import express from "express";
import session from "express-session";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";

import "./db.js";
import "./tools/index.js"; // side-effect: registers all tools with the Tool Registry
import authRoutes from "./routes/auth.js";
import chatRoutes from "./routes/chat.js";
import agentRoutes from "./routes/agents.js";
import agentLibraryRoutes from "./routes/agentLibrary.js";
import organizationRoutes from "./routes/organizations.js";
import orgIntegrationRoutes from "./routes/orgIntegrations.js";
import auditLogRoutes from "./routes/auditLogs.js";
import commentRoutes from "./routes/comments.js";
import notificationRoutes from "./routes/notifications.js";
import orgAnalyticsRoutes from "./routes/orgAnalytics.js";
import billingRoutes from "./routes/billing.js";
import couponRoutes from "./routes/coupons.js";
import platformAdminRoutes from "./routes/platformAdmin.js";
import stripeWebhookRoutes from "./routes/stripeWebhook.js";
import marketplaceRoutes from "./routes/marketplace.js";
import marketplaceInstallRoutes from "./routes/marketplaceInstalls.js";
import marketplaceReviewRoutes from "./routes/marketplaceReviews.js";
import marketplacePaymentRoutes from "./routes/marketplacePayments.js";
import customToolRoutes from "./routes/customTools.js";
import { sweepExpiredTrials } from "./orchestrator/coupons.js";
import workspaceRoutes from "./routes/workspaces.js";
import projectRoutes from "./routes/projects.js";
import skillRoutes from "./routes/skills.js";
import integrationRoutes from "./routes/integrations.js";
import taskRoutes from "./routes/tasks.js";
import activityRoutes from "./routes/activity.js";
import dashboardRoutes from "./routes/dashboard.js";
import "./integrations/meta/index.js"; // side-effect: registers the Meta integration definition
import "./integrations/whatsapp/index.js"; // side-effect: registers the WhatsApp integration definition
import "./integrations/wordpress/index.js";
import "./integrations/woocommerce/index.js";
import "./integrations/gmail/index.js";
import "./integrations/google/calendar/index.js";
import "./integrations/google/drive/index.js";
import "./integrations/google/docs/index.js";
import "./integrations/google/sheets/index.js";
import "./integrations/shopify/index.js";
import { createGoogleServiceRouter } from "./routes/googleServiceAuth.js";
import shopifyAuthRoutes from "./routes/shopifyAuth.js";
import shopifyWebhookRoutes from "./routes/shopifyWebhook.js";
import confirmationRoutes, { sweepExpiredConfirmations } from "./routes/confirmations.js";
import researchRoutes from "./routes/research.js";
import voiceRoutes from "./routes/voice.js";
import metaAuthRoutes from "./routes/metaAuth.js";
import whatsappAuthRoutes from "./routes/whatsappAuth.js";
import whatsappWebhookRoutes from "./routes/whatsappWebhook.js";
import wordpressAuthRoutes from "./routes/wordpressAuth.js";
import woocommerceAuthRoutes from "./routes/woocommerceAuth.js";
import gmailAuthRoutes from "./routes/gmailAuth.js";
import automationRoutes from "./routes/automations.js";
import eventWebhookRoutes from "./routes/eventWebhooks.js";
import { initializeSchedulesOnBoot } from "./automation/scheduler.js";
import { runScheduledAutomation } from "./automation/runner.js";
import { initializeQueueProcessor } from "./automation/eventQueue.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;

// The `verify` callback stashes the raw bytes before JSON parsing — needed
// to verify Meta's webhook HMAC signature, which is computed over the exact
// raw body, not a re-serialized version of the parsed object.
app.use(express.json({ limit: "2mb", verify: (req, res, buf) => { req.rawBody = buf; } }));

// In dev the client runs on :5173 and proxies /api, so CORS with credentials
// is only needed if you point the client at the server cross-origin.
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || true,
    credentials: true,
  })
);

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-insecure-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);

app.get("/api/health", (req, res) => res.json({ ok: true }));
app.use("/api/auth", authRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/agents", agentRoutes);
app.use("/api/agent-library", agentLibraryRoutes);
app.use("/api/organizations", organizationRoutes);
app.use("/api/organizations", orgIntegrationRoutes);
app.use("/api/organizations", auditLogRoutes);
app.use("/api/entities", commentRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/organizations", orgAnalyticsRoutes);
app.use("/api", billingRoutes);
app.use("/api", couponRoutes);
app.use("/api/admin", platformAdminRoutes);
app.use("/api/stripe", stripeWebhookRoutes);
app.use("/api/marketplace", marketplaceRoutes);
app.use("/api/marketplace", marketplaceInstallRoutes);
app.use("/api/marketplace", marketplaceReviewRoutes);
app.use("/api/marketplace", marketplacePaymentRoutes);
app.use("/api/developer", customToolRoutes);
app.use("/api", workspaceRoutes);
app.use("/api", projectRoutes);
app.use("/api/skills", skillRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/activity", activityRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/confirmations", confirmationRoutes);
app.use("/api/research", researchRoutes);
app.use("/api/voice", voiceRoutes);
// These must be mounted BEFORE the general "/api/integrations" catalog route
// below — Express matches by path PREFIX, so that catalog router (which
// requires login for every request reaching it) would otherwise intercept
// anything starting with "/api/integrations", including the public webhook,
// before this more specific router ever got a chance to run.
app.use("/api/integrations/meta", metaAuthRoutes);
app.use("/api/integrations/whatsapp", whatsappWebhookRoutes);
app.use("/api/integrations/whatsapp", whatsappAuthRoutes);
app.use("/api/integrations/wordpress", wordpressAuthRoutes);
app.use("/api/integrations/woocommerce", woocommerceAuthRoutes);
app.use("/api/integrations/gmail", gmailAuthRoutes);
app.use("/api/integrations/google_calendar", createGoogleServiceRouter("google_calendar", "Google Calendar"));
app.use("/api/integrations/google_drive", createGoogleServiceRouter("google_drive", "Google Drive"));
app.use("/api/integrations/google_docs", createGoogleServiceRouter("google_docs", "Google Docs"));
app.use("/api/integrations/google_sheets", createGoogleServiceRouter("google_sheets", "Google Sheets"));
app.use("/api/integrations/shopify", shopifyWebhookRoutes);
app.use("/api/integrations/shopify", shopifyAuthRoutes);
app.use("/api/integrations", integrationRoutes);
app.use("/api/automations", automationRoutes);
app.use("/api/triggers", eventWebhookRoutes);

// Serve the built client in production (single-service deploy).
const clientDist = join(__dirname, "..", "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (req, res) => {
    if (req.path.startsWith("/api")) return res.status(404).json({ error: "Not found" });
    res.sendFile(join(clientDist, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`AI Agent Platform API running on http://localhost:${PORT}`);
  initializeSchedulesOnBoot(runScheduledAutomation);
  initializeQueueProcessor();
  setInterval(sweepExpiredConfirmations, 60_000); // catch ignored confirmations once a minute
  setInterval(sweepExpiredTrials, 60_000 * 60); // check for ended trials once an hour
});
