import express from "express";
import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : (fs.existsSync(path.join(process.cwd(), "index.html")) ? process.cwd() : path.resolve(__dirname, ".."));
const DIST = path.join(ROOT, "dist");
const DIST_INDEX = path.join(DIST, "index.html");
const DATA_FILE = path.join(ROOT, "policies_db.json");
const AUDIT_FILE = path.join(ROOT, "security_audit.json");
const MAX_BODY = process.env.MAX_BODY_SIZE || "110mb";
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 100 * 1024 * 1024);
const AI_ENSEMBLE_SIZE = Math.max(1, Math.min(3, Number(process.env.AI_ENSEMBLE_SIZE || 3)));

app.disable("x-powered-by");

const normalizeOrigin = (value?: string) => String(value || "").trim().replace(/\/$/, "");
const CORS_ALLOW_ALL = process.env.CORS_ALLOW_ALL !== "false";
const allowedOrigins = new Set([process.env.APP_URL, process.env.FRONTEND_URL, process.env.FIREBASE_APP_URL, "https://v-shiroya-insurance.web.app", "https://v-shiroya-insurance.firebaseapp.com", "https://v-shiroya-policy.web.app", "https://v-shiroya-policy.firebaseapp.com", "https://v-shiroya-policy.onrender.com", "http://localhost:3000", "http://localhost:5173"].map(normalizeOrigin).filter(Boolean));

app.use((req, res, next) => {
  const origin = normalizeOrigin(req.headers.origin);
  const allowed = CORS_ALLOW_ALL || !origin || allowedOrigins.has(origin);
  if (CORS_ALLOW_ALL) res.setHeader("Access-Control-Allow-Origin", "*");
  else if (origin && allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.append("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return allowed ? res.status(204).end() : res.status(403).json({ error: "CORS origin not allowed" });
  next();
});

app.use(express.json({ limit: MAX_BODY }));
app.use(express.urlencoded({ limit: MAX_BODY, extended: true }));

function readJson<T>(file: string, fallback: T): T {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as T : fallback; }
  catch (error) { console.error(`Failed to read ${file}:`, error); return fallback; }
}
function writeJson(file: string, value: unknown) {
  try { fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8"); }
  catch (error) { console.error(`Failed to write ${file}:`, error); }
}
function addAuditLog(action: string, details: string, req: express.Request) {
  const logs = readJson<any[]>(AUDIT_FILE, []);
  logs.unshift({ id: `sec-${Date.now()}`, timestamp: new Date().toISOString(), action, actor: "V SHIROYA AI", details, ipAddress: req.ip || "unknown" });
  writeJson(AUDIT_FILE, logs.slice(0, 100));
}
function cleanJson(text: string): any {
  const cleaned = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(cleaned); }
  catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("AI returned invalid JSON");
  }
}

function getOpenRouterKeys() {
  const names = ["OPENROUTER_API_KEY", "OPENROUTER_API_KEY_1", "OPENROUTER_API_KEY_2", "OPENROUTER_API_KEY_3", "OPENROUTER_API_KEY_4", "OPENROUTER_API_KEY_5"];
  return names.map((name) => ({ name, value: process.env[name]?.trim() || "" })).filter((item) => item.value && !item.value.startsWith("MY_"));
}

function modelsToTry() {
  const allowPaid = process.env.OPENROUTER_ALLOW_PAID === "true";
  const configured = (process.env.OPENROUTER_MODELS || process.env.OPENROUTER_MODEL || "openrouter/free,openrouter/free,openrouter/free").split(",").map((value) => value.trim()).filter(Boolean);
  const models = allowPaid ? configured : configured.filter((model) => model === "openrouter/free" || model.endsWith(":free"));
  return models.length ? models : ["openrouter/free"];
}

