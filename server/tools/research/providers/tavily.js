export async function tavilySearch({ query, apiKey }) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: 5 }),
  });
  if (!res.ok) throw new Error(`Tavily error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
}
