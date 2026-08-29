import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import http from "node:http";

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_OCR_MODEL = process.env.NVIDIA_OCR_MODEL || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const NVIDIA_FINAL_MODEL = process.env.NVIDIA_FINAL_MODEL || "nvidia/nemotron-3.5-lightning-30b-a3b";
const PAGE_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.NVIDIA_PAGE_CONCURRENCY || 2)));
const PAGE_SCALE = Math.max(1.5, Math.min(3.0, Number(process.env.NVIDIA_PDF_SCALE || 1.75)));
const PAGE_TEXT_LIMIT = Math.max(8000, Number(process.env.NVIDIA_PAGE_TEXT_LIMIT || 60000));
const FINAL_TEXT_LIMIT = Math.max(100000, Number(process.env.NVIDIA_FINAL_TEXT_LIMIT || 900000));
const OCR_MAX_TOKENS = Math.max(2048, Math.min(16384, Number(process.env.NVIDIA_OCR_MAX_TOKENS || 4096)));
const FINAL_MAX_TOKENS = Math.max(4096, Math.min(16384, Number(process.env.NVIDIA_MAX_TOKENS || 9000)));
const RECOVERY_MAX_TOKENS = Math.max(2048, Math.min(8192, Number(process.env.NVIDIA_RECOVERY_MAX_TOKENS || 5000)));
const REQUEST_TIMEOUT = Math.max(30000, Number(process.env.NVIDIA_TIMEOUT_MS || 120000));
const MAX_RETRIES = Math.max(0, Math.min(4, Number(process.env.NVIDIA_MAX_RETRIES || 3)));
const OCR_TEXT_THRESHOLD = Math.max(80, Number(process.env.NVIDIA_OCR_TEXT_THRESHOLD || 650));
const OCR_KEYWORDS = ["maturity", "sum assured", "sum insured", "premium", "policy schedule", "benefit", "coverage", "insured", "nominee", "date of birth", "date of maturity", "expiry", "renewal", "rider", "endorsement", "deductible", "limit", "claim", "policy number", "assured amount", "base sum assured", "total premium", "annual premium", "installment premium"];

const originalCreateServer = http.createServer;
http.createServer = function (...args: any[]) {
  const server = originalCreateServer.apply(http, args as any[]);
  server.keepAliveTimeout = 180_000;
  server.headersTimeout = 185_000;
  server.requestTimeout = 240_000;
  return server;
} as typeof http.createServer;

const nativeFetch = globalThis.fetch.bind(globalThis);
let active = 0;
const waiters: Array<() => void> = [];
async function limit<T>(fn: () => Promise<T>): Promise<T> { if (active >= PAGE_CONCURRENCY) await new Promise<void>(resolve => waiters.push(resolve)); active++; try { return await fn(); } finally { active--; waiters.shift()?.(); } }
function getNvidiaKey() { const value = process.env.NVIDIA_API_KEY?.trim(); if (!value) throw new Error("NVIDIA_API_KEY is missing on the Render backend."); return value; }
function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
function isRetryable(status: number) { return status === 408 || status === 409 || status === 429 || status >= 500; }

