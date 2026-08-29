import { registerTool } from "../registry.js";
import { requireValidToken } from "../../integrations/manager.js";
import * as meta from "../../integrations/meta/api.js";
import { publishEvent } from "../../automation/triggers.js";
import { linkAssetToCampaign } from "../../orchestrator/contentService.js";
import { resolveChatImage } from "../shared/chatImage.js";
import { resolveContentImageAsset } from "../shared/contentAsset.js";
import { resolvePageId } from "../shared/metaPageId.js";
import { resolveAdAccountId } from "../shared/metaAdAccountId.js";
import { MAX_EXECUTABLE_DAILY_BUDGET } from "../../agents/metaExpert/policy.js";

// Live testing (round 4) confirmed the Meta Expert planner's budget cap
// (createPlan -> checkBudgetPolicy) has a real bypass: these raw meta.*
// tools create a live (paused) campaign/ad set directly and never go
// through createPlan() at all — a model that routes a request through
// meta.create_campaign + meta.create_ad_set instead of the planner flow
// hits zero budget guardrail. A runaway daily_budget is exactly as
// dangerous regardless of which tool created it, so the SAME hard ceiling
// (server/agents/metaExpert/policy.js's MAX_EXECUTABLE_DAILY_BUDGET,
// configurable via META_EXPERT_MAX_EXECUTABLE_DAILY_BUDGET) is enforced
// here unconditionally — this one check is safe to apply to every path
// with no false-positive risk, unlike the goal/objective policy (which
// depends on user intent this raw tool has no way to know — see the round
// 4 completion report for why that one isn't enforced here).
function assertBudgetWithinCap(dailyBudget) {
  if (typeof dailyBudget === "number" && dailyBudget > MAX_EXECUTABLE_DAILY_BUDGET) {
    const err = new Error(
      `A daily budget of ${dailyBudget} exceeds the maximum executable daily budget (${MAX_EXECUTABLE_DAILY_BUDGET}). Propose a lower budget, or this account's approved maximum needs to be raised first (META_EXPERT_MAX_EXECUTABLE_DAILY_BUDGET).`
    );
    err.code = "META_BUDGET_LIMIT_EXCEEDED";
    throw err;
  }
}

function token(context) {
  // Every Meta tool needs a live connection; this throws a clear, tool-level
  // error (caught by the executor) rather than a crash if not connected.
  return requireValidToken(context.userId, "meta_ads");
}

// Confirmed live: an agent called "meta.list_ad_accounts" and got
// "Unknown tool" — this file's older tools (list_ad_accounts,
// list_campaigns, create_campaign, update_campaign, pause_campaign,
// resume_campaign, get_campaign_insights) were never given the "meta."
// prefix the newer ones (meta.list_pages, meta.create_ad_set, etc.) use,
// and the registry does an exact-string lookup — no reasonable way for
// the model to know which half of one integration's tools are prefixed.
// Registering both names (rather than a breaking rename) means whichever
// form the model reaches for resolves to the same tool.
function registerToolAliased(config) {
  registerTool(config);
  if (!config.name.startsWith("meta.")) {
    registerTool({ ...config, name: `meta.${config.name}` });
  }
}

registerToolAliased({
  name: "list_ad_accounts",
  description: "Lists the Meta ad accounts the connected user has access to.",
  category: "meta_ads",
  parameters: { type: "object", properties: {}, required: [] },
  requiredPermissions: ["meta.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const accounts = await meta.listAdAccounts(token(context));
    return { accounts };
  },
});

registerToolAliased({
  name: "list_campaigns",
  description: "Lists campaigns in a Meta ad account. adAccountId is optional — omit it to auto-resolve (works automatically when exactly one ad account is connected; asks for a choice, with the real account names, if there's more than one). Never pass a made-up or reused id — e.g. a Facebook Page id is NOT an ad account id, even though both are plain numbers.",
  category: "meta_ads",
  parameters: {
    type: "object",
    properties: { adAccountId: { type: "string", description: "Optional — a real ad account id from meta.list_ad_accounts. Omit to auto-resolve." } },
    required: [],
  },
  requiredPermissions: ["meta.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const accessToken = token(context);
    const adAccountId = await resolveAdAccountId({ userId: context.userId, accessToken, providedAdAccountId: parameters.adAccountId });
    const campaigns = await meta.listCampaigns(accessToken, adAccountId);
    return { campaigns };
  },
});

