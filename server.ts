import express from "express";
import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = process.env.APP_ROOT
  ? path.resolve(process.env.APP_ROOT)
  : (fs.existsSync(path.join(process.cwd(), "index.html")) ? process.cwd() : path.resolve(__dirname, ".."));
const DIST = path.join(ROOT, "dist");
const DIST_INDEX = path.join(DIST, "index.html");
const DATA_FILE = path.join(ROOT, "policies_db.json");
const AUDIT_FILE = path.join(ROOT, "security_audit.json");
const MAX_BODY = process.env.MAX_BODY_SIZE || "110mb";

app.disable("x-powered-by");

const allowedOrigins = new Set(
  [
    process.env.APP_URL,
    process.env.FRONTEND_URL,
    process.env.FIREBASE_APP_URL,
    "https://v-shiroya-policy.onrender.com",
    "http://localhost:3000",
    "http://localhost:5173",
  ]
    .map((value) => value?.trim().replace(/\/$/, ""))
    .filter(Boolean) as string[]
);

app.use((req, res, next) => {
  const origin = String(req.headers.origin || "").replace(/\/$/, "");
  if (!origin || allowedOrigins.has(origin)) {
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: MAX_BODY }));
app.use(express.urlencoded({ limit: MAX_BODY, extended: true }));

function readJson<T>(file: string, fallback: T): T {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as T : fallback;
  } catch (error) {
    console.error(`Failed to read ${file}:`, error);
    return fallback;
  }
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

// Six server-side keys are supported. Never expose these to the browser.
// The first key is the primary key. Backup keys are used only for key-specific
// authentication failures or transient upstream/network failures. A 429/quota
// response is NOT rotated around, so this does not bypass an OpenRouter rate limit.
function getOpenRouterKeys() {
  const names = [
    "OPENROUTER_API_KEY",
    "OPENROUTER_API_KEY_1",
    "OPENROUTER_API_KEY_2",
    "OPENROUTER_API_KEY_3",
    "OPENROUTER_API_KEY_4",
    "OPENROUTER_API_KEY_5",
  ];
  return names.map((name) => ({ name, value: process.env[name]?.trim() || "" }))
    .filter((item) => item.value && !item.value.startsWith("MY_"));
}

function modelsToTry() {
  const allowPaid = process.env.OPENROUTER_ALLOW_PAID === "true";
  if (!allowPaid) return ["openrouter/free"];
  const configured = (process.env.OPENROUTER_MODELS || process.env.OPENROUTER_MODEL || "openrouter/free")
    .split(",").map((value) => value.trim()).filter(Boolean);
  return [...new Set(configured.length ? configured : ["openrouter/free"])]
    .filter((model) => model === "openrouter/free" || model.endsWith(":free"));
}

const SCHEMA = `{"documentType":string,"detectedInsurer":string|null,"ownerName":string|null,"policyNumber":string|null,"providerCompany":string|null,"policyType":string|null,"startDate":string|null,"endDate":string|null,"premiumAmount":number|null,"premiumFrequency":string|null,"sumAssured":number|null,"insuredPerson":string|null,"nominee":string|null,"nomineeRelationship":string|null,"phoneNumber":string|null,"email":string|null,"address":string|null,"dateOfBirth":string|null,"agentName":string|null,"agentPhone":string|null,"branchName":string|null,"paymentMode":string|null,"policyStatus":"ACTIVE"|"EXPIRING SOON"|"EXPIRED","maturityDate":string|null,"additionalDetails":[{"label":string,"value":string,"confidence":"high"|"medium"|"low"}],"missingFields":string[],"uncertainFields":string[],"confidence":number,"extractedText":string,"fieldConfidenceMap":object}`;
const SYSTEM_PROMPT = `You are V Shiroya Policy AI, a professional insurance-policy OCR and audit engine. Analyze every page, table, header, footer, schedule, endorsement, rider, stamp and fine-print section. Never invent values. Use null when unreadable and record that field in missingFields or uncertainFields. Preserve exact policy numbers and names. Normalize dates to YYYY-MM-DD only when unambiguous. Return ONLY valid JSON matching this schema:\n${SCHEMA}`;

function buildContent(fileData: string, fileName: string, mimeType: string, instruction: string) {
  const dataUrl = fileData.startsWith("data:") ? fileData : `data:${mimeType};base64,${fileData.replace(/^data:[^,]+,/, "")}`;
  const parts: any[] = [{ type: "text", text: `${instruction || "Extract and audit this insurance policy comprehensively."}\nFilename: ${fileName}\nReturn the complete JSON object now.` }];
  if (mimeType.toLowerCase() === "application/pdf") parts.push({ type: "file", file: { filename: fileName || "policy.pdf", file_data: dataUrl } });
  else parts.push({ type: "image_url", image_url: { url: dataUrl } });
  return parts;
}

function isSafeFailoverStatus(status: number) {
  return status === 401 || status === 403 || status === 408 || status === 502 || status === 503 || status === 504;
}

