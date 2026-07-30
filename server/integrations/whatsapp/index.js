import { registerIntegration } from "../manager.js";

registerIntegration({
  id: "whatsapp",
  name: "WhatsApp Business",
  category: "messaging",
  // WhatsApp Cloud API doesn't use a redirect-based OAuth dialog the way
  // Meta Ads does — the standard setup is a System User access token plus a
  // phone_number_id/WABA ID generated in Meta's dashboard, pasted in here.
  authType: "manual_token",
  requiredScopes: ["whatsapp_business_messaging"],
  supportedTools: [
    "send_whatsapp_message", "reply_whatsapp_message", "list_whatsapp_conversations",
    "get_whatsapp_conversation", "mark_message_read", "send_image", "send_document", "send_template_message",
  ],
});