async function nvidia(body: any, parentSignal?: AbortSignal) {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT); const abortParent = () => controller.abort(); parentSignal?.addEventListener("abort", abortParent, { once: true });
    try {
      const response = await nativeFetch(NVIDIA_URL, { method: "POST", headers: { Authorization: `Bearer ${getNvidiaKey()}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      const raw = await response.text(); let data: any = {}; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
      if (response.ok) return data;
      const message = data?.error?.message || data?.message || data?.detail || `NVIDIA HTTP ${response.status}`;
      lastError = new Error(`NVIDIA request failed (${response.status}): ${String(message).slice(0, 1600)}`);
      if (!isRetryable(response.status) || attempt >= MAX_RETRIES) throw lastError;
      const retryAfter = Number(response.headers.get("retry-after") || 0); await sleep(retryAfter > 0 ? Math.min(30000, retryAfter * 1000) : Math.min(12000, 750 * 2 ** attempt));
    } catch (error: any) {
      if (parentSignal?.aborted) throw new DOMException("The analysis was cancelled.", "AbortError");
      if (error?.name === "AbortError") lastError = new Error(`NVIDIA request timed out after ${Math.round(REQUEST_TIMEOUT / 1000)} seconds.`); else lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= MAX_RETRIES) throw lastError; await sleep(Math.min(12000, 750 * 2 ** attempt));
    } finally { clearTimeout(timer); parentSignal?.removeEventListener("abort", abortParent); }
  }
  throw lastError || new Error("NVIDIA request failed.");
}
function dataFromFilePart(part: any) { const raw = part?.file?.file_data || part?.file_data || part?.url; if (typeof raw !== "string") return null; const marker = raw.indexOf("base64,"); return marker >= 0 ? raw.slice(marker + 7) : raw; }
function responseContent(data: any) { const content = data?.choices?.[0]?.message?.content; if (typeof content === "string") return content; if (Array.isArray(content)) return content.map((part: any) => part?.text || "").filter(Boolean).join("\n"); return ""; }
function parseJson(text: string): any | null { const cleaned = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim(); try { return JSON.parse(cleaned); } catch { const start = cleaned.indexOf("{"); const end = cleaned.lastIndexOf("}"); try { return start >= 0 && end > start ? JSON.parse(cleaned.slice(start, end + 1)) : null; } catch { return null; } } }

function buildNativeText(items: any[]) {
  const rows = new Map<number, Array<{ x: number; text: string }>>();
  for (const item of items || []) { const text = String(item?.str || "").replace(/\s+/g, " ").trim(); if (!text) continue; const x = Number(item?.transform?.[4] || 0); const y = Math.round(Number(item?.transform?.[5] || 0) / 2) * 2; const row = rows.get(y) || []; row.push({ x, text }); rows.set(y, row); }
  return [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, row]) => row.sort((a, b) => a.x - b.x).map(x => x.text).join(" ").trim()).filter(Boolean).join("\n");
}
function pageNeedsOcr(text: string) { const lower = text.toLowerCase(); const keywordHits = OCR_KEYWORDS.reduce((count, keyword) => count + (lower.includes(keyword) ? 1 : 0), 0); const suspicious = (text.match(/�|<unk>|<unknown>|\bunknow?n?\b/gi) || []).length; const digitCount = (text.match(/\d/g) || []).length; const criticalLabel = /(maturity|sum assured|sum insured|premium|assured amount|policy schedule|date of maturity|total premium|annual premium|installment premium|base sum assured)/i.test(text); return !text.trim() || text.length < OCR_TEXT_THRESHOLD || suspicious > 0 || criticalLabel || (keywordHits >= 2 && digitCount < 8); }
async function renderPage(page: any) { const viewport = page.getViewport({ scale: PAGE_SCALE }); const canvas: any = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)); await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise; return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`; }

async function pdfPages(base64: string, signal?: AbortSignal) {
  const pdf = await getDocument({ data: new Uint8Array(Buffer.from(base64, "base64")), disableWorker: true, useSystemFonts: true, isEvalSupported: false }).promise;
  const pages: Array<{ page: number; text: string; needsOcr: boolean; image?: string }> = [];
  for (let i = 1; i <= pdf.numPages; i++) { if (signal?.aborted) throw new DOMException("The analysis was cancelled.", "AbortError"); const page: any = await pdf.getPage(i); const textContent: any = await page.getTextContent({ disableCombineTextItems: true, includeMarkedContent: true }); const text = buildNativeText(textContent.items || []).slice(0, PAGE_TEXT_LIMIT); pages.push({ page: i, text, needsOcr: pageNeedsOcr(text) }); }
  return { pdf, pages };
}
async function ocrPage(page: { page: number; image?: string }, instruction: string, signal?: AbortSignal) {
  if (!page.image) return "";
  const result = await limit(() => nvidia({ model: NVIDIA_OCR_MODEL, messages: [{ role: "user", content: [
    { type: "text", text: `OCR this insurance policy page completely. Preserve the exact visual relationship between LABELS and VALUES, including every table row and column. Pay special attention to MATURITY DATE, SUM ASSURED / SUM INSURED and PREMIUM AMOUNT. Transcribe every visible date, amount, percentage, policy number, endorsement, rider, limit, clause and footer. Do not summarize. Do not infer. Re-check every digit and date against the image. Never output guessed values, <unk>, <unknown> or replacement characters. Page ${page.page}. ${instruction || ""}` },
    { type: "image_url", image_url: { url: page.image } }
  ] }], max_tokens: OCR_MAX_TOKENS, temperature: 0, top_k: 1, chat_template_kwargs: { enable_thinking: false }, stream: false }, signal));
  return responseContent(result).trim();
}
function extractParts(body: any) { const messages = Array.isArray(body?.messages) ? body.messages : []; const system = String(messages.find((m: any) => m.role === "system")?.content || ""); const user = messages.find((m: any) => m.role === "user"); const parts = Array.isArray(user?.content) ? user.content : []; const file = parts.find((part: any) => part?.type === "file"); const text = parts.filter((part: any) => part?.type === "text").map((part: any) => String(part?.text || "")).join("\n"); return { system, text, fileBase64: dataFromFilePart(file) }; }
function cleanArtifacts(value: any): any { if (typeof value === "string") return value.replace(/<\/?(?:unk|unknown|unknowable)>/gi, "").replace(/�/g, "").replace(/\s{2,}/g, " ").trim(); if (Array.isArray(value)) return value.map(cleanArtifacts); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanArtifacts(v)])); return value; }
function amount(value: any): number | null { if (value === null || value === undefined || String(value).trim() === "") return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const normalized = String(value).replace(/[^0-9.]/g, ""); const n = Number(normalized); return normalized && Number.isFinite(n) ? n : null; }
function mergeDetails(a: any[], b: any[]) { const out = [...(Array.isArray(a) ? a : [])]; const seen = new Set(out.map(x => `${x?.label || ""}|${x?.value || ""}`)); for (const item of Array.isArray(b) ? b : []) { const key = `${item?.label || ""}|${item?.value || ""}`; if (item && typeof item === "object" && item.label && item.value && !seen.has(key)) { out.push({ label: String(item.label), value: String(item.value) }); seen.add(key); } } return out.slice(0, 150); }
function normalizeResult(result: any, documentText: string) {
  const out = cleanArtifacts(result || {});
  const aliases: Record<string, string[]> = { maturityDate: ["maturity_date", "maturity", "dateOfMaturity", "date_of_maturity", "maturityBenefitDate", "maturityDateOfPolicy"], sumAssured: ["sum_assured", "sumInsured", "sum_insured", "assuredAmount", "insuredAmount", "totalSumAssured", "baseSumAssured", "assuredSum"], premiumAmount: ["premium", "premium_amount", "totalPremium", "total_premium", "annualPremium", "annual_premium", "installmentPremium"], startDate: ["start_date", "effectiveDate", "effective_date", "policyStartDate", "riskStartDate"], endDate: ["end_date", "expiryDate", "expiry_date", "policyEndDate", "riskEndDate"] };
  for (const [canonical, keys] of Object.entries(aliases)) { if (out[canonical] !== null && out[canonical] !== undefined && String(out[canonical]).trim() !== "") continue; const found = keys.find(key => out[key] !== null && out[key] !== undefined && String(out[key]).trim() !== ""); if (found) out[canonical] = out[found]; }
  const evidence = [documentText, ...(Array.isArray(out.additionalDetails) ? out.additionalDetails.map((x: any) => `${x?.label || ""}: ${x?.value || ""}`) : [])].join("\n");
  const date = (labels: string[]) => evidence.match(new RegExp(`(?:${labels.join("|")})[^\\dA-Za-z]{0,80}(\\d{1,2}[-/.](?:[A-Za-z]{3,9}|\\d{1,2})[-/.]\\d{2,4}|\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2})`, "i"))?.[1] || null;
  const money = (labels: string[]) => { const hit = evidence.match(new RegExp(`(?:${labels.join("|")})[^\\d]{0,80}(?:₹|Rs\\.?|INR|\\$)?\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)`, "i"))?.[1]; return hit ? amount(hit) : null; };
  if (!out.maturityDate) out.maturityDate = date(["date of maturity", "maturity date", "maturity benefit date", "maturity"]);
  if (out.sumAssured === null || out.sumAssured === undefined) out.sumAssured = money(["sum assured", "sum insured", "assured amount", "insured amount", "total sum assured", "base sum assured"]);
  if (out.premiumAmount === null || out.premiumAmount === undefined) out.premiumAmount = money(["premium amount", "total premium", "annual premium", "installment premium", "premium"]);
  out.premiumAmount = amount(out.premiumAmount); out.sumAssured = amount(out.sumAssured); out.additionalDetails = Array.isArray(out.additionalDetails) ? out.additionalDetails : []; out.uncertainFields = Array.isArray(out.uncertainFields) ? out.uncertainFields : [];
  return out;
}
function missingCriticalFields(result: any) { return [["maturityDate", result?.maturityDate], ["sumAssured", result?.sumAssured], ["premiumAmount", result?.premiumAmount]].filter(([, value]) => value === null || value === undefined || String(value).trim() === "").map(([field]) => String(field)); }
async function finalAnalyze(system: string, userText: string, documentText: string, maxTokens: number, signal?: AbortSignal) {
  const prompt = [userText, "", "EXHAUSTIVE POLICY EXTRACTION RULES:", "1. Read ALL pages, including continuation pages, schedules, tables, endorsements, footers and declarations.", "2. Extract every supported schema field when evidence exists. Never omit a field just because it is inside a table.", "3. MATURITY DATE: search for maturity date, date of maturity, maturity benefit date and term-end date. Do NOT confuse it with issue date, start/effective date, expiry/renewal date, print date or DOB.", "4. SUM ASSURED: search for Sum Assured, Sum Insured, Assured Amount, Total Sum Assured and Base Sum Assured. Do NOT substitute premium, IDV, deductible or a coverage limit unless the document explicitly labels it as sum assured.", "5. PREMIUM: search for Premium Amount, Total Premium, Annual Premium, Installment Premium, Modal Premium and Payable Premium. Do NOT substitute sum assured.", "6. Use the OCR text and native text together. When their layout/value differs, trust the visually transcribed OCR value for the labeled field.", "7. Preserve exact names, policy numbers, dates, amounts, percentages, limits, registration numbers, phone numbers and addresses.", "8. additionalDetails must capture important facts not represented by named top-level fields.", "9. Never guess. Missing means null; uncertain means evidence exists but is unreadable or conflicting.", "10. Return ONLY valid JSON matching the supplied schema.", "", "DOCUMENT EVIDENCE BY PAGE:", documentText].join("\n");
  const response = await nvidia({ model: NVIDIA_FINAL_MODEL, messages: [{ role: "system", content: `${system}\n\nYou are a forensic insurance policy extraction engine. Accuracy and completeness are more important than brevity. Read the entire evidence before producing JSON.` }, { role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0, top_k: 1, chat_template_kwargs: { enable_thinking: false }, stream: false }, signal);
  return parseJson(responseContent(response));
}
async function recoveryAnalyze(system: string, documentText: string, missing: string[], signal?: AbortSignal) {
  const response = await nvidia({ model: NVIDIA_FINAL_MODEL, messages: [{ role: "system", content: `${system}\n\nPerform a targeted recovery extraction. Use only visible evidence. Return JSON with the requested fields plus any additionalDetails discovered.` }, { role: "user", content: `RECOVERY TARGETS: ${missing.join(", ")}\n\nRe-read EVERY PAGE below. Locate the exact printed value for each target. For maturity date distinguish it from issue/effective/expiry/DOB. For sum assured distinguish it from premium/IDV/limit. For premium distinguish it from sum assured. Search policy schedule, benefit tables, maturity/term sections, declarations, endorsements and continuation pages. Never guess.\n\nDOCUMENT EVIDENCE:\n${documentText}` }], max_tokens: RECOVERY_MAX_TOKENS, temperature: 0, top_k: 1, chat_template_kwargs: { enable_thinking: false }, stream: false }, signal);
  return parseJson(responseContent(response));
}

async function handle(body: any, signal?: AbortSignal) {
  const { system, text, fileBase64 } = extractParts(body);
  if (!fileBase64) throw new Error("NVIDIA PDF bridge could not find uploaded PDF data.");
  const { pdf, pages } = await pdfPages(fileBase64, signal);
  try {
    const ocrCandidates = pages.filter(page => page.needsOcr);
    const prepared = await Promise.all(ocrCandidates.map(async page => { try { page.image = await renderPage(await pdf.getPage(page.page)); return page; } catch (error: any) { throw new Error(`Failed to render PDF page ${page.page}: ${error?.message || error}`); } }));
    const ocrResults = await Promise.allSettled(prepared.map(page => ocrPage(page, text, signal)));
    const ocrByPage = new Map<number, string>();
    ocrResults.forEach((result, index) => { const page = prepared[index]; if (result.status === "fulfilled" && result.value.trim()) ocrByPage.set(page.page, result.value.trim()); else if (result.status === "rejected") console.warn(`NVIDIA OCR failed on page ${page.page}:`, result.reason?.message || result.reason); });
    const pageEvidence = pages.map(page => { const native = page.text.trim(); const ocr = ocrByPage.get(page.page) || ""; if (!native && !ocr) return `[PAGE ${page.page}] [NO TEXT EXTRACTED]`; if (ocr && native) return `[PAGE ${page.page}]\n[NATIVE TEXT]\n${native}\n[OCR TEXT]\n${ocr}`; return `[PAGE ${page.page}]\n${ocr ? `[OCR TEXT]\n${ocr}` : native}`; });
    let documentText = pageEvidence.join("\n\n"); if (documentText.length > FINAL_TEXT_LIMIT) { const head = Math.floor(FINAL_TEXT_LIMIT * 0.55); const tail = FINAL_TEXT_LIMIT - head; documentText = `${documentText.slice(0, head)}\n\n[...MIDDLE EVIDENCE TRIMMED DUE TO INPUT LIMIT...]\n\n${documentText.slice(-tail)}`; }
    let extraction = normalizeResult(await finalAnalyze(system, text, documentText, FINAL_MAX_TOKENS, signal), documentText);
    const missing = missingCriticalFields(extraction);
    if (missing.length) { try { const repaired = normalizeResult(await recoveryAnalyze(system, documentText, missing, signal), documentText); for (const field of missing) { const value = repaired?.[field]; if (value !== null && value !== undefined && String(value).trim() !== "") extraction[field] = value; } extraction.additionalDetails = mergeDetails(extraction.additionalDetails, repaired?.additionalDetails); } catch (error: any) { console.warn("Targeted policy recovery failed:", error?.message || error); } }
    extraction = normalizeResult(extraction, documentText); extraction.extractedText = String(extraction.extractedText || documentText).slice(0, 12000); extraction.scanDiagnostics = { pages: pages.length, ocrPages: ocrCandidates.length, ocrSucceeded: ocrByPage.size, missingCriticalAfterRecovery: missingCriticalFields(extraction) };
    return { content: JSON.stringify(extraction), model: NVIDIA_FINAL_MODEL, usage: null, nvidia: extraction.scanDiagnostics };
  } finally { try { pdf.destroy(); } catch { /* ignore cleanup errors */ } }
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith("https://openrouter.ai/api/v1/chat/completions")) return originalFetch(input, init);
  let body: any = {}; try { body = typeof init?.body === "string" ? JSON.parse(init.body) : {}; } catch { return originalFetch(input, init); }
  const hasPdfFile = body?.messages?.some((message: any) => Array.isArray(message?.content) && message.content.some((part: any) => part?.type === "file"));
  if (!hasPdfFile) return originalFetch(input, init);
  try {
    const result = await handle(body, init?.signal || undefined);
    return new Response(JSON.stringify({ id: `nvidia-pdf-${Date.now()}`, object: "chat.completion", model: result.model, choices: [{ index: 0, message: { role: "assistant", content: result.content }, finish_reason: "stop" }], usage: result.usage, nvidia: result.nvidia }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch (error: any) {
    const aborted = error?.name === "AbortError";
    console.error("NVIDIA PDF analysis failed:", error);
    return new Response(JSON.stringify({ error: { message: aborted ? "NVIDIA policy analysis was cancelled." : error?.message || "NVIDIA PDF policy scan failed.", type: aborted ? "aborted" : "nvidia_pdf_error" } }), { status: aborted ? 499 : 502, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
}) as typeof globalThis.fetch;