registerToolAliased({
  name: "create_campaign",
  description: "Creates a new Meta ad campaign (created PAUSED so nothing spends until manually resumed). This is the top level only — after this, use meta.create_ad_set, then meta.create_image_ad or meta.upload_ad_video + meta.create_video_ad to actually build a runnable ad with a real creative. Optionally pass contentAssetId to link a Content Studio image/copy asset to this campaign for reference — that alone does NOT upload it to Meta as a creative, it just records which generated content the campaign was conceptually built from. adAccountId is optional — omit it to auto-resolve. Never pass a made-up or reused id — e.g. a Facebook Page id is NOT an ad account id, even though both are plain numbers.",
  category: "meta_ads",
  parameters: {
    type: "object",
    properties: {
      adAccountId: { type: "string", description: "Optional — a real ad account id from meta.list_ad_accounts. Omit to auto-resolve." },
      name: { type: "string" },
      objective: { type: "string" }, // e.g. OUTCOME_TRAFFIC, OUTCOME_ENGAGEMENT
      dailyBudget: { type: "number" }, // in the account's smallest currency unit (e.g. cents)
      contentAssetId: { type: "string", description: "Optional Content Studio asset id (image/copy) this campaign is built from" },
    },
    required: ["name", "objective"],
  },
  requiredPermissions: ["meta.write"],
  requiresConfirmation: true, // Creating a campaign involves a budget — always confirm first.
  async execute(parameters, context) {
    assertBudgetWithinCap(parameters.dailyBudget);
    const accessToken = token(context);
    const adAccountId = await resolveAdAccountId({ userId: context.userId, accessToken, providedAdAccountId: parameters.adAccountId });
    const result = await meta.createCampaign(accessToken, adAccountId, {
      name: parameters.name,
      objective: parameters.objective,
      dailyBudget: parameters.dailyBudget,
      status: "PAUSED",
    });
    if (parameters.contentAssetId) {
      linkAssetToCampaign(context.userId, parameters.contentAssetId, result.id);
    }
    // Meta doesn't push ad-account change webhooks to this app — this event
    // is published because OUR OWN tool call just succeeded, not because of
    // an incoming Meta callback. Documented as such in PHASE6.5_NOTES.md.
    publishEvent(context.userId, "meta_ads", "meta_ads_event", { eventSubtype: "campaign_created", campaignId: result.id, name: parameters.name, contentAssetId: parameters.contentAssetId || null });
    return { campaignId: result.id, name: parameters.name, status: "PAUSED", linkedContentAssetId: parameters.contentAssetId || null };
  },
});

registerToolAliased({
  name: "update_campaign",
  description: "Updates fields on an existing Meta campaign (name, budget, etc).",
  category: "meta_ads",
  parameters: {
    type: "object",
    properties: {
      campaignId: { type: "string" },
      name: { type: "string" },
      dailyBudget: { type: "number" },
    },
    required: ["campaignId"],
  },
  requiredPermissions: ["meta.write"],
  requiresConfirmation: true, // Edits a live campaign's budget/config — confirm first.
  async execute(parameters, context) {
    assertBudgetWithinCap(parameters.dailyBudget);
    const fields = {};
    if (parameters.name) fields.name = parameters.name;
    if (parameters.dailyBudget) fields.daily_budget = parameters.dailyBudget;
    await meta.updateCampaign(token(context), parameters.campaignId, fields);
    publishEvent(context.userId, "meta_ads", "meta_ads_event", { eventSubtype: "campaign_updated", campaignId: parameters.campaignId, updated: fields });
    return { campaignId: parameters.campaignId, updated: fields };
  },
});

