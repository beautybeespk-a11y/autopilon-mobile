export async function geminiChat({ messages, systemPrompt, apiKey, model: modelOverride }) {
  const model = modelOverride || process.env.GEMINI_MODEL || "gemini-1.5-flash";
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: Array.isArray(m.content)
      ? m.content.map((part) =>
          part.type === "image" ? { inlineData: { mimeType: part.mimeType, data: part.data } } : { text: part.text }
        )
      : [{ text: m.content }],
  }));
  const body = {
    contents,
    generationConfig: { maxOutputTokens: 4096 },
    ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") || "";
  return { text, usage: { promptTokens: data.usageMetadata?.promptTokenCount || 0, completionTokens: data.usageMetadata?.candidatesTokenCount || 0 } };
}
