// Deliberately dependency-free (no cheerio/jsdom) so it installs without any
// native build step. This is a best-effort extractor, not a full readability
// parser — it strips script/style/nav-like noise and returns plain text.

function extractTag(html, tag) {
  const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? stripTags(match[1]).trim() : null;
}

function extractAllHeadings(html) {
  const headings = [];
  const re = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi;
  let m;
  while ((m = re.exec(html)) && headings.length < 12) {
    const text = stripTags(m[1]).trim();
    if (text) headings.push(text);
  }
  return headings;
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"');
}

function extractMainText(html, maxChars) {
  let body = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  body = body.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, "");
  const text = stripTags(body).replace(/\s+/g, " ").trim();
  return text.slice(0, maxChars);
}

function findMeta(html, name) {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`, "i");
  const match = html.match(re);
  return match ? match[1] : null;
}

export async function readWebpage(url, { maxChars = 4000 } = {}) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) {
    const err = new Error(`Could not fetch page (${res.status})`);
    err.code = res.status === 403 ? "BLOCKED" : "FETCH_FAILED";
    throw err;
  }
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) throw new Error(`URL did not return an HTML page (${contentType || "unknown type"})`);
  const html = await res.text();

  return {
    url,
    title: extractTag(html, "title"),
    headings: extractAllHeadings(html),
    content: extractMainText(html, maxChars),
    publishDate: findMeta(html, "article:published_time") || findMeta(html, "date") || null,
    author: findMeta(html, "author") || null,
  };
}
