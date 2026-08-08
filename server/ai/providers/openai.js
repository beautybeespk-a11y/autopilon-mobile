export async function openaiChat({ messages, systemPrompt, apiKey, model: modelOverride }) {
  const model = modelOverride || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const full = systemPrompt ? [{ role: "system", content: systemPrompt }, ...messages] : messages;
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

  return content || "";
}
