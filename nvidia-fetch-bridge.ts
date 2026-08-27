import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import * as http from "node:http";

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const PAGE_CONCURRENCY = Math.max(1, Math.min(3, Number(process.env.NVIDIA_PAGE_CONCURRENCY || 2)));
const PAGE_SCALE = Math.max(1, Math.min(2, Number(process.env.NVIDIA_PDF_SCALE || 1.35)));
const PAGE_TEXT_LIMIT = Math.max(2000, Number(process.env.NVIDIA_PAGE_TEXT_LIMIT || 18000));
const FINAL_TEXT_LIMIT = Math.max(20000, Number(process.env.NVIDIA_FINAL_TEXT_LIMIT || 180000));
const OCR_MAX_TOKENS = Math.max(1024, Math.min(8192, Number(process.env.NVIDIA_OCR_MAX_TOKENS || 4096)));
const FINAL_MAX_TOKENS = Math.max(2048, Math.min(16384, Number(process.env.NVIDIA_MAX_TOKENS || 6000)));
const REQUEST_TIMEOUT = Math.max(30000, Number(process.env.NVIDIA_TIMEOUT_MS || 90000));
const MAX_RETRIES = Math.max(0, Math.min(5, Number(process.env.NVIDIA_MAX_RETRIES || 3)));

// Render can reuse HTTP/1.1 connections. Keep Node's connection alive longer
// than Render's edge to prevent intermittent 502/ECONNRESET responses.
const originalCreateServer = http.createServer;
http.createServer = function (...args: any[]) {
  const server = originalCreateServer.apply(http, args as any);
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.requestTimeout = 120_000;
  return server;
} as typeof http.createServer;

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

function isRetryable(status: number) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

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
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      let data: any = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
      if (response.ok) return data;
      const message = data?.error?.message || data?.message || data?.detail || `NVIDIA HTTP ${response.status}`;
      lastError = new Error(`NVIDIA request failed (${response.status}): ${String(message).slice(0, 1200)}`);
      if (!isRetryable(response.status) || attempt >= MAX_RETRIES) throw lastError;
      const retryAfter = Number(response.headers.get("retry-after") || 0);
      const delay = retryAfter > 0 ? Math.min(30000, retryAfter * 1000) : Math.min(15000, 800 * 2 ** attempt) + Math.floor(Math.random() * 300);
      await sleep(delay);
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

async function pdfPages(base64: string) {
  const pdf = await getDocument({ data: new Uint8Array(Buffer.from(base64, "base64")), disableWorker: true, useSystemFonts: true }).promise;
  const pages: Array<{ page: number; text: string; image?: string }> = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page: any = await pdf.getPage(i);
    const textContent: any = await page.getTextContent();
    const text = (textContent.items || []).map((item: any) => item?.str || "").join(" ").replace(/\s+/g, " ").trim();
    if (text.length >= 60) {
      pages.push({ page: i, text: text.slice(0, PAGE_TEXT_LIMIT) });
      continue;
    }
    const viewport = page.getViewport({ scale: PAGE_SCALE });
    const canvas: any = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    pages.push({ page: i, text, image: `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}` });
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
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("NVIDIA returned invalid JSON for the policy analysis.");
  }
}

async function imageToText(page: { page: number; image?: string }, instruction: string, signal?: AbortSignal) {
  if (!page.image) return "";
  const response = await limit(() => nvidia({
    model: NVIDIA_MODEL,
    messages: [{ role: "user", content: [
      { type: "text", text: `Transcribe this insurance policy page exactly. Return ONLY the visible document text, preserving policy numbers, dates, amounts, percentages, tables, headings and clauses. Do not summarize and do not invent unreadable text. Page ${page.page}. ${instruction || ""}` },
      { type: "image_url", image_url: { url: page.image } },
    ] }],
    max_tokens: OCR_MAX_TOKENS,
    temperature: 0.2,
    top_k: 1,
    chat_template_kwargs: { enable_thinking: false },
    stream: false,
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
  const imagePages = pages.filter((page) => page.image);
  const ocrResults = await Promise.allSettled(imagePages.map((page) => imageToText(page, text, signal)));
  const imageTextByPage = new Map<number, string>();
  ocrResults.forEach((result, index) => {
    const page = imagePages[index];
    if (result.status === "fulfilled" && result.value.trim()) imageTextByPage.set(page.page, result.value.trim());
    else if (result.status === "rejected") console.warn(`NVIDIA OCR failed for PDF page ${page.page}:`, result.reason?.message || result.reason);
  });

  const documentText = pages.map((page) => `[PAGE ${page.page}]\n${imageTextByPage.get(page.page) || page.text || ""}`).join("\n\n").slice(0, FINAL_TEXT_LIMIT);
  const finalPrompt = [
    text,
    "",
    "Analyze the complete insurance policy text below.",
    "Return ONLY the JSON object required by the system schema.",
    "Never invent missing values. Use null for missing fields and list them in missingFields.",
    "List conflicting or uncertain values in uncertainFields.",
    "Preserve exact policy numbers, names, dates, currency values, limits and percentages.",
    "",
    documentText,
  ].join("\n");

  const finalResponse = await nvidia({
    model: NVIDIA_MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: finalPrompt }],
    max_tokens: FINAL_MAX_TOKENS,
    temperature: 0.2,
    top_k: 1,
    chat_template_kwargs: { enable_thinking: false },
    stream: false,
  }, signal);

  const content = responseContent(finalResponse);
  if (!content) throw new Error("NVIDIA returned an empty policy analysis.");
  extractJson(content);
  return { content, model: NVIDIA_MODEL, usage: finalResponse?.usage || null, pages: pages.length, ocrPages: imagePages.length, ocrSucceeded: imageTextByPage.size };
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
    return new Response(JSON.stringify({
      id: `nvidia-${Date.now()}`,
      object: "chat.completion",
      model: result.model,
      choices: [{ index: 0, message: { role: "assistant", content: result.content }, finish_reason: "stop" }],
      usage: result.usage,
      nvidia: { pages: result.pages, ocrPages: result.ocrPages, ocrSucceeded: result.ocrSucceeded },
    }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch (error: any) {
    const message = error?.name === "AbortError" ? "NVIDIA policy analysis was cancelled." : error?.message || "NVIDIA policy scan failed.";
    console.error("NVIDIA PDF analysis failed:", error);
    return new Response(JSON.stringify({ error: { message, type: error?.name === "AbortError" ? "aborted" : "nvidia_error" } }), {
      status: error?.name === "AbortError" ? 499 : 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
}) as typeof globalThis.fetch;

void import("./server.ts").catch((error) => {
  console.error("Failed to start V-SHIROYA backend:", error);
  process.exit(1);
});