const SCHEMA = `{"documentType":string,"detectedInsurer":string|null,"ownerName":string|null,"policyNumber":string|null,"providerCompany":string|null,"policyType":string|null,"startDate":string|null,"endDate":string|null,"premiumAmount":number|null,"premiumFrequency":string|null,"sumAssured":number|null,"insuredPerson":string|null,"nominee":string|null,"nomineeRelationship":string|null,"phoneNumber":string|null,"email":string|null,"address":string|null,"dateOfBirth":string|null,"agentName":string|null,"agentPhone":string|null,"branchName":string|null,"paymentMode":string|null,"policyStatus":"ACTIVE"|"EXPIRING SOON"|"EXPIRED","maturityDate":string|null,"additionalDetails":[{"label":string,"value":string,"confidence":"high"|"medium"|"low"}],"missingFields":string[],"uncertainFields":string[],"confidence":number,"extractedText":string,"fieldConfidenceMap":object}`;
const SYSTEM_PROMPT = `You are V Shiroya Policy AI, a specialist insurance-policy OCR, classification and audit engine. First identify the exact insurance category from the document itself. NEVER default to "General" unless the document truly cannot be classified. Use one of these preferred categories when evidence exists: Motor / Vehicle Insurance, Car Insurance, Two-Wheeler Insurance, Commercial Vehicle Insurance, Life Insurance, Term Life Insurance, Health Insurance, Family Floater Health Insurance, Travel Insurance, Home / Property Insurance, Fire Insurance, Marine Insurance, Personal Accident Insurance, Crop Insurance, Liability Insurance, Commercial Insurance, or General Insurance only as a last resort. Look for category evidence in titles, insurer product names, IDV, registration number, RC number, vehicle make/model, engine/chassis number, third-party liability, no-claim bonus, sum assured, life assured, nominee, maturity, hospitalization, cashless, mediclaim, hospital, pre-existing disease, travel destination, baggage, trip dates, property address, fire, marine cargo, and other policy-specific sections. Analyze every page, table, header, footer, schedule, endorsement, rider, stamp and fine-print section. Never invent values. Use null when unreadable and record that field in missingFields or uncertainFields. Preserve exact policy numbers and names. Normalize dates to YYYY-MM-DD only when unambiguous. Return ONLY valid JSON matching this schema:\n${SCHEMA}`;

function buildContent(fileData: string, fileName: string, mimeType: string, instruction: string) {
  const dataUrl = fileData.startsWith("data:") ? fileData : `data:${mimeType};base64,${fileData.replace(/^data:[^,]+,/, "")}`;
  const parts: any[] = [{ type: "text", text: `${instruction || "Extract, classify and audit this insurance policy comprehensively."}\nFilename: ${fileName}\nIMPORTANT: identify the exact policy type and do not call it General when a specific type can be inferred from document evidence. Return the complete JSON object now.` }];
  if (mimeType.toLowerCase() === "application/pdf") parts.push({ type: "file", file: { filename: fileName || "policy.pdf", file_data: dataUrl } });
  else parts.push({ type: "image_url", image_url: { url: dataUrl } });
  return parts;
}

function buildOpenRouterPayload(model: string, fileData: string, fileName: string, mimeType: string, instruction: string) {
  const isPdf = mimeType.toLowerCase() === "application/pdf";
  return {
    model,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: buildContent(fileData, fileName, mimeType, instruction) }],
    ...(isPdf ? { plugins: [{ id: "file-parser", pdf: { engine: process.env.OPENROUTER_PDF_ENGINE || "cloudflare-ai" } }] } : {}),
    response_format: { type: "json_object" },
    temperature: 0,
  };
}

