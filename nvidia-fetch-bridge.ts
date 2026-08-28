import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import http from "node:http";

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const PAGE_CONCURRENCY = Math.max(1, Math.min(3, Number(process.env.NVIDIA_PAGE_CONCURRENCY || 2)));
const PAGE_SCALE = Math.max(1.5, Math.min(4.17, Number(process.env.NVIDIA_PDF_SCALE || 2.0833)));
const PAGE_TEXT_LIMIT = Math.max(4000, Number(process.env.NVIDIA_PAGE_TEXT_LIMIT || 30000));
const FINAL_TEXT_LIMIT = Math.max(50000, Number(process.env.NVIDIA_FINAL_TEXT_LIMIT || 700000));
const OCR_MAX_TOKENS = Math.max(2048, Math.min(16384, Number(process.env.NVIDIA_OCR_MAX_TOKENS || 8192)));
const FINAL_MAX_TOKENS = Math.max(4096, Math.min(16384, Number(process.env.NVIDIA_MAX_TOKENS || 10000)));
const REQUEST_TIMEOUT = Math.max(30000, Number(process.env.NVIDIA_TIMEOUT_MS || 120000));
const MAX_RETRIES = Math.max(0, Math.min(5, Number(process.env.NVIDIA_MAX_RETRIES || 3)));
const OCR_TEXT_THRESHOLD = Math.max(100, Number(process.env.NVIDIA_OCR_TEXT_THRESHOLD || 500));

const originalCreateServer = http.createServer;
http.createServer = function (...args: any[]) {
  const server = originalCreateServer.apply(http, args as any[]);
  server.keepAliveTimeout = 180_000;
  server.headersTimeout = 185_000;
  server.requestTimeout = 180_000;
  return server;
} as typeof http.createServer;

if (process.env.NVIDIA_API_KEY && !process.env.OPENROUTER_API_KEY) process.env.OPENROUTER_API_KEY = "nvidia-pdf-bridge-placeholder";

const nativeFetch = globalThis.fetch.bind(globalThis);
let active = 0;
const waiters: Array<() => void> = [];
async function limit<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= PAGE_CONCURRENCY) await new Promise<void>((resolve) => waiters.push(resolve));
  active += 1;
  try { return await fn(); } finally { active -= 1; waiters.shift()?.(); }
}
function getNvidiaKey() {
  const value = process.env.NVIDIA_API_KEY?.trim();
  if (!value) throw new Error("NVIDIA_API_KEY is missing on the Render backend.");
  return value;
}
function isRetryable(status: number) { return status === 408 || status === 429 || status >= 500; }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function nvidia(body: any, parentSignal?: AbortSignal) {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    const abortParent = () => controller.abort();
    parentSignal?.addEventListener("abort", abortParent, { once: true });
    try {
      const response = await nativeFetch(NVIDIA_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${getNvidiaKey()}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body), signal: controller.signal,
      });
      const raw = await response.text();
      let data: any = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
      if (response.ok) return data;
      const message = data?.error?.message || data?.message || data?.detail || `NVIDIA HTTP ${response.status}`;
      lastError = new Error(`NVIDIA request failed (${response.status}): ${String(message).slice(0, 1600)}`);
      if (!isRetryable(response.status) || attempt >= MAX_RETRIES) throw lastError;
      const retryAfter = Number(response.headers.get("retry-after") || 0);
      await sleep(retryAfter > 0 ? Math.min(30000, retryAfter * 1000) : Math.min(15000, 800 * 2 ** attempt) + Math.floor(Math.random() * 300));
    } catch (error: any) {
      if (parentSignal?.aborted) throw new DOMException("The analysis was cancelled.", "AbortError");
      if (error?.name === "AbortError") lastError = new Error(`NVIDIA request timed out after ${Math.round(REQUEST_TIMEOUT / 1000)} seconds.`);
      else lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= MAX_RETRIES) throw lastError;
      await sleep(Math.min(15000, 800 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortParent);
    }
  }
  throw lastError || new Error("NVIDIA request failed.");
}

function dataFromFilePart(part: any) {
  const raw = part?.file?.file_data || part?.file_data || part?.url;
  if (typeof raw !== "string") return null;
  const marker = raw.indexOf("base64,");
  return marker >= 0 ? raw.slice(marker + 7) : raw;
}

function buildNativeText(items: any[]) {
  const rows = new Map<number, Array<{ x: number; text: string }>>();
  for (const item of items || []) {
    const text = String(item?.str || "").trim();
    if (!text) continue;
    const x = Number(item?.transform?.[4] || 0);
    const y = Math.round(Number(item?.transform?.[5] || 0) / 3) * 3;
    const row = rows.get(y) || [];
    row.push({ x, text });
    rows.set(y, row);
  }
  return [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, row]) => row.sort((a, b) => a.x - b.x).map(x => x.text).join(" ").trim()).filter(Boolean).join("\n");
}

async function renderPage(page: any) {
  const viewport = page.getViewport({ scale: PAGE_SCALE });
  const canvas: any = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
}

async function pdfPages(base64: string) {
  const pdf = await getDocument({ data: new Uint8Array(Buffer.from(base64, "base64")), disableWorker: true, useSystemFonts: true }).promise;
  const pages: Array<{ page: number; text: string; image?: string; needsOcr: boolean }> = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page: any = await pdf.getPage(i);
    const textContent: any = await page.getTextContent({ disableCombineTextItems: true });
    const text = buildNativeText(textContent.items || []).slice(0, PAGE_TEXT_LIMIT);
    const needsOcr = text.length < OCR_TEXT_THRESHOLD;
    // Render only sparse pages. This preserves native text for text-heavy pages while
    // recovering values in scanned pages, tables, stamps, signatures and form widgets.
    const image = needsOcr ? await renderPage(page) : undefined;
    pages.push({ page: i, text, image, needsOcr });
  }
  return pages;
}

