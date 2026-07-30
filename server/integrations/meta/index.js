import { registerIntegration } from "../manager.js";

registerIntegration({
  id: "meta_ads",
  name: "Meta Ads",
  category: "advertising",
  authType: "oauth2",
  requiredScopes: ["ads_read", "ads_management"],
  supportedTools: [
    "list_ad_accounts", "list_campaigns", "create_campaign",
    "update_campaign", "pause_campaign", "resume_campaign", "get_campaign_insights",
  ],
});