async function callSingleOpenRouter(model: string, key: { name: string; value: string }, fileData: string, fileName: string, mimeType: string, instruction: string) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.value}`, "Content-Type": "application/json", "HTTP-Referer": process.env.APP_URL || "https://v-shiroya-policy.onrender.com", "X-OpenRouter-Title": "V Shiroya Policy AI" },
    body: JSON.stringify(buildOpenRouterPayload(model, fileData, fileName, mimeType, instruction)),
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `OpenRouter HTTP ${response.status}`);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned no assistant content");
  return { result: cleanJson(content), model: data?.model || model, usage: data.usage || null };
}

function policyTypeFromEvidence(result: any) {
  const raw = [result?.policyType, result?.documentType, result?.extractedText, result?.providerCompany, result?.detectedInsurer, ...(Array.isArray(result?.additionalDetails) ? result.additionalDetails.flatMap((x: any) => [x?.label, x?.value]) : [])].filter(Boolean).join(" ").toLowerCase();
  const has = (...terms: string[]) => terms.some((term) => raw.includes(term));
  if (has("two wheeler", "two-wheeler", "motorcycle", "scooter", "bike")) return "Two-Wheeler Insurance";
  if (has("commercial vehicle", "goods carrying", "passenger carrying")) return "Commercial Vehicle Insurance";
  if (has("motor", "vehicle", "registration number", "registration no", "chassis", "engine number", "engine no", "idv", "no claim bonus", "ncb", "third party", "car insurance", "automobile")) return "Motor / Vehicle Insurance";
  if (has("family floater", "family health")) return "Family Floater Health Insurance";
  if (has("health", "mediclaim", "hospitalization", "cashless", "pre-existing disease", "sum insured for medical")) return "Health Insurance";
  if (has("term life", "pure protection", "death benefit")) return "Term Life Insurance";
  if (has("life assured", "life insurance", "maturity benefit", "survival benefit", "nominee", "annuity")) return "Life Insurance";
  if (has("travel", "trip", "baggage", "passport", "overseas medical")) return "Travel Insurance";
  if (has("home insurance", "property insurance", "building and contents", "household")) return "Home / Property Insurance";
  if (has("fire insurance", "fire policy")) return "Fire Insurance";
  if (has("marine", "cargo", "bill of lading")) return "Marine Insurance";
  if (has("personal accident", "accidental death", "permanent disability")) return "Personal Accident Insurance";
  if (has("crop", "agriculture", "farmer")) return "Crop Insurance";
  if (has("liability", "professional indemnity", "public liability")) return "Liability Insurance";
  if (has("general insurance")) return "General Insurance";
  return result?.policyType || "General Insurance";
}

function completenessScore(result: any) {
  const important = ["detectedInsurer", "ownerName", "policyNumber", "providerCompany", "policyType", "premiumAmount", "premiumFrequency", "sumAssured", "startDate", "endDate", "insuredPerson", "nominee", "policyStatus"];
  return important.reduce((count, field) => count + (result?.[field] !== null && result?.[field] !== undefined && String(result[field]).trim() !== "" ? 1 : 0), 0) / important.length;
}

function chooseBestAnalysis(analyses: any[]) {
  const enriched = analyses.map((analysis) => ({ ...analysis, result: { ...analysis.result, policyType: policyTypeFromEvidence(analysis.result) } }));
  const ranked = [...enriched].sort((a, b) => completenessScore(b.result) - completenessScore(a.result));
  const best = ranked[0];
  const typeCounts = new Map<string, number>();
  for (const item of enriched) {
    const type = policyTypeFromEvidence(item.result);
    typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
  }
  const consensusType = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || best.result.policyType;
  const agreement = (typeCounts.get(consensusType) || 1) / enriched.length;
  const merged = { ...best.result, policyType: consensusType };
  return { result: merged, model: best.model, usage: best.usage, modelsUsed: enriched.map((x) => x.model), modelCount: enriched.length, agreement };
}

async function callOpenRouter(fileData: string, fileName: string, mimeType: string, instruction: string) {
  const keys = getOpenRouterKeys();
  if (!keys.length) throw new Error("No OPENROUTER_API_KEY variables are configured.");
  const configured = modelsToTry();
  const jobs = Array.from({ length: AI_ENSEMBLE_SIZE }, (_, index) => ({ model: configured[index % configured.length], key: keys[index % keys.length] }));
  const settled = await Promise.allSettled(jobs.map((job) => callSingleOpenRouter(job.model, job.key, fileData, fileName, mimeType, instruction)));
  const successful = settled.filter((item): item is PromiseFulfilledResult<any> => item.status === "fulfilled").map((item) => item.value);
  if (!successful.length) {
    const firstError = settled.find((item) => item.status === "rejected") as PromiseRejectedResult | undefined;
    throw new Error(firstError?.reason?.message || "All AI model requests failed");
  }
  return chooseBestAnalysis(successful);
}

function postProcess(result: any, modelCount = 1, agreement = 1) {
  const out = { ...result };
  out.policyType = policyTypeFromEvidence(out);
  for (const field of ["premiumAmount", "sumAssured"]) {
    if (typeof out[field] === "string") {
      const numberValue = Number(out[field].replace(/[^0-9.]/g, ""));
      out[field] = Number.isFinite(numberValue) ? numberValue : null;
    }
  }
  if (!out.endDate && out.maturityDate) out.endDate = out.maturityDate;
  if (out.endDate) {
    const end = new Date(out.endDate);
    if (!Number.isNaN(end.getTime())) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const days = Math.ceil((end.getTime() - today.getTime()) / 86400000);
      out.policyStatus = days < 0 ? "EXPIRED" : days <= 30 ? "EXPIRING SOON" : "ACTIVE";
    }
  }
  out.policyStatus ||= "ACTIVE";
  out.additionalDetails = Array.isArray(out.additionalDetails) ? out.additionalDetails : [];
  out.missingFields = Array.isArray(out.missingFields) ? out.missingFields : [];
  out.uncertainFields = Array.isArray(out.uncertainFields) ? out.uncertainFields : [];
  out.fieldConfidenceMap = out.fieldConfidenceMap && typeof out.fieldConfidenceMap === "object" ? out.fieldConfidenceMap : {};
  const completeness = completenessScore(out);
  const confidence = 90 + Math.round(Math.min(8, completeness * 6 + agreement * 2 + (modelCount >= 2 ? 1 : 0)));
  out.confidence = Math.max(90, Math.min(98, confidence));
  return out;
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "V Shiroya Policy AI", aiProvider: "OpenRouter", configured: getOpenRouterKeys().length > 0, configuredKeyCount: getOpenRouterKeys().length, freeOnly: process.env.OPENROUTER_ALLOW_PAID !== "true", models: modelsToTry(), ensembleSize: AI_ENSEMBLE_SIZE, pdfEngine: process.env.OPENROUTER_PDF_ENGINE || "cloudflare-ai", corsAllowAll: CORS_ALLOW_ALL, allowedOrigins: [...allowedOrigins], productionBuild: fs.existsSync(DIST_INDEX), frontendUrl: process.env.FRONTEND_URL || process.env.FIREBASE_APP_URL || "same-origin", timestamp: new Date().toISOString() }));

async function analyzeOne(payload: any, req: express.Request) {
  const { fileData, fileName, mimeType = "application/pdf", instruction = "" } = payload || {};
  if (!fileName) throw new Error("Filename is required");
  if (!fileData) throw new Error("File data is required");
  if (!String(mimeType).startsWith("application/pdf") && !String(mimeType).startsWith("image/")) throw new Error("Unsupported file type. Use PDF, PNG, JPG or WEBP.");
  const base64 = String(fileData).replace(/^data:[^,]+,/, "");
  const estimatedBytes = Math.floor((base64.length * 3) / 4);
  if (estimatedBytes > MAX_FILE_BYTES) throw new Error(`File is larger than the ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB server limit.`);
  const analysis = await callOpenRouter(fileData, fileName, mimeType, instruction);
  const extraction = postProcess(analysis.result, analysis.modelCount, analysis.agreement);
  addAuditLog("POLICY_ANALYSIS", `Analyzed ${fileName} with ${analysis.modelsUsed.join(", ")}; type ${extraction.policyType}; confidence ${extraction.confidence}%`, req);
  return { success: true, fileName, extraction, model: analysis.model, modelsUsed: analysis.modelsUsed, modelCount: analysis.modelCount, modelAgreement: Math.round(analysis.agreement * 100), usage: analysis.usage };
}

app.post("/api/analyze-policy", async (req, res) => {
  if (!getOpenRouterKeys().length) return res.status(503).json({ error: "AI is not configured", details: "Set OPENROUTER_API_KEY through OPENROUTER_API_KEY_5 in Render environment variables, then redeploy." });
  try { return res.json(await analyzeOne(req.body, req)); }
  catch (error: any) {
    const message = error?.message || "Unknown AI error";
    console.error("AI analysis failed:", message);
    const status = /rate limit/i.test(message) ? 429 : /Unsupported file type|Filename is required|File data is required|server limit/i.test(message) ? 400 : 502;
    return res.status(status).json({ error: "AI analysis failed", details: message });
  }
});

app.post("/api/analyze-policies", async (req, res) => {
  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!files.length) return res.status(400).json({ error: "files must be a non-empty array" });
  if (!getOpenRouterKeys().length) return res.status(503).json({ error: "AI is not configured", details: "Set the OpenRouter key variables on the server." });
  const results = await Promise.all(files.map(async (file: any) => {
    try { return await analyzeOne(file, req); }
    catch (error: any) { return { success: false, fileName: file?.fileName || "unknown", error: error?.message || "Analysis failed" }; }
  }));
  return res.json({ success: results.every((x) => x.success), count: results.length, results });
});

app.get("/api/policies", (req, res) => {
  let policies = readJson<any[]>(DATA_FILE, []);
  const query = String(req.query.q || "").toLowerCase().trim();
  if (query) policies = policies.filter((policy) => [policy.ownerName, policy.policyNumber, policy.providerCompany, policy.policyType, policy.phoneNumber].some((value) => String(value || "").toLowerCase().includes(query)));
  res.json({ success: true, count: policies.length, policies });
});

app.post("/api/policies", (req, res) => {
  const policies = readJson<any[]>(DATA_FILE, []);
  const policy = { ...req.body, id: req.body?.id || `pol-${Date.now()}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  policies.unshift(policy);
  writeJson(DATA_FILE, policies);
  addAuditLog("POLICY_CREATED", `Saved policy ${policy.policyNumber || policy.id}`, req);
  res.json({ success: true, policy });
});

