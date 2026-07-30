export async function braveSearch({ query, apiKey }) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
  const res = await fetch(url, { headers: { "X-Subscription-Token": apiKey, accept: "application/json" } });
  if (!res.ok) throw new Error(`Brave Search error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.web?.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.description }));
}
