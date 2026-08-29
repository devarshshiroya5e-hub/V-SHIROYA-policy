import { createHash } from "node:crypto";

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const NVIDIA_OCR_MODEL = process.env.NVIDIA_OCR_MODEL?.trim() || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const NVIDIA_FINAL_MODEL = process.env.NVIDIA_FINAL_MODEL?.trim() || "nvidia/nemotron-3.5-lightning-30b-a3b";
const NVIDIA_OCR_MAX_TOKENS = Math.max(2048, Number(process.env.NVIDIA_OCR_MAX_TOKENS || 4096));
const NVIDIA_FINAL_MAX_TOKENS = Math.max(4096, Number(process.env.NVIDIA_FINAL_MAX_TOKENS || 7000));
const CACHE_TTL_MS = Math.max(60_000, Number(process.env.AI_CACHE_TTL_MS || 30 * 60_000));
const CACHE_MAX_ENTRIES = Math.max(1, Math.min(50, Number(process.env.AI_CACHE_MAX_ENTRIES || 20)));

type CachedResponse = { status: number; headers: [string, string][]; body: string; expiresAt: number };
const responseCache = new Map<string, CachedResponse>();
const inFlight = new Map<string, Promise<CachedResponse>>();
const nativeFetch = globalThis.fetch.bind(globalThis);

function isObject(value: unknown): value is Record<string, any> { return !!value && typeof value === "object"; }
function requestBody(init?: RequestInit): Record<string, any> | null {
  if (typeof init?.body !== "string") return null;
  try { const parsed = JSON.parse(init.body); return isObject(parsed) ? parsed : null; } catch { return null; }
}
function messages(body: Record<string, any>): any[] { return Array.isArray(body.messages) ? body.messages : []; }
function hasPart(body: Record<string, any>, type: string): boolean {
  return messages(body).some((message: any) => Array.isArray(message?.content) && message.content.some((part: any) => part?.type === type));
}
function hasImageInput(body: Record<string, any>): boolean { return hasPart(body, "image_url"); }
function hasPdfInput(body: Record<string, any>): boolean { return hasPart(body, "file"); }
function cachedSnapshot(response: Response): Promise<CachedResponse> {
  return response.text().then(body => ({ status: response.status, headers: [...response.headers.entries()], body, expiresAt: Date.now() + CACHE_TTL_MS }));
}
function responseFromSnapshot(snapshot: CachedResponse): Response { return new Response(snapshot.body, { status: snapshot.status, headers: snapshot.headers }); }
function pruneCache() {
  const now = Date.now();
  for (const [key, value] of responseCache) if (value.expiresAt <= now) responseCache.delete(key);
  while (responseCache.size > CACHE_MAX_ENTRIES) {
    const first = responseCache.keys().next().value as string | undefined;
    if (!first) break;
    responseCache.delete(first);
  }
}
function cacheKey(body: Record<string, any>): string | null {
  if (!hasPdfInput(body)) return null;
  const hash = createHash("sha256");
  hash.update(String(body.model || ""));
  hash.update("\n");
  for (const message of messages(body)) {
    hash.update(String(message?.role || ""));
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === "file") hash.update(String(part?.file?.file_data || part?.file_data || ""));
      else if (part?.type === "text") hash.update(String(part?.text || ""));
    }
    hash.update("\n");
  }
  return hash.digest("hex");
}

// Install the model-routing wrapper before the existing NVIDIA PDF bridge is imported.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith(NVIDIA_URL) || typeof init?.body !== "string") return nativeFetch(input, init);
  const body = requestBody(init);
  if (!body) return nativeFetch(input, init);
  const rewritten = { ...body };
  if (hasImageInput(rewritten)) {
    rewritten.model = NVIDIA_OCR_MODEL;
    rewritten.max_tokens = NVIDIA_OCR_MAX_TOKENS;
  } else {
    rewritten.model = NVIDIA_FINAL_MODEL;
    rewritten.max_tokens = NVIDIA_FINAL_MAX_TOKENS;
    rewritten.chat_template_kwargs = { ...(isObject(rewritten.chat_template_kwargs) ? rewritten.chat_template_kwargs : {}), enable_thinking: false };
  }
  return nativeFetch(input, { ...init, body: JSON.stringify(rewritten) });
}) as typeof globalThis.fetch;

void (async () => {
  await import("./nvidia-fetch-bridge.ts");

  const bridgeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(OPENROUTER_URL)) return bridgeFetch(input, init);
    const body = requestBody(init);
    const key = body ? cacheKey(body) : null;
    if (!key) return bridgeFetch(input, init);
    pruneCache();
    const hit = responseCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return responseFromSnapshot(hit);
    if (hit) responseCache.delete(key);
    const pending = inFlight.get(key);
    if (pending) return responseFromSnapshot(await pending);
    const work = bridgeFetch(input, init).then(async response => {
      const snapshot = await cachedSnapshot(response);
      if (response.ok) { responseCache.set(key, snapshot); pruneCache(); }
      return snapshot;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, work);
    return responseFromSnapshot(await work);
  }) as typeof globalThis.fetch;

  await import("./server.ts");
})().catch(error => {
  console.error("Failed to start V-SHIROYA optimized backend:", error);
  process.exit(1);
});
