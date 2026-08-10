export async function anthropicChat({ messages, systemPrompt, apiKey, model: modelOverride }) {
  const model = modelOverride || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt || undefined,
      messages: messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: Array.isArray(m.content)
          ? m.content.map((part) =>
              part.type === "image"
                ? { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } }
                : { type: "text", text: part.text }
            )
          : m.content,
      })),
    }),
  });
  if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content?.filter((b) => b.type === "text").map((b) => b.text).join("\n") || "";
  return { text, usage: { promptTokens: data.usage?.input_tokens || 0, completionTokens: data.usage?.output_tokens || 0 } };
}