function responseContent(data: any) {
  const message = data?.choices?.[0]?.message;
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.map((part: any) => part?.text || "").filter(Boolean).join("\n");
  return "";
}
function extractJson(text: string) {
  const cleaned = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf("{"); const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("NVIDIA returned invalid JSON for the policy analysis.");
  }
}

async function imageToText(page: { page: number; image?: string }, instruction: string, signal?: AbortSignal) {
  if (!page.image) return "";
  const response = await limit(() => nvidia({
    model: NVIDIA_MODEL,
    messages: [{ role: "user", content: [
      { type: "text", text: `Transcribe this insurance policy page completely. Return ONLY visible document content, preserving every field label, filled value, policy number, date, amount, percentage, table row, heading, clause, checkbox/radio state and endorsement. Do not summarize. If text is unreadable, omit only that text rather than inventing it. Page ${page.page}. ${instruction || ""}` },
      { type: "image_url", image_url: { url: page.image } },
    ] }],
    max_tokens: OCR_MAX_TOKENS, temperature: 0.2, top_k: 1,
    chat_template_kwargs: { enable_thinking: false }, stream: false,
  }, signal));
  return responseContent(response);
}
function extractParts(body: any) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = String(messages.find((message: any) => message.role === "system")?.content || "");
  const user = messages.find((message: any) => message.role === "user");
  const parts = Array.isArray(user?.content) ? user.content : [];
  const file = parts.find((part: any) => part?.type === "file");
  const text = parts.filter((part: any) => part?.type === "text").map((part: any) => String(part?.text || "")).join("\n");
  return { system, text, fileBase64: dataFromFilePart(file) };
}

async function handle(body: any, signal?: AbortSignal) {
  const { system, text, fileBase64 } = extractParts(body);
  if (!fileBase64) throw new Error("NVIDIA bridge could not find the uploaded PDF data.");
  const pages = await pdfPages(fileBase64);
  const ocrPages = pages.filter((page) => page.needsOcr);
  const ocrResults = await Promise.allSettled(ocrPages.map(async (page) => ({ page: page.page, text: await imageToText(page, text, signal) })));
  const imageTextByPage = new Map<number, string>();
  ocrResults.forEach((result) => {
    if (result.status === "fulfilled" && result.value.text.trim()) imageTextByPage.set(result.value.page, result.value.text.trim());
    else if (result.status === "rejected") console.warn("NVIDIA OCR failed for a PDF page:", result.reason?.message || result.reason);
  });
  const documentText = pages.map((page) => {
    const ocr = imageTextByPage.get(page.page);
    const native = page.text;
    return `[PAGE ${page.page}]\n${ocr ? `${native}\n[OCR]\n${ocr}` : native || "[No native text extracted]"}`;
  }).join("\n\n").slice(0, FINAL_TEXT_LIMIT);
  const finalPrompt = [
    text,
    "",
    "Analyze EVERY page below, not only the first pages.",
    "Extract every explicit policy fact supported by the document.",
    "Populate all schema fields when evidence exists. Never invent values; use null when absent.",
    "additionalDetails MUST contain every important field that does not fit the named top-level fields, including coverage, insured objects, riders, endorsements, deductibles, limits, benefits, exclusions, payment details, claim details and important clauses. Each item MUST be {label,value}.",
    "missingFields must list named schema fields that have no evidence. uncertainFields must list fields with conflicting or ambiguous evidence.",
    "Preserve exact policy numbers, names, dates, currency values, limits, percentages and clause wording where useful.",
    "Return ONLY the JSON object required by the system schema.",
    "",
    documentText,
  ].join("\n");
  const finalResponse = await nvidia({
    model: NVIDIA_MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: finalPrompt }],
    max_tokens: FINAL_MAX_TOKENS, temperature: 0.2, top_k: 1,
    chat_template_kwargs: { enable_thinking: false }, stream: false,
  }, signal);
  const content = responseContent(finalResponse);
  if (!content) throw new Error("NVIDIA returned an empty policy analysis.");
  extractJson(content);
  return { content, model: NVIDIA_MODEL, usage: finalResponse?.usage || null, pages: pages.length, ocrPages: ocrPages.length, ocrSucceeded: imageTextByPage.size };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith("https://openrouter.ai/api/v1/chat/completions")) return originalFetch(input, init);
  let body: any = {};
  try { body = typeof init?.body === "string" ? JSON.parse(init.body) : {}; } catch { return originalFetch(input, init); }
  const hasPdfFile = body?.messages?.some((message: any) => Array.isArray(message?.content) && message.content.some((part: any) => part?.type === "file"));
  if (!hasPdfFile) return originalFetch(input, init);
  try {
    const result = await handle(body, init?.signal || undefined);
    return new Response(JSON.stringify({ id: `nvidia-${Date.now()}`, object: "chat.completion", model: result.model, choices: [{ index: 0, message: { role: "assistant", content: result.content }, finish_reason: "stop" }], usage: result.usage, nvidia: { pages: result.pages, ocrPages: result.ocrPages, ocrSucceeded: result.ocrSucceeded } }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch (error: any) {
    const message = error?.name === "AbortError" ? "NVIDIA policy analysis was cancelled." : error?.message || "NVIDIA policy scan failed.";
    console.error("NVIDIA PDF analysis failed:", error);
    return new Response(JSON.stringify({ error: { message, type: error?.name === "AbortError" ? "aborted" : "nvidia_error" } }), { status: error?.name === "AbortError" ? 499 : 502, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
}) as typeof globalThis.fetch;

void import("./server.ts").catch((error) => { console.error("Failed to start V-SHIROYA backend:", error); process.exit(1); });