registerTool({
  name: "meta.list_pages",
  description: "Lists the Facebook Pages the connected account manages — needed to pick which Page an ad's creative posts as before creating an image or video ad.",
  category: "meta_ads",
  parameters: { type: "object", properties: {}, required: [] },
  requiredPermissions: ["meta.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const pages = await meta.listPages(token(context));
    return { pages: pages.map((p) => ({ id: p.id, name: p.name, category: p.category })) };
  },
});

// Exposes a simplified targeting shape rather than Meta's full raw
// targeting spec — the AI constructing an arbitrarily nested Meta targeting
// object correctly (hundreds of possible fields, many mutually exclusive)
// is a much bigger and shakier surface than a few common fields with
// sensible defaults. Covers the common case; doesn't attempt interest/
// behavior targeting, custom audiences, or placement overrides.
export function buildTargeting({ countries, ageMin, ageMax, gender }) {
  const targeting = {
    geo_locations: { countries: countries?.length ? countries : ["US"] },
    age_min: ageMin || 18,
    age_max: ageMax || 65,
  };
  if (gender === "male") targeting.genders = [1];
  else if (gender === "female") targeting.genders = [2];
  return targeting;
}

registerTool({
  name: "meta.create_ad_set",
  description: "Creates an ad set under an existing campaign (created PAUSED) — this is where audience targeting, budget, and optimization goal live in Meta's structure. Required before creating any ad. adAccountId is optional — omit it to auto-resolve. Never pass a made-up or reused id — e.g. a Facebook Page id is NOT an ad account id, even though both are plain numbers.",
  category: "meta_ads",
  parameters: {
    type: "object",
    properties: {
      adAccountId: { type: "string", description: "Optional — a real ad account id from meta.list_ad_accounts. Omit to auto-resolve." },
      campaignId: { type: "string" },
      name: { type: "string" },
      dailyBudget: { type: "number" },
      optimizationGoal: { type: "string", description: "e.g. LINK_CLICKS, REACH, IMPRESSIONS, CONVERSIONS — must be compatible with the campaign's objective" },
      billingEvent: { type: "string", description: "e.g. IMPRESSIONS, LINK_CLICKS" },
      countries: { type: "array", items: { type: "string" }, description: "ISO country codes, e.g. [\"US\",\"CA\"] — defaults to US" },
      ageMin: { type: "number" },
      ageMax: { type: "number" },
      gender: { type: "string", description: "'male', 'female', or omit for all genders" },
    },
    required: ["campaignId", "name", "dailyBudget"],
  },
  requiredPermissions: ["meta.write"],
  requiresConfirmation: true, // Sets real budget + audience — always confirm.
  async execute(parameters, context) {
    assertBudgetWithinCap(parameters.dailyBudget);
    const accessToken = token(context);
    const adAccountId = await resolveAdAccountId({ userId: context.userId, accessToken, providedAdAccountId: parameters.adAccountId });
    const result = await meta.createAdSet(accessToken, adAccountId, {
      name: parameters.name,
      campaign_id: parameters.campaignId,
      daily_budget: parameters.dailyBudget,
      billing_event: parameters.billingEvent || "IMPRESSIONS",
      optimization_goal: parameters.optimizationGoal || "LINK_CLICKS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      targeting: buildTargeting(parameters),
      status: "PAUSED",
    });
    publishEvent(context.userId, "meta_ads", "meta_ads_event", { eventSubtype: "ad_set_created", adSetId: result.id, campaignId: parameters.campaignId, name: parameters.name });
    return { adSetId: result.id, name: parameters.name, status: "PAUSED" };
  },
});

