import { registerTool } from "../registry.js";
import { chatComplete } from "../../ai/provider.js";

const REPORT_SYSTEM_PROMPT = `You are a research analyst. Given a topic and a set of source findings
(each with a URL, title, and extracted text), produce a structured research report.

Respond with ONLY a single JSON object, no other text, in this exact shape:
{
  "executiveSummary": "<2-4 sentences>",
  "keyFindings": ["<finding>", ...],
  "statistics": ["<stat, cited from a source, or omit if none found>", ...],
  "pros": ["..."],
  "cons": ["..."],
  "marketInsights": ["..."],
  "recommendations": ["..."],
  "sources": [{"title": "<title>", "url": "<url>"}, ...]
}

Rules:
- Only state something as a statistic or fact if it is directly supported by the
  provided findings. If information is thin, say so in executiveSummary rather
  than inventing figures.
- "recommendations" and any interpretive claims are your own analysis — the
  frontend will label this section as AI-generated, so keep it clearly separate
  from keyFindings drawn from sources.
- Output raw JSON only — no markdown fences, no commentary.`;

function safeParseReport(text) {
  const cleaned = text.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return { executiveSummary: text.trim(), keyFindings: [], statistics: [], pros: [], cons: [], marketInsights: [], recommendations: [], sources: [] };
  }
}

registerTool({
  name: "generate_report",
  description: "Synthesizes web_search results and read_webpage content into a structured research report with cited sources.",
  category: "research",
  parameters: {
    type: "object",
    properties: {
      topic: { type: "string" },
      findings: { type: "array" }, // [{ url, title, extract }]
    },
    required: ["topic", "findings"],
  },
  requiredPermissions: ["research.read"],
  requiresConfirmation: false,
  async execute(parameters) {
    const findingsText = (parameters.findings || [])
      .map((f, i) => `Source ${i + 1}: ${f.title || f.url}\nURL: ${f.url}\nExtract: ${(f.extract || "").slice(0, 1500)}`)
      .join("\n\n");

    const raw = await chatComplete({
      systemPrompt: REPORT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Topic: ${parameters.topic}\n\n${findingsText || "(no source findings provided)"}` }],
    });

    const report = safeParseReport(raw);
    return { topic: parameters.topic, report };
  },
});
