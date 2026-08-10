export async function openaiChat({ messages, systemPrompt, apiKey, model: modelOverride }) {
  const model = modelOverride || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const normalized = messages.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: Array.isArray(m.content)
      ? m.content.map((part) =>
          part.type === "image"
            ? { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } }
            : { type: "text", text: part.text }
        )
      : m.content,
  }));
  const full = systemPrompt ? [{ role: "system", content: systemPrompt }, ...normalized] : normalized;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: full, max_tokens: 4096 }),
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let content = data.choices?.[0]?.message?.content;

  // Some responses come back as an array of content parts (e.g.
  // [{ type: "text", text: "..." }]) rather than a plain string — flatten
  // it so callers always get a string, same as the normal case.
  if (Array.isArray(content)) {
    content = content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  }

  // Standardized to { text, usage } to match the Anthropic/Gemini adapters —
  // every caller (orchestrator, draftWorkflow, generateReport, stepExecutor)
  // reads chatComplete()'s result as an object, not a bare string.
  return { text: content || "", usage: { promptTokens: data.usage?.prompt_tokens || 0, completionTokens: data.usage?.completion_tokens || 0 } };
}
