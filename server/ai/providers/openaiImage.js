// OpenAI Images API adapter. gpt-image-1 is the default model — unlike
// dall-e-3/dall-e-2, it doesn't take a response_format param and always
// returns base64 image data directly, which simplifies this file (no URL
// fetch step). Endpoint reference verified against openai-node's SDK
// source rather than assumed from memory, since this is exactly the kind
// of API-shape detail that's easy to get subtly wrong.
import { resilientFetch } from "../resilientFetch.js";

const DEFAULT_MODEL = "gpt-image-1";

// Image generation is slow (60-90s+ observed in real device testing) and
// expensive per call — the opposite of what a short-timeout+auto-retry
// policy is safe for. retries: 0 here specifically: retrying a request
// that timed out on OUR end but is still being billed/rendered on
// OpenAI's end would risk generating (and paying for) the image twice.
// A generous timeout instead of a retry is the safe way to give this the
// room it actually needs.
const IMAGE_RESILIENCE = { timeoutMs: 120_000, retries: 0, circuitKey: "openai_image" };

function b64ImagesToBuffers(data) {
  return (data || []).map((d) => ({
    buffer: Buffer.from(d.b64_json, "base64"),
    revisedPrompt: d.revised_prompt || null,
  }));
}

export async function openaiGenerateImage({
  prompt, apiKey, model = DEFAULT_MODEL, size = "1024x1024", quality = "auto", numImages = 1, background,
}) {
  const body = { model, prompt, n: Math.min(Math.max(numImages, 1), 10), size, quality };
  if (background) body.background = background; // 'transparent' | 'opaque' | 'auto' — gpt-image models only
  if (model.startsWith("dall-e")) {
    // dall-e-3 only supports n=1; the OpenAI API itself enforces this and
    // returns a clear 400 if violated, so this isn't silently "fixed" here.
    delete body.background;
  }

  const res = await resilientFetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  }, IMAGE_RESILIENCE);
  if (!res.ok) throw new Error(`OpenAI image generation error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { images: b64ImagesToBuffers(data.data), model };
}

// Image-to-image / editing / transparent-background generation — OpenAI's
// single /images/edits endpoint covers all three depending on the prompt
// and whether `background` is set; there's no separate endpoint per
// operation the way the spec's control list implies.
export async function openaiEditImage({
  prompt, apiKey, model = DEFAULT_MODEL, imageBuffer, imageMimeType = "image/png", maskBuffer, size = "1024x1024", numImages = 1, background,
}) {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("n", String(Math.min(Math.max(numImages, 1), 10)));
  form.append("size", size);
  if (background) form.append("background", background);
  form.append("image", new Blob([imageBuffer], { type: imageMimeType }), "image.png");
  if (maskBuffer) form.append("mask", new Blob([maskBuffer], { type: "image/png" }), "mask.png");

  const res = await resilientFetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  }, IMAGE_RESILIENCE);
  if (!res.ok) throw new Error(`OpenAI image edit error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { images: b64ImagesToBuffers(data.data), model };
}

// Declares exactly what this provider actually supports, so the UI never
// offers a control (seed, negative prompt, true outpainting/expansion,
// variations) the API doesn't have — OpenAI's Images API has no seed or
// negative-prompt parameter at all, and no dedicated variations endpoint
// for gpt-image-1 (only legacy dall-e-2).
export const OPENAI_IMAGE_CAPABILITIES = {
  textToImage: true,
  imageToImage: true,
  editing: true,
  backgroundRemoval: true, // via background:'transparent' on an edit
  backgroundReplacement: true, // via edit + prompt
  imageExpansion: false,
  variations: false,
  negativePrompt: false,
  seed: false,
  aspectRatios: ["1:1", "3:2", "2:3"], // derived from the size options below
  resolutions: ["1024x1024", "1536x1024", "1024x1536", "auto"],
  qualities: ["low", "medium", "high", "auto"],
  maxImagesPerRequest: 10,
  // Rough per-image estimate at "medium" quality/1024x1024 — OpenAI bills
  // by tokens for gpt-image-1, not a flat per-image rate, so this is
  // deliberately approximate, shown to the user as an estimate, not a quote.
  estimatedCostCentsPerImage: 4,
};