registerTool({
  name: "meta.list_page_posts",
  description: "Lists a Facebook Page's recent organic posts, INCLUDING Facebook Reels — Facebook has its own Reels feature separate from Instagram, so the word 'reel' by itself does not mean Instagram. Use this whenever the user names Facebook (post, reel, or video), to let them pick an existing one to boost as an ad with meta.boost_post. pageId is optional — omit it to auto-resolve (works automatically when exactly one Facebook Page is connected; asks for a choice, with the real Page names, if there's more than one). Never pass a made-up pageId.",
  category: "meta_ads",
  parameters: { type: "object", properties: { pageId: { type: "string", description: "Optional — a real Page id from meta.list_pages. Omit to auto-resolve." } }, required: [] },
  requiredPermissions: ["meta.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const accessToken = token(context);
    const pageId = await resolvePageId({ accessToken, providedPageId: parameters.pageId, userId: context.userId });
    const posts = await meta.listPagePosts(accessToken, pageId);
    return {
      posts: posts.map((p) => ({
        id: p.id, message: p.message || null, createdTime: p.created_time, permalink: p.permalink_url,
        mediaType: p.attachments?.data?.[0]?.media_type || null,
      })),
    };
  },
});

registerTool({
  name: "meta.list_instagram_posts",
  description: "Lists recent posts from the Instagram Business Account connected to a Facebook Page. Use ONLY when the user explicitly says Instagram — Facebook Pages have their own Reels too, so 'reel' by itself is not enough to mean Instagram; for Facebook content (including Facebook Reels) use meta.list_page_posts instead. Use this to let the user pick an existing Instagram post/reel to boost as an ad with meta.boost_post. Returns an empty list (not an error) if the Page has no Instagram account connected, or if reading Instagram content isn't available on this deployment yet (tell the user Facebook post boosting still works either way). pageId is optional — omit it to auto-resolve (works automatically when exactly one Facebook Page is connected; asks for a choice, with the real Page names, if there's more than one). Never pass a made-up pageId.",
  category: "meta_ads",
  parameters: { type: "object", properties: { pageId: { type: "string", description: "Optional — a real Page id from meta.list_pages. Omit to auto-resolve." } }, required: [] },
  requiredPermissions: ["meta.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const accessToken = token(context);
    const pageId = await resolvePageId({ accessToken, providedPageId: parameters.pageId, userId: context.userId });
    const igAccountId = await meta.getInstagramAccountId(accessToken, pageId);
    if (!igAccountId) return { posts: [], instagramConnected: false };
    // Reading Page metadata (above) and reading actual Instagram content
    // (below) need different permissions — this app currently only
    // requests the former (see oauth.js's SCOPES comment on why
    // instagram_basic isn't requested), so this can legitimately fail
    // even when an IG account IS linked. Degrade to an empty list with a
    // clear reason rather than surfacing Meta's raw permission error.
    try {
      const posts = await meta.listInstagramPosts(accessToken, igAccountId);
      return {
        instagramConnected: true,
        posts: posts.map((p) => ({ id: p.id, caption: p.caption || null, mediaType: p.media_type, mediaUrl: p.media_url, permalink: p.permalink, timestamp: p.timestamp })),
      };
    } catch (err) {
      return { instagramConnected: true, posts: [], reason: `Instagram account is linked, but reading its posts isn't available yet (${err.message}). Facebook post boosting still works.` };
    }
  },
});