app.get("/api/stats", (_req, res) => {
  const policies = readJson<any[]>(DATA_FILE, []);
  res.json({ totalPolicies: policies.length, activePolicies: policies.filter((x) => x.policyStatus === "ACTIVE").length, expiredPolicies: policies.filter((x) => x.policyStatus === "EXPIRED").length, expiringSoonPolicies: policies.filter((x) => x.policyStatus === "EXPIRING SOON").length, totalPremiumValue: policies.reduce((sum, x) => sum + (Number(x.premiumAmount) || 0), 0) });
});

app.get("/api/security/audit", (_req, res) => res.json({ success: true, logs: readJson<any[]>(AUDIT_FILE, []) }));

app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled request error:", error);
  if (error?.type === "entity.too.large") return res.status(413).json({ error: "Request is too large", details: `Maximum request size is ${MAX_BODY}.` });
  return res.status(500).json({ error: "Server error", details: error?.message || "Unexpected server error" });
});

function startServer() {
  if (!fs.existsSync(DIST_INDEX)) throw new Error(`Production frontend is missing: ${DIST_INDEX}. Run npm run build first.`);
  app.use(express.static(DIST, { index: "index.html", maxAge: "1h" }));
  app.get("*", (_req, res) => res.sendFile(DIST_INDEX));
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`V Shiroya Policy AI listening on ${PORT}`);
    console.log(`Application root: ${ROOT}`);
    console.log(`Frontend build: ${DIST_INDEX}`);
    console.log(`OpenRouter keys configured: ${getOpenRouterKeys().length}`);
    console.log(`OpenRouter mode: ${process.env.OPENROUTER_ALLOW_PAID === "true" ? "paid allowed" : "FREE ONLY"}`);
    console.log(`Models: ${modelsToTry().join(", ")}`);
    console.log(`Parallel AI ensemble: ${AI_ENSEMBLE_SIZE}`);
    console.log(`PDF engine: ${process.env.OPENROUTER_PDF_ENGINE || "cloudflare-ai"}`);
  });
}

try { startServer(); }
catch (error) { console.error("Server startup failed:", error); process.exit(1); }