async function callOpenRouter(fileData: string, fileName: string, mimeType: string, instruction: string) {
  const keys = getOpenRouterKeys();
  if (!keys.length) throw new Error("No OPENROUTER_API_KEY variables are configured.");
  let lastError = "Unknown OpenRouter error";

  for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
    const key = keys[keyIndex];
    for (const model of modelsToTry()) {
      try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key.value}`,
            "Content-Type": "application/json",
            "HTTP-Referer": process.env.APP_URL || "https://v-shiroya-policy.onrender.com",
            "X-Title": "V Shiroya Policy AI",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: buildContent(fileData, fileName, mimeType, instruction) },
            ],
            response_format: { type: "json_object" },
            temperature: 0.1,
          }),
        });
        const data: any = await response.json().catch(() => ({}));
        if (!response.ok) {
          lastError = data?.error?.message || `OpenRouter HTTP ${response.status}`;
          // Do not rotate keys for 429: that would be quota/rate-limit bypassing.
          if (response.status === 429) throw new Error(`OpenRouter rate limit reached: ${lastError}`);
          if (!isSafeFailoverStatus(response.status)) throw new Error(lastError);
          console.warn(`${key.name} failed (${response.status}); trying the next configured key.`);
          continue;
        }
        const content = data?.choices?.[0]?.message?.content;
        if (!content) { lastError = "OpenRouter returned no assistant content"; continue; }
        return { result: cleanJson(content), model: data?.model || model, usage: data.usage || null, keyName: key.name };
      } catch (error: any) {
        lastError = error?.message || String(error);
        if (/rate limit reached/i.test(lastError)) throw error;
        console.warn(`${key.name} request failed: ${lastError}`);
        break;
      }
    }
  }
  throw new Error(lastError);
}

function postProcess(result: any) {
  const out = { ...result };
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
  out.confidence = Math.max(0, Math.min(100, Number(out.confidence) || 0));
  return out;
}

app.get("/api/health", (_req, res) => res.json({
  ok: true,
  service: "V Shiroya Policy AI",
  aiProvider: "OpenRouter",
  configured: getOpenRouterKeys().length > 0,
  configuredKeyCount: getOpenRouterKeys().length,
  freeOnly: process.env.OPENROUTER_ALLOW_PAID !== "true",
  models: modelsToTry(),
  productionBuild: fs.existsSync(DIST_INDEX),
  frontendUrl: process.env.FRONTEND_URL || process.env.FIREBASE_APP_URL || "same-origin",
  timestamp: new Date().toISOString(),
}));

async function analyzeOne(payload: any, req: express.Request) {
  const { fileData, fileName, mimeType = "application/pdf", instruction = "" } = payload || {};
  if (!fileName) throw new Error("Filename is required");
  if (!fileData) throw new Error("File data is required");
  const analysis = await callOpenRouter(fileData, fileName, mimeType, instruction);
  const extraction = postProcess(analysis.result);
  addAuditLog("POLICY_ANALYSIS", `Analyzed ${fileName} with ${analysis.model}`, req);
  return { success: true, fileName, extraction, model: analysis.model, usage: analysis.usage };
}

app.post("/api/analyze-policy", async (req, res) => {
  if (!getOpenRouterKeys().length) return res.status(503).json({ error: "AI is not configured", details: "Set OPENROUTER_API_KEY through OPENROUTER_API_KEY_5 on the server." });
  try { return res.json(await analyzeOne(req.body, req)); }
  catch (error: any) { console.error("AI analysis failed:", error); return res.status(/rate limit/i.test(error?.message || "") ? 429 : 502).json({ error: "AI analysis failed", details: error?.message || "Unknown AI error" }); }
});

// Bulk endpoint always returns one item per submitted file, including an error item.
// The browser can also use individual requests; this endpoint is useful for API clients.
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
  policies.unshift(policy); writeJson(DATA_FILE, policies);
  addAuditLog("POLICY_CREATED", `Saved policy ${policy.policyNumber || policy.id}`, req);
  res.json({ success: true, policy });
});

app.get("/api/stats", (_req, res) => {
  const policies = readJson<any[]>(DATA_FILE, []);
  res.json({ totalPolicies: policies.length, activePolicies: policies.filter((x) => x.policyStatus === "ACTIVE").length, expiredPolicies: policies.filter((x) => x.policyStatus === "EXPIRED").length, expiringSoonPolicies: policies.filter((x) => x.policyStatus === "EXPIRING SOON").length, totalPremiumValue: policies.reduce((sum, x) => sum + (Number(x.premiumAmount) || 0), 0) });
});
app.get("/api/security/audit", (_req, res) => res.json({ success: true, logs: readJson<any[]>(AUDIT_FILE, []) }));

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
  });
}

try { startServer(); }
catch (error) { console.error("Server startup failed:", error); process.exit(1); }