registerTool({
  name: "meta.boost_post",
  description: "Creates an ad from an EXISTING Facebook Page post or Instagram post/reel (Meta's own 'Boost Post' mechanism) instead of new creative — the ad runs the post's own content as-is. Created PAUSED. Requires an ad set already created with meta.create_ad_set. Pass exactly one of: postId (a Facebook post id from meta.list_page_posts) or instagramMediaId + pageId (an Instagram post from meta.list_instagram_posts). adAccountId is optional — omit it to auto-resolve. Never pass a made-up or reused id — e.g. a Facebook Page id is NOT an ad account id, even though both are plain numbers.",
  category: "meta_ads",
  parameters: {
    type: "object",
    properties: {
      adAccountId: { type: "string", description: "Optional — a real ad account id from meta.list_ad_accounts. Omit to auto-resolve." },
      adSetId: { type: "string" },
      name: { type: "string" },
      postId: { type: "string" },
      instagramMediaId: { type: "string" },
      pageId: { type: "string", description: "Only relevant with instagramMediaId — not needed for postId. Optional even then: omit it to auto-resolve. Never pass a made-up value." },
    },
    required: ["adSetId", "name"],
  },
  requiredPermissions: ["meta.write"],
  requiresConfirmation: true, // Creates a real, launchable ad — always confirm.
  async execute(parameters, context) {
    if (Boolean(parameters.postId) === Boolean(parameters.instagramMediaId)) {
      throw new Error("Provide exactly one of: postId (a Facebook post) or instagramMediaId (an Instagram post).");
    }
    const accessToken = token(context);
    const adAccountId = await resolveAdAccountId({ userId: context.userId, accessToken, providedAdAccountId: parameters.adAccountId });
    let creativeFields;
    if (parameters.postId) {
      // postId from meta.list_page_posts is already in Meta's own
      // "{page_id}_{post_id}" composite form — object_story_id wants
      // exactly that, no reconstruction needed.
      creativeFields = { name: `${parameters.name} — creative`, object_story_id: parameters.postId };
    } else {
      const pageId = await resolvePageId({ accessToken, providedPageId: parameters.pageId, userId: context.userId });
      const igAccountId = await meta.getInstagramAccountId(accessToken, pageId);
      if (!igAccountId) throw new Error("This Page has no Instagram Business Account connected.");
      creativeFields = { name: `${parameters.name} — creative`, instagram_actor_id: igAccountId, source_instagram_media_id: parameters.instagramMediaId };
    }
    const creative = await meta.createAdCreative(accessToken, adAccountId, creativeFields);
    const ad = await meta.createAd(accessToken, adAccountId, {
      name: parameters.name,
      adset_id: parameters.adSetId,
      creative: { creative_id: creative.id },
      status: "PAUSED",
    });
    publishEvent(context.userId, "meta_ads", "meta_ads_event", { eventSubtype: "ad_created", adId: ad.id, adSetId: parameters.adSetId, name: parameters.name, format: "boosted_post" });
    return { adId: ad.id, creativeId: creative.id, status: "PAUSED" };
  },
});

registerTool({
  name: "meta.create_image_ad",
  description: "Creates a single-image Meta ad — uploads the image, creates the ad creative, and creates the ad, all PAUSED so nothing spends until manually resumed. Requires an ad set already created with meta.create_ad_set and a page id from meta.list_pages. Pass exactly one image source: imageReferenceId (a photo the user attached in this chat), imageUrl (a public image URL — e.g. a WooCommerce/Shopify product's own image from woocommerce.list_products/shopify.list_products), or contentAssetId (an image id returned by generate_image, for an ad the agent designed itself).",
  category: "meta_ads",
  parameters: {
    type: "object",
    properties: {
      adAccountId: { type: "string", description: "Optional — a real ad account id from meta.list_ad_accounts. Omit to auto-resolve." },
      adSetId: { type: "string" },
      pageId: { type: "string", description: "Optional — a real Page id from meta.list_pages. Omit to auto-resolve. Never pass a made-up value." },
      name: { type: "string" },
      imageReferenceId: { type: "string" },
      imageUrl: { type: "string" },
      contentAssetId: { type: "string" },
      primaryText: { type: "string" },
      headline: { type: "string" },
      description: { type: "string" },
      link: { type: "string" },
      callToAction: { type: "string", description: "e.g. LEARN_MORE, SHOP_NOW, SIGN_UP, DOWNLOAD" },
    },
    required: ["adSetId", "name", "primaryText", "headline", "link"],
  },
  requiredPermissions: ["meta.write"],
  requiresConfirmation: true, // Creates a real, launchable ad — always confirm.
  async execute(parameters, context) {
    const imageSourcesGiven = [parameters.imageReferenceId, parameters.imageUrl, parameters.contentAssetId].filter(Boolean).length;
    if (imageSourcesGiven !== 1) {
      throw new Error("Provide exactly one of: imageReferenceId (a chat-attached photo), imageUrl (a public image URL), or contentAssetId (a generate_image result).");
    }
    const accessToken = token(context);
    const adAccountId = await resolveAdAccountId({ userId: context.userId, accessToken, providedAdAccountId: parameters.adAccountId });
    const pageId = await resolvePageId({ accessToken, providedPageId: parameters.pageId, userId: context.userId });
    let base64;
    if (parameters.imageReferenceId) {
      const { buffer } = resolveChatImage(context.userId, parameters.imageReferenceId);
      base64 = buffer.toString("base64");
    } else if (parameters.contentAssetId) {
      const { buffer } = await resolveContentImageAsset(context.userId, parameters.contentAssetId);
      base64 = buffer.toString("base64");
    } else {
      const imgRes = await fetch(parameters.imageUrl);
      if (!imgRes.ok) throw new Error(`Could not fetch image from ${parameters.imageUrl}`);
      base64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");
    }
    const { hash } = await meta.uploadAdImage(accessToken, adAccountId, base64);
    const creative = await meta.createAdCreative(accessToken, adAccountId, {
      name: `${parameters.name} — creative`,
      object_story_spec: {
        page_id: pageId,
        link_data: {
          image_hash: hash,
          message: parameters.primaryText,
          name: parameters.headline,
          description: parameters.description,
          link: parameters.link,
          call_to_action: parameters.callToAction ? { type: parameters.callToAction } : undefined,
        },
      },
    });
    const ad = await meta.createAd(accessToken, adAccountId, {
      name: parameters.name,
      adset_id: parameters.adSetId,
      creative: { creative_id: creative.id },
      status: "PAUSED",
    });
    publishEvent(context.userId, "meta_ads", "meta_ads_event", { eventSubtype: "ad_created", adId: ad.id, adSetId: parameters.adSetId, name: parameters.name, format: "image" });
    return { adId: ad.id, creativeId: creative.id, status: "PAUSED" };
  },
});

registerTool({
  name: "meta.upload_ad_video",
  description: "Uploads a video (from a public URL) to Meta for use in a video ad. Returns immediately with a videoId — Meta processes the video in the background, which can take up to a minute or two, so this does NOT wait for it to finish. Follow up with meta.create_video_ad once you have the videoId; if it's not ready yet, that call will say so clearly and you can just try it again shortly. adAccountId is optional — omit it to auto-resolve. Never pass a made-up or reused id — e.g. a Facebook Page id is NOT an ad account id, even though both are plain numbers.",
  category: "meta_ads",
  parameters: {
    type: "object",
    properties: {
      adAccountId: { type: "string", description: "Optional — a real ad account id from meta.list_ad_accounts. Omit to auto-resolve." },
      videoUrl: { type: "string" },
      name: { type: "string" },
    },
    required: ["videoUrl", "name"],
  },
  requiredPermissions: ["meta.write"],
  requiresConfirmation: false, // Uploading alone doesn't create anything that spends — the ad creation step does.
  async execute(parameters, context) {
    const accessToken = token(context);
    const adAccountId = await resolveAdAccountId({ userId: context.userId, accessToken, providedAdAccountId: parameters.adAccountId });
    const result = await meta.uploadAdVideoFromUrl(accessToken, adAccountId, parameters.videoUrl, parameters.name);
    return { videoId: result.videoId, status: "processing" };
  },
});

