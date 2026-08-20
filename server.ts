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

// Allow the same-origin Render frontend and an optional Firebase frontend to call this API.
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
  try {
    fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
  } catch (error) {
    console.error(`Failed to write ${file}:`, error);
  }
}

function addAuditLog(action: string, details: string, req: express.Request) {
  const logs = readJson<any[]>(AUDIT_FILE, []);
  logs.unshift({
    id: `sec-${Date.now()}`,
    timestamp: new Date().toISOString(),
    action,
    actor: "V SHIROYA AI",
    details,
    ipAddress: req.ip || "unknown",
  });
  writeJson(AUDIT_FILE, logs.slice(0, 100));
}

function cleanJson(text: string): any {
  const cleaned = String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("AI returned invalid JSON");
  }
}

function getOpenRouterKey() {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  return key && !key.startsWith("MY_") ? key : null;
}

// IMPORTANT: this application is intentionally free-only.
// By default every AI request goes through OpenRouter's free router.
// Paid models cannot be selected accidentally through an old Render env var.
function modelsToTry() {
  const allowPaid = process.env.OPENROUTER_ALLOW_PAID === "true";
  if (!allowPaid) return ["openrouter/free"];

  const configured = (process.env.OPENROUTER_MODELS || process.env.OPENROUTER_MODEL || "openrouter/free")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(configured.length ? configured : ["openrouter/free"])]
    .filter((model) => model === "openrouter/free" || model.endsWith(":free"));
}

const SCHEMA = `{"documentType":string,"detectedInsurer":string|null,"ownerName":string|null,"policyNumber":string|null,"providerCompany":string|null,"policyType":string|null,"startDate":string|null,"endDate":string|null,"premiumAmount":number|null,"premiumFrequency":string|null,"sumAssured":number|null,"insuredPerson":string|null,"nominee":string|null,"nomineeRelationship":string|null,"phoneNumber":string|null,"email":string|null,"address":string|null,"dateOfBirth":string|null,"agentName":string|null,"agentPhone":string|null,"branchName":string|null,"paymentMode":string|null,"policyStatus":"ACTIVE"|"EXPIRING SOON"|"EXPIRED","maturityDate":string|null,"additionalDetails":[{"label":string,"value":string,"confidence":"high"|"medium"|"low"}],"missingFields":string[],"uncertainFields":string[],"confidence":number,"extractedText":string,"fieldConfidenceMap":object}`;

const SYSTEM_PROMPT = `You are V Shiroya Policy AI, a professional insurance-policy OCR and audit engine. Analyze every page, table, header, footer, schedule, endorsement, rider, stamp and fine-print section. Never invent values. Use null when unreadable and record that field in missingFields or uncertainFields. Preserve exact policy numbers and names. Normalize dates to YYYY-MM-DD only when unambiguous. Return ONLY valid JSON matching this schema:\n${SCHEMA}`;

function buildContent(fileData: string, fileName: string, mimeType: string, instruction: string) {
  const dataUrl = fileData.startsWith("data:")
    ? fileData
    : `data:${mimeType};base64,${fileData.replace(/^data:[^,]+,/, "")}`;
  const parts: any[] = [{
    type: "text",
    text: `${instruction || "Extract and audit this insurance policy comprehensively."}\nFilename: ${fileName}\nReturn the complete JSON object now.`,
  }];
  if (mimeType.toLowerCase() === "application/pdf") {
    // OpenRouter supports PDF file input directly. No paid OCR plugin is forced here.
    parts.push({ type: "file", file: { filename: fileName || "policy.pdf", file_data: dataUrl } });
  } else {
    parts.push({ type: "image_url", image_url: { url: dataUrl } });
  }
  return parts;
}

