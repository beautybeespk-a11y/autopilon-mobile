export async function serpapiSearch({ query, apiKey }) {
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SerpAPI error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.organic_results || []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet }));
}
