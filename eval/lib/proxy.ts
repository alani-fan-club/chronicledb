/**
 * api.navy proxy client — OpenAI-compatible.
 * All LLM calls route through here, never direct to providers.
 */

const BASE_URL = process.env.NAVY_BASE_URL || "https://api.navy/v1";
const API_KEY = process.env.NAVY_API_KEY;

if (!API_KEY) {
  throw new Error("NAVY_API_KEY not set — create eval/.env with NAVY_API_KEY=sk-navy-...");
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" };
}

/**
 * Call chat completions via proxy. Retries on 429/5xx with exponential backoff.
 */
export async function chat(
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  const body = {
    model,
    messages,
    temperature: opts.temperature ?? 0.1,
    max_tokens: opts.max_tokens ?? 2048,
    ...(opts.response_format ? { response_format: opts.response_format } : {}),
  };

  let delay = 1000;
  const maxRetries = 4;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429 || res.status >= 500) {
        if (attempt === maxRetries) {
          throw new Error(`${model}: ${res.status} after ${maxRetries} retries`);
        }
        await sleep(delay);
        delay *= 2;
        continue;
      }

      if (!res.ok) {
        throw new Error(`${model}: ${res.status} ${await res.text()}`);
      }

      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? "";
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(delay);
      delay *= 2;
    }
  }

  throw new Error("unreachable");
}

/**
 * List available models from the proxy.
 */
export async function listModels(): Promise<string[]> {
  const res = await fetch(`${BASE_URL}/models`);
  if (!res.ok) throw new Error(`list models: ${res.status}`);
  const data = await res.json();
  return (data.data ?? []).map((m: { id: string }) => m.id);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
