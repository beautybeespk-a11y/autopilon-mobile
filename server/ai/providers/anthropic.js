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
      messages: messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    }),
  });
  if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content?.filter((b) => b.type === "text").map((b) => b.text).join("\n") || "";
}
