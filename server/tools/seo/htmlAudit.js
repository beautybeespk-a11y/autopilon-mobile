// Deliberately dependency-free (no cheerio/jsdom) so it installs without any
// native build step — same approach as research/htmlExtract.js's readWebpage,
// which this reuses the fetch/UA pattern from. This is a best-effort on-page
// SEO audit, not a full technical SEO crawler: single page only, no crawling
// of internal links, no JS-rendered content (fetches raw HTML as served).

function extractTag(html, tag) {
  const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? stripTags(match[1]).trim() : null;
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&#x27;|&rsquo;/gi, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

function findMetaByName(html, name) {
  const re = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["']`, "i");
  const match = html.match(re) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${name}["']`, "i"));
  return match ? match[1] : null;
}

function findMetaByProperty(html, property) {
  const re = new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, "i");
  const match = html.match(re) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`, "i"));
  return match ? match[1] : null;
}

function findLinkHref(html, rel) {
  const re = new RegExp(`<link[^>]+rel=["']${rel}["'][^>]+href=["']([^"']*)["']`, "i");
  const match = html.match(re) || html.match(new RegExp(`<link[^>]+href=["']([^"']*)["'][^>]+rel=["']${rel}["']`, "i"));
  return match ? match[1] : null;
}

function extractHeadings(html, level) {
  const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)</h${level}>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(html)) && out.length < 20) {
    const text = stripTags(m[1]);
    if (text) out.push(text);
  }
  return out;
}

function auditImages(html) {
  const re = /<img\b[^>]*>/gi;
  let total = 0;
  let missingAlt = 0;
  let m;
  while ((m = re.exec(html))) {
    total += 1;
    const altMatch = m[0].match(/\balt=["']([^"']*)["']/i);
    if (!altMatch || !altMatch[1].trim()) missingAlt += 1;
  }
  return { total, missingAlt };
}

function auditLinks(html, pageUrl) {
  const re = /<a\b[^>]*\bhref=["']([^"'#][^"']*)["'][^>]*>/gi;
  let internal = 0;
  let external = 0;
  let pageHost;
  try { pageHost = new URL(pageUrl).hostname; } catch { pageHost = null; }
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
    if (/^https?:\/\//i.test(href)) {
      try {
        const linkHost = new URL(href).hostname;
        if (pageHost && linkHost === pageHost) internal += 1; else external += 1;
      } catch { /* malformed href, skip */ }
    } else {
      internal += 1; // relative link
    }
  }
  return { internal, external, total: internal + external };
}

function bodyWordCount(html) {
  let body = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  body = body.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, "");
  const text = stripTags(body);
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

// Straightforward rule-of-thumb thresholds (Google's own guidance ranges,
// not a scoring algorithm) — the point is surfacing real, specific issues
// an agent can explain and act on, not producing a single opaque "score"
// (that's what the PageSpeed Insights categories are for, see pageSpeed.js).
function buildIssues(a) {
  const issues = [];
  if (!a.title.present) issues.push({ severity: "error", message: "No <title> tag found." });
  else if (a.title.length < 15) issues.push({ severity: "warning", message: `Title is only ${a.title.length} characters — likely too short to be descriptive (aim for ~50-60).` });
  else if (a.title.length > 65) issues.push({ severity: "warning", message: `Title is ${a.title.length} characters — Google typically truncates titles beyond ~60.` });

  if (!a.metaDescription.present) issues.push({ severity: "error", message: "No meta description found." });
  else if (a.metaDescription.length < 50) issues.push({ severity: "warning", message: `Meta description is only ${a.metaDescription.length} characters — likely too short (aim for ~120-160).` });
  else if (a.metaDescription.length > 165) issues.push({ severity: "warning", message: `Meta description is ${a.metaDescription.length} characters — Google typically truncates beyond ~160.` });

  if (a.h1.count === 0) issues.push({ severity: "error", message: "No <h1> heading found." });
  else if (a.h1.count > 1) issues.push({ severity: "warning", message: `Found ${a.h1.count} <h1> tags — pages should generally have exactly one.` });

  if (!a.canonical) issues.push({ severity: "warning", message: "No canonical link tag found." });
  if (a.robotsMeta && /noindex/i.test(a.robotsMeta)) issues.push({ severity: "error", message: `robots meta tag blocks indexing: "${a.robotsMeta}".` });
  if (!a.viewportMeta) issues.push({ severity: "warning", message: "No viewport meta tag — page may not be mobile-friendly." });

  if (a.images.total > 0 && a.images.missingAlt > 0) {
    issues.push({ severity: "warning", message: `${a.images.missingAlt} of ${a.images.total} images are missing alt text.` });
  }
  if (!a.openGraph.title || !a.openGraph.description) {
    issues.push({ severity: "info", message: "Missing Open Graph title/description — links to this page may show blank previews when shared." });
  }
  if (a.wordCount < 300) issues.push({ severity: "info", message: `Only ${a.wordCount} words of body content — thin content can rank poorly for competitive keywords.` });

  return issues;
}

export async function auditPageSeo(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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

  const titleText = extractTag(html, "title");
  const descText = findMetaByName(html, "description");
  const h1s = extractHeadings(html, 1);

  const audit = {
    url,
    title: { present: Boolean(titleText), text: titleText, length: titleText ? titleText.length : 0 },
    metaDescription: { present: Boolean(descText), text: descText, length: descText ? descText.length : 0 },
    h1: { count: h1s.length, texts: h1s },
    h2Count: extractHeadings(html, 2).length,
    canonical: findLinkHref(html, "canonical"),
    robotsMeta: findMetaByName(html, "robots"),
    viewportMeta: Boolean(findMetaByName(html, "viewport")),
    openGraph: {
      title: findMetaByProperty(html, "og:title"),
      description: findMetaByProperty(html, "og:description"),
      image: findMetaByProperty(html, "og:image"),
    },
    images: auditImages(html),
    links: auditLinks(html, url),
    wordCount: bodyWordCount(html),
  };
  audit.issues = buildIssues(audit);
  return audit;
}
