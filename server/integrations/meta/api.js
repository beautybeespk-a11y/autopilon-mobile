const API_VERSION = process.env.META_API_VERSION || "v19.0";
const BASE = `https://graph.facebook.com/${API_VERSION}`;

async function metaFetch(path, { accessToken, method = "GET", body }) {
  const url = new URL(`${BASE}${path}`);
  if (method === "GET") url.searchParams.set("access_token", accessToken);
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify({ ...body, access_token: method !== "GET" ? accessToken : undefined }) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || `Meta API error ${res.status}`;
    const err = new Error(message);
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

// Meta ad account IDs must be prefixed with "act_" for every API call — an
// ID given without it (e.g. copied from an account's display name, which is
// sometimes just the raw number) causes a confusing "(#100) nonexisting
// field" error rather than a clear "bad ID" one. Normalize defensively
// rather than relying on every caller (including the AI) getting it right.
function normalizeAdAccountId(id) {
  return id.startsWith("act_") ? id : `act_${id}`;
}

export async function listAdAccounts(accessToken) {
  const data = await metaFetch("/me/adaccounts?fields=id,name,account_status,currency", { accessToken });
  return data.data || [];
}

export async function listCampaigns(accessToken, adAccountId) {
  const data = await metaFetch(`/${normalizeAdAccountId(adAccountId)}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget`, { accessToken });
  return data.data || [];
}

export async function createCampaign(accessToken, adAccountId, { name, objective, dailyBudget, status = "PAUSED" }) {
  return metaFetch(`/${normalizeAdAccountId(adAccountId)}/campaigns`, {
    accessToken,
    method: "POST",
    body: { name, objective, status, daily_budget: dailyBudget, special_ad_categories: [] },
  });
}

export async function updateCampaign(accessToken, campaignId, fields) {
  return metaFetch(`/${campaignId}`, { accessToken, method: "POST", body: fields });
}

export async function setCampaignStatus(accessToken, campaignId, status) {
  return metaFetch(`/${campaignId}`, { accessToken, method: "POST", body: { status } });
}

export async function getCampaignInsights(accessToken, campaignId, datePreset = "last_30d") {
  const data = await metaFetch(
    `/${campaignId}/insights?fields=impressions,clicks,spend,ctr,cpc,reach&date_preset=${datePreset}`,
    { accessToken }
  );
  return data.data?.[0] || null;
}