async function callOpenRouter(fileData: string, fileName: string, mimeType: string, instruction: string) {
  const key = getOpenRouterKey();
  if (!key) throw new Error("OPENROUTER_API_KEY is not configured.");

  let lastError = "Unknown OpenRouter error";
  for (const model of modelsToTry()) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
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
      const data: any = await response.json();
      if (!response.ok) {
        lastError = data?.error?.message || `OpenRouter HTTP ${response.status}`;
        console.warn(`OpenRouter free model ${model} failed: ${lastError}`);
        continue;
      }
      const content = data?.choices?.[0]?.message?.content;
      if (!content) {
        lastError = "OpenRouter returned no assistant content";
        continue;
      }
      return { result: cleanJson(content), model: data?.model || model, usage: data.usage || null };
    } catch (error: any) {
      lastError = error?.message || String(error);
      console.warn(`OpenRouter request failed for ${model}: ${lastError}`);
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
      const today = new Date();
      today.setHours(0, 0, 0, 0);
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
  configured: Boolean(getOpenRouterKey()),
  freeOnly: process.env.OPENROUTER_ALLOW_PAID !== "true",
  models: modelsToTry(),
  productionBuild: fs.existsSync(DIST_INDEX),
  frontendUrl: process.env.FRONTEND_URL || process.env.FIREBASE_APP_URL || "same-origin",
  timestamp: new Date().toISOString(),
}));

app.post("/api/analyze-policy", async (req, res) => {
  const { fileData, fileName, mimeType = "application/pdf", instruction = "" } = req.body || {};
  if (!fileName) return res.status(400).json({ error: "Filename is required" });
  if (!fileData) return res.status(400).json({ error: "File data is required" });
  if (!getOpenRouterKey()) return res.status(503).json({ error: "AI is not configured", details: "Set OPENROUTER_API_KEY on the server." });
  try {
    const analysis = await callOpenRouter(fileData, fileName, mimeType, instruction);
    const extraction = postProcess(analysis.result);
    addAuditLog("POLICY_ANALYSIS", `Analyzed ${fileName} with ${analysis.model}`, req);
    return res.json({ success: true, extraction, model: analysis.model, usage: analysis.usage });
  } catch (error: any) {
    console.error("AI analysis failed:", error);
    return res.status(502).json({ error: "AI analysis failed", details: error?.message || "Unknown AI error" });
  }
});

app.get("/api/policies", (req, res) => {
  let policies = readJson<any[]>(DATA_FILE, []);
  const query = String(req.query.q || "").toLowerCase().trim();
  if (query) {
    policies = policies.filter((policy) =>
      [policy.ownerName, policy.policyNumber, policy.providerCompany, policy.policyType, policy.phoneNumber]
        .some((value) => String(value || "").toLowerCase().includes(query))
    );
  }
  res.json({ success: true, count: policies.length, policies });
});

app.post("/api/policies", (req, res) => {
  const policies = readJson<any[]>(DATA_FILE, []);
  const policy = {
    ...req.body,
    id: req.body?.id || `pol-${Date.now()}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  policies.unshift(policy);
  writeJson(DATA_FILE, policies);
  addAuditLog("POLICY_CREATED", `Saved policy ${policy.policyNumber || policy.id}`, req);
  res.json({ success: true, policy });
});

app.get("/api/stats", (_req, res) => {
  const policies = readJson<any[]>(DATA_FILE, []);
  res.json({
    totalPolicies: policies.length,
    activePolicies: policies.filter((x) => x.policyStatus === "ACTIVE").length,
    expiredPolicies: policies.filter((x) => x.policyStatus === "EXPIRED").length,
    expiringSoonPolicies: policies.filter((x) => x.policyStatus === "EXPIRING SOON").length,
    totalPremiumValue: policies.reduce((sum, x) => sum + (Number(x.premiumAmount) || 0), 0),
  });
});

app.get("/api/security/audit", (_req, res) => res.json({ success: true, logs: readJson<any[]>(AUDIT_FILE, []) }));

function startServer() {
  if (!fs.existsSync(DIST_INDEX)) {
    throw new Error(`Production frontend is missing: ${DIST_INDEX}. Run npm run build first.`);
  }

  app.use(express.static(DIST, { index: "index.html", maxAge: "1h" }));
  app.get("*", (_req, res) => res.sendFile(DIST_INDEX));

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`V Shiroya Policy AI listening on ${PORT}`);
    console.log(`Application root: ${ROOT}`);
    console.log(`Frontend build: ${DIST_INDEX}`);
    console.log(`OpenRouter configured: ${Boolean(getOpenRouterKey())}`);
    console.log(`OpenRouter mode: ${process.env.OPENROUTER_ALLOW_PAID === "true" ? "paid allowed" : "FREE ONLY"}`);
    console.log(`Models: ${modelsToTry().join(", ")}`);
    console.log(`Allowed frontend origins: ${[...allowedOrigins].join(", ") || "same-origin only"}`);
  });
}

try {
  startServer();
} catch (error) {
  console.error("Server startup failed:", error);
  process.exit(1);
}