import { chatComplete } from "../ai/provider.js";
import { createTextAsset, recordFailedTextGeneration } from "./contentService.js";
import { getBrand } from "./brandService.js";
import { enforceQuota } from "./billing.js";

// Every entry maps a content_assets.contentType to how the Copywriter
// should brief the model — reuses chatComplete() (ai/provider.js) exactly
// like every other text-generating tool in this codebase (generateReport.js,
// summarize_document), never a separate text-generation path.
const COPY_TYPES = {
  caption: { label: "Social Caption", instruction: "Write a short, scroll-stopping social media caption." },
  hashtags: { label: "Hashtags", instruction: "Suggest a focused set of relevant hashtags (mix of broad and niche), as a plain space-separated list." },
  ad_copy: { label: "Ad Copy", instruction: "Write persuasive ad copy with a clear hook and a strong call to action." },
  product_description: { label: "Product Description", instruction: "Write a compelling product description that highlights benefits, not just features." },
  blog: { label: "Blog Post", instruction: "Write a well-structured blog post with a clear introduction, body, and conclusion. Use headings where helpful." },
  email: { label: "Email", instruction: "Write a marketing/outreach email with a subject line, a clear body, and a call to action." },
  headline: { label: "Headline", instruction: "Write 5 alternative headline options, each on its own line." },
  hook: { label: "Hook", instruction: "Write 5 alternative opening hooks (the first 1-2 sentences meant to stop someone from scrolling), each on its own line." },
  cta: { label: "Call to Action", instruction: "Write 5 alternative calls to action, each on its own line." },
  script: { label: "Script", instruction: "Write a short video/voiceover script, formatted with clear scene/line breaks." },
  seo_content: { label: "SEO Content", instruction: "Write SEO-oriented content that naturally incorporates the given keywords without keyword-stuffing." },
  ugc_script: {
    label: "UGC Script",
    instruction:
      "Write a UGC-style (user-generated-content style) video script: an authentic, casual, first-person script a real customer/creator would read on camera — not a polished ad. Include scene/shot notes in brackets.",
  },
};

export function listCopyTypes() {
  return Object.entries(COPY_TYPES).map(([id, v]) => ({ id, label: v.label }));
}

function buildSystemPrompt({ type, brand, tone, targetAudience }) {
  const parts = [
    "You are an expert marketing copywriter working inside a business's AI Content Studio.",
    COPY_TYPES[type]?.instruction || "Write high-quality marketing copy for the given brief.",
  ];
  if (brand) {
    parts.push(`Brand: ${brand.name}.${brand.description ? ` ${brand.description}` : ""}`);
    if (brand.tone) parts.push(`Brand tone: ${brand.tone}.`);
    if (brand.writingStyle) parts.push(`Writing style: ${brand.writingStyle}.`);
    if (brand.targetAudience) parts.push(`Target audience: ${brand.targetAudience}.`);
    if (brand.ctaStyle) parts.push(`Preferred CTA style: ${brand.ctaStyle}.`);
    // brandService.getBrand() already returns these as parsed arrays, not
    // raw JSON strings — don't parse them a second time.
    const preferred = brand.preferredWords || [];
    const avoid = brand.avoidWords || [];
    if (preferred.length) parts.push(`Favor these words/phrases where natural: ${preferred.join(", ")}.`);
    if (avoid.length) parts.push(`Never use these words/phrases: ${avoid.join(", ")}.`);
    if (brand.guidelines) parts.push(`Additional brand guidelines: ${brand.guidelines}`);
  }
  // Per-request tone/audience override or supplement whatever the brand already specifies.
  if (tone) parts.push(`Tone for this piece specifically: ${tone}.`);
  if (targetAudience) parts.push(`Target audience for this piece specifically: ${targetAudience}.`);
  parts.push("Output only the requested copy — no preamble, no explanation, no markdown headers unless the format calls for them.");
  return parts.join("\n");
}

export async function generateCopy({ userId, orgId, workspaceId, projectId, agentId, contentType, brief, brandId, tone, targetAudience, keywords, title }) {
  if (!COPY_TYPES[contentType]) {
    const err = new Error(`Unknown copy type "${contentType}". Supported: ${Object.keys(COPY_TYPES).join(", ")}`);
    err.code = "INVALID";
    throw err;
  }
  // Checked BEFORE the provider call, not after — createTextAsset() below
  // also enforces this, but by then the (billable) generation would have
  // already happened. Quota must gate the spend, not just the bookkeeping.
  if (orgId) enforceQuota(orgId, "maxAiRequests", "AI requests");

  const brand = brandId ? getBrand(userId, brandId) : null;
  const systemPrompt = buildSystemPrompt({ type: contentType, brand, tone, targetAudience });
  const userMessage = keywords?.length ? `${brief}\n\nKeywords to incorporate: ${keywords.join(", ")}` : brief;

  let completion;
  try {
    completion = await chatComplete({ systemPrompt, messages: [{ role: "user", content: userMessage }] });
  } catch (err) {
    // Same "failures are visible in the library, never silently dropped"
    // principle generateImageAsset already follows — this was previously
    // missing here, so a copy-generation failure just threw with nothing
    // to show for it.
    const assetId = recordFailedTextGeneration({
      userId, orgId, workspaceId, projectId, agentId, contentType,
      title: title || brief.slice(0, 60), prompt: brief,
      errorMessage: err.code === "PROVIDER_NOT_CONFIGURED" ? (err.detail || err.message) : "Copy generation failed.",
    });
    throw Object.assign(err, { assetId });
  }

  return createTextAsset({
    userId, orgId, workspaceId, projectId, agentId, contentType,
    title: title || brief.slice(0, 60),
    textContent: completion.text,
    provider: process.env.AI_PROVIDER || "anthropic",
    prompt: brief,
  });
}