registerTool({
  name: "meta.create_video_ad",
  description: "Creates a single-video Meta ad from a videoId returned by meta.upload_ad_video — creates the ad creative and the ad, PAUSED so nothing spends until manually resumed. Requires an ad set already created with meta.create_ad_set and a page id from meta.list_pages. If Meta hasn't finished processing the video yet, this fails with a clear message — just try again in a minute, no need to re-upload. adAccountId is optional — omit it to auto-resolve. Never pass a made-up or reused id — e.g. a Facebook Page id is NOT an ad account id, even though both are plain numbers.",
  category: "meta_ads",
  parameters: {
    type: "object",
    properties: {
      adAccountId: { type: "string", description: "Optional — a real ad account id from meta.list_ad_accounts. Omit to auto-resolve." },
      adSetId: { type: "string" },
      pageId: { type: "string", description: "Optional — a real Page id from meta.list_pages. Omit to auto-resolve. Never pass a made-up value." },
      name: { type: "string" },
      videoId: { type: "string" },
      thumbnailUrl: { type: "string", description: "Public image URL to use as the video's thumbnail" },
      primaryText: { type: "string" },
      headline: { type: "string" },
      link: { type: "string" },
      callToAction: { type: "string", description: "e.g. LEARN_MORE, SHOP_NOW, SIGN_UP, DOWNLOAD" },
    },
    required: ["adSetId", "name", "videoId", "link"],
  },
  requiredPermissions: ["meta.write"],
  requiresConfirmation: true, // Creates a real, launchable ad — always confirm.
  async execute(parameters, context) {
    const accessToken = token(context);
    const adAccountId = await resolveAdAccountId({ userId: context.userId, accessToken, providedAdAccountId: parameters.adAccountId });
    const pageId = await resolvePageId({ accessToken, providedPageId: parameters.pageId, userId: context.userId });
    const creative = await meta.createAdCreative(accessToken, adAccountId, {
      name: `${parameters.name} — creative`,
      object_story_spec: {
        page_id: pageId,
        video_data: {
          video_id: parameters.videoId,
          image_url: parameters.thumbnailUrl,
          message: parameters.primaryText,
          title: parameters.headline,
          link_description: parameters.link,
          call_to_action: parameters.callToAction ? { type: parameters.callToAction, value: { link: parameters.link } } : undefined,
        },
      },
    });
    const ad = await meta.createAd(accessToken, adAccountId, {
      name: parameters.name,
      adset_id: parameters.adSetId,
      creative: { creative_id: creative.id },
      status: "PAUSED",
    });
    publishEvent(context.userId, "meta_ads", "meta_ads_event", { eventSubtype: "ad_created", adId: ad.id, adSetId: parameters.adSetId, name: parameters.name, format: "video" });
    return { adId: ad.id, creativeId: creative.id, status: "PAUSED" };
  },
});

registerToolAliased({
  name: "pause_campaign",
  description: "Pauses a running Meta campaign, stopping spend.",
  category: "meta_ads",
  parameters: {
    type: "object",
    properties: { campaignId: { type: "string" } },
    required: ["campaignId"],
  },
  requiredPermissions: ["meta.manage"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    await meta.setCampaignStatus(token(context), parameters.campaignId, "PAUSED");
    publishEvent(context.userId, "meta_ads", "meta_ads_event", { eventSubtype: "campaign_paused", campaignId: parameters.campaignId });
    return { campaignId: parameters.campaignId, status: "PAUSED" };
  },
});

registerToolAliased({
  name: "resume_campaign",
  description: "Resumes a paused Meta campaign, allowing it to spend budget again.",
  category: "meta_ads",
  parameters: {
    type: "object",
    properties: { campaignId: { type: "string" } },
    required: ["campaignId"],
  },
  requiredPermissions: ["meta.manage"],
  requiresConfirmation: true, // Resuming re-enables real ad spend — always confirm.
  async execute(parameters, context) {
    await meta.setCampaignStatus(token(context), parameters.campaignId, "ACTIVE");
    publishEvent(context.userId, "meta_ads", "meta_ads_event", { eventSubtype: "campaign_resumed", campaignId: parameters.campaignId });
    return { campaignId: parameters.campaignId, status: "ACTIVE" };
  },
});

registerToolAliased({
  name: "get_campaign_insights",
  description: "Returns performance insights (impressions, clicks, spend, CTR, CPC, reach) for a campaign.",
  category: "meta_ads",
  parameters: {
    type: "object",
    properties: {
      campaignId: { type: "string" },
      datePreset: { type: "string" }, // e.g. last_7d, last_30d
    },
    required: ["campaignId"],
  },
  requiredPermissions: ["meta.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const insights = await meta.getCampaignInsights(token(context), parameters.campaignId, parameters.datePreset || "last_30d");
    return { campaignId: parameters.campaignId, insights };
  },
});
