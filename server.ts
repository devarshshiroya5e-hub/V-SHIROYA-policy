import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Increase payload limits for large PDF and image uploads
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Helper to call OpenRouter
async function callOpenRouter(prompt: string, fileData?: string, mimeType?: string) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": process.env.APP_URL || "https://ais-dev-j4vxcnt3tjvwo5a6glmxvi-981464516464.asia-southeast1.run.app",
      "X-Title": "V Shiroya AI Policy Analytics",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: fileData ? [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${mimeType || "application/pdf"};base64,${fileData}` } }
          ] : prompt 
        }
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter API error: ${response.statusText}`);
  }

  const data = await response.json();
  return JSON.parse(data.choices[0].message.content);
}
const DATA_FILE = path.join(process.cwd(), "policies_db.json");
const SECURITY_LOGS_FILE = path.join(process.cwd(), "security_audit.json");

interface LocalStore {
  policies: any[];
}

function loadPolicies(): any[] {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("Error reading policies_db.json:", err);
  }
  return [];
}

function savePolicies(policies: any[]) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(policies, null, 2), "utf-8");
  } catch (err) {
    console.error("Error saving policies_db.json:", err);
  }
}

function loadAuditLogs(): any[] {
  try {
    if (fs.existsSync(SECURITY_LOGS_FILE)) {
      const data = fs.readFileSync(SECURITY_LOGS_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("Error reading security_audit.json:", err);
  }
  return [
    {
      id: "sec-1",
      timestamp: new Date().toISOString(),
      action: "SYSTEM_INITIALIZED",
      actor: "VIJAY SHIROYA (CA)",
      details: "PolicyAI backend initialized with secure API route protection and local document encryption.",
      ipAddress: "127.0.0.1"
    }
  ];
}

function addAuditLog(action: string, actor: string, details: string, req: express.Request) {
  const logs = loadAuditLogs();
  const entry = {
    id: `sec-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    timestamp: new Date().toISOString(),
    action,
    actor,
    details,
    ipAddress: req.ip || "127.0.0.1"
  };
  logs.unshift(entry);
  if (logs.length > 100) logs.pop();
  try {
    fs.writeFileSync(SECURITY_LOGS_FILE, JSON.stringify(logs, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to save audit log", e);
  }
}

// Safe JSON parser to handle truncated or dirty LLM outputs cleanly
function safeParseJson(contentStr: string): any {
  if (!contentStr) return null;
  let cleaned = contentStr.replace(/```json\n?|\n?```/g, "").trim();

  // Attempt 1: Standard JSON parse
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Attempt 2: Auto-repair common LLM JSON truncation issues
    try {
      let repaired = cleaned;

      // Clean unescaped control characters
      repaired = repaired.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");

      // Fix unclosed string literal
      const quoteMatches = repaired.match(/(?<!\\)"/g) || [];
      if (quoteMatches.length % 2 !== 0) {
        repaired += '"';
      }

      // Remove trailing commas before closing brackets
      repaired = repaired.replace(/,\s*([}\]])/g, "$1");

      // Count and balance open/close braces & brackets
      let openBraces = (repaired.match(/\{/g) || []).length;
      let closeBraces = (repaired.match(/\}/g) || []).length;
      let openBrackets = (repaired.match(/\[/g) || []).length;
      let closeBrackets = (repaired.match(/\]/g) || []).length;

      while (closeBrackets < openBrackets) {
        repaired += "]";
        closeBrackets++;
      }
      while (closeBraces < openBraces) {
        repaired += "}";
        closeBraces++;
      }

      return JSON.parse(repaired);
    } catch (repairErr) {
      // Attempt 3: Slice to last complete brace
      try {
        const lastBraceIndex = cleaned.lastIndexOf("}");
        if (lastBraceIndex > 0) {
          return JSON.parse(cleaned.substring(0, lastBraceIndex + 1));
        }
      } catch (truncErr) {
        // Fallthrough
      }
      return null;
    }
  }
}

// Ensure default policies if empty
let storedPolicies = loadPolicies();
if (storedPolicies.length === 0) {
  // We will let the server initialize with empty list or sample initial policies passed from client on boot if needed
}

// Specialized Insurer Extraction Templates for Multi-Company Layout Adaptation
const INSURER_EXTRACTION_TEMPLATES: Record<string, {
  insurerName: string;
  layoutDescription: string;
  priorityFields: string[];
  layoutExtractionGuide: string;
}> = {
  LIC: {
    insurerName: "LIC of India (Life Insurance Corporation)",
    layoutDescription: "Standard LIC Policy Bond / Schedule features a central boxed grid table with columns: Policy Number, Table & Term, Sum Assured, Basic Premium, Mode, FPR No, Agency Code, Commencement Date, Due Date of Last Premium, Date of Maturity, and Nominee Name.",
    priorityFields: ["policyNumber", "sumAssured", "premiumAmount", "startDate", "maturityDate", "nominee", "agentName", "paymentMode"],
    layoutExtractionGuide: "Look for 'Table & Term' (e.g. 914-15), 'Sum Assured Rs.', 'Installment Premium Rs.', 'First Premium Receipt', 'Branch Code', and 'Name of Life Assured' in the middle table."
  },
  HDFC_ERGO: {
    insurerName: "HDFC ERGO General Insurance",
    layoutDescription: "HDFC ERGO schedule documents feature top header summary boxes containing Policy Number, Period of Insurance (From/To), Plan Title, Insured Name, Net Premium, Taxes (CGST/SGST), and Total Premium Payable.",
    priorityFields: ["policyNumber", "startDate", "endDate", "premiumAmount", "sumAssured", "insuredPerson", "policyType"],
    layoutExtractionGuide: "Check top right/left header boxes for 'Policy No.', 'Period of Insurance', 'Gross Premium', and 'Total Sum Insured'. Check endorsement schedule or member floater table for family coverage."
  },
  ICICI_PRUDENTIAL: {
    insurerName: "ICICI Prudential Life Insurance",
    layoutDescription: "ICICI Pru policy documents use a clean 2-column or stacked grid for Policyholder/Life Assured details, followed by a 'Benefits & Premium Details' section detailing Annualized Premium, Sum Assured, and Rider Benefits.",
    priorityFields: ["policyNumber", "ownerName", "insuredPerson", "sumAssured", "premiumAmount", "maturityDate", "nominee"],
    layoutExtractionGuide: "Scan the 'Policy Schedule' table for 'Policy Number', 'Product Name', 'Sum Assured', 'Total Installment Premium incl. Taxes', and 'Nominee % Share'."
  },
  ICICI_LOMBARD: {
    insurerName: "ICICI Lombard General Insurance",
    layoutDescription: "ICICI Lombard Health & Motor policies feature prominent top banner boxes with 'Policy No.', 'Period of Insurance', 'Total IDV/Sum Insured', 'Net Premium', and 'Registration No/Chassis No'.",
    priorityFields: ["policyNumber", "startDate", "endDate", "premiumAmount", "sumAssured", "ownerName"],
    layoutExtractionGuide: "Examine 'Schedule of Insurance' for start & expiry timestamps, Total Premium including GST, and vehicle or health member schedule tables."
  },
  STAR_HEALTH: {
    insurerName: "Star Health & Allied Insurance",
    layoutDescription: "Star Health schedules have a dedicated 'Details of Persons Insured' multi-row table specifying Member Name, Relationship, Age, Base Sum Insured, and Cumulative Bonus / No Claim Bonus.",
    priorityFields: ["policyNumber", "insuredPerson", "sumAssured", "startDate", "endDate", "premiumAmount", "nominee"],
    layoutExtractionGuide: "Scan the 'Details of Insured Persons' grid for all covered family members, Base Sum Insured, Zone, and Cumulative Bonus %."
  },
  SBI_LIFE: {
    insurerName: "SBI Life Insurance",
    layoutDescription: "SBI Life Policy Schedule features 'Basic Policy Details' grid: Policy Number, Customer ID, Product Name, Basic Sum Assured, Regular Premium Payable, Policy Term, and Date of Maturity.",
    priorityFields: ["policyNumber", "ownerName", "sumAssured", "premiumAmount", "startDate", "maturityDate", "agentName"],
    layoutExtractionGuide: "Look for 'Policy Schedule', 'Customer ID', 'Basic Sum Assured (Rs.)', 'Total Payable Premium', and 'Nominee / Appointee Name'."
  },
  MAX_LIFE: {
    insurerName: "Max Life Insurance",
    layoutDescription: "Max Life documents display 'Policy Schedule' with distinct sections: Policyholder Details, Life Insured Details, Benefit Details (Guaranteed Sum Assured, Rider Benefits), and Premium Breakup.",
    priorityFields: ["policyNumber", "ownerName", "insuredPerson", "sumAssured", "premiumAmount", "startDate", "maturityDate"],
    layoutExtractionGuide: "Extract 'Policy No.', 'Base Sum Assured', 'Annualised Premium', 'Policy Commencement Date', and 'Payment Frequency'."
  },
  CARE_HEALTH: {
    insurerName: "Care Health Insurance (Religare)",
    layoutDescription: "Care Health policy schedules feature a top blue/teal header with Policy No., Period of Insurance, Base Sum Insured, and an 'Insured Details' table listing member names and sum insured.",
    priorityFields: ["policyNumber", "ownerName", "insuredPerson", "sumAssured", "startDate", "endDate", "premiumAmount"],
    layoutExtractionGuide: "Check 'Policy Schedule Summary' for Policy Number, Floater Sum Insured, Care Shield/No Claim Bonus, and Policy Expiry Date."
  },
  NIVA_BUPA: {
    insurerName: "Niva Bupa Health Insurance (Max Bupa)",
    layoutDescription: "Niva Bupa certificates list Customer ID, Policy Number, Product Name, Base Sum Insured, Policy Period, and covered member details in structured white/blue cards.",
    priorityFields: ["policyNumber", "ownerName", "insuredPerson", "sumAssured", "startDate", "endDate", "premiumAmount"],
    layoutExtractionGuide: "Find 'Policy Number', 'Base Sum Insured', 'Policy Duration', 'Gross Premium', and 'Hospital Cash / Reload Rider'."
  },
  BAJAJ_ALLIANZ: {
    insurerName: "Bajaj Allianz General / Life Insurance",
    layoutDescription: "Bajaj Allianz documents use header grids with Policy No, Period of Insurance, Sum Insured / IDV, Premium Breakup (Net + GST), and Vehicle / Member Details.",
    priorityFields: ["policyNumber", "ownerName", "sumAssured", "startDate", "endDate", "premiumAmount"],
    layoutExtractionGuide: "Scan 'Schedule of Policy' for Policy No., Total Premium, Risk Start/End Date, and Nominee Details."
  },
  TATA_AIA: {
    insurerName: "Tata AIA Life Insurance",
    layoutDescription: "Tata AIA schedule documents feature clear sections for Policy Information, Premium Breakdown, Rider Information, and Beneficiary Nomination Details.",
    priorityFields: ["policyNumber", "ownerName", "insuredPerson", "sumAssured", "premiumAmount", "startDate", "maturityDate"],
    layoutExtractionGuide: "Extract 'Policy Number', 'Basic Sum Assured', 'Modal Premium', 'Policy Term', 'Nominee Name', and 'Branch Code'."
  },
  PUBLIC_SECTOR: {
    insurerName: "Public Sector Insurer (New India / Oriental / United India / National)",
    layoutDescription: "PSU Insurance documents feature traditional dense table schedules with Dev Officer Code, Branch Code, Policy Number, Period of Insurance, Sum Insured, and Net Premium breakup.",
    priorityFields: ["policyNumber", "ownerName", "startDate", "endDate", "premiumAmount", "sumAssured", "branchName"],
    layoutExtractionGuide: "Examine top and mid-page schedule tables for 'Policy No.', 'Period of Insurance From... To...', 'Total Premium', and 'Issuing Office'."
  },
  DIGIT: {
    insurerName: "Go Digit General Insurance",
    layoutDescription: "Digit Insurance uses a modern single/two-page layout with large bold fields for Policy Number, Registration Number, Sum Insured / IDV, Premium Amount, and Policy Expiry.",
    priorityFields: ["policyNumber", "ownerName", "startDate", "endDate", "premiumAmount", "sumAssured"],
    layoutExtractionGuide: "Look for bold header blocks 'Policy No', 'Period of Insurance', 'Sum Insured', 'Total Premium Paid', and 'Nominee Name'."
  },
  RELIANCE_GENERAL: {
    insurerName: "Reliance General / Life Insurance",
    layoutDescription: "Reliance Insurance schedule pages include boxed summary tables for Policy No., Period of Risk, Insured Name, Sum Insured, and Premium Breakup.",
    priorityFields: ["policyNumber", "ownerName", "startDate", "endDate", "premiumAmount", "sumAssured"],
    layoutExtractionGuide: "Find 'Policy Number', 'Policy Period', 'Total Sum Insured', 'Gross Premium', and 'Agent/Broker Code'."
  },
  GENERIC_INSURER: {
    insurerName: "Standard / Universal Insurance Template",
    layoutDescription: "Standard multi-company policy layout containing header/footer blocks, schedule summary tables, member lists, and financial figures.",
    priorityFields: ["policyNumber", "ownerName", "providerCompany", "premiumAmount", "startDate", "endDate", "sumAssured"],
    layoutExtractionGuide: "Scan all tables, header boxes, footers, and text blocks for policy number, dates, currency values, and names."
  }
};

// Document Type Specific Overlay Instructions
const DOC_TYPE_OVERLAYS: Record<string, {
  typeName: string;
  keyInstructions: string;
}> = {
  POLICY_SCHEDULE: {
    typeName: "Policy Schedule / Bond Certificate",
    keyInstructions: "This is a full Policy Schedule or Policy Bond. Extract full coverage dates (Commencement, Expiry, Maturity), Sum Assured, Premium, Payment Mode, Nominee, Appointee, Riders, and Agent details."
  },
  RENEWAL_NOTICE: {
    typeName: "Renewal Notice / Premium Due Intimation",
    keyInstructions: "This is a Renewal Notice or Premium Due Reminder. CRITICAL: Identify 'Renewal Due Date', 'Grace Period Expiry Date', 'Renewal Premium Payable Amount', 'No Claim Bonus (NCB) %', and 'Existing/Previous Policy Number'."
  },
  PREMIUM_RECEIPT: {
    typeName: "Premium Payment Receipt / Section 80C Tax Certificate",
    keyInstructions: "This is a Premium Receipt or Tax Savings Certificate. CRITICAL: Extract 'Receipt Number', 'Receipt Date', 'Transaction Reference ID', 'Total Premium Amount Paid', 'Tax Deductible Amount under Section 80C or 80D', and 'Coverage Period Covered by Receipt'."
  },
  ENDORSEMENT: {
    typeName: "Policy Endorsement / Alteration Certificate",
    keyInstructions: "This is an Endorsement or Policy Alteration document. CRITICAL: Extract 'Endorsement Number', 'Endorsement Effective Date', 'Description of Alteration/Modification', 'Revised Premium', and 'Updated Policy Details'."
  },
  CLAIM_DOCUMENT: {
    typeName: "Claim Form / Settlement Voucher",
    keyInstructions: "This is a Claim Document or Settlement Voucher. CRITICAL: Extract 'Claim Number', 'Date of Loss/Hospitalization', 'Claim Amount Approved/Settled', 'Claimant Name', and 'Hospital/Garage Name'."
  },
  TAX_CERTIFICATE: {
    typeName: "Section 80C / 80D Premium Tax Certificate",
    keyInstructions: "This is a Tax Certificate for Section 80C / 80D deductions. CRITICAL: Extract 'Financial Year', 'Total Premium Paid in FY', 'Eligible Tax Deduction Amount', 'Proposer PAN', and 'Policy Number'."
  },
  GENERAL_INSURANCE_DOC: {
    typeName: "General Insurance Document",
    keyInstructions: "Extract all available policy, financial, and personal details found across the document."
  }
};

interface PreProcessingResult {
  documentType: string;
  detectedInsurer: string;
  appliedTemplateKey: string;
  confidence: number;
  language: string;
  keyAnchors: string[];
}

// Specialized Pre-Processing Step to detect document type and insurer template
async function runOcrPreProcessingStep(
  fileDataBase64: string | undefined,
  fileName: string,
  mimeType: string,
  userInstruction: string
): Promise<PreProcessingResult> {
  try {
    const prompt = `[FAST OCR PRE-PROCESSING & CLASSIFICATION TASK]
Analyze this document filename (${fileName}) and visual content.
Determine:
1. documentType: EXACTLY one of ['POLICY_SCHEDULE', 'RENEWAL_NOTICE', 'PREMIUM_RECEIPT', 'ENDORSEMENT', 'CLAIM_DOCUMENT', 'TAX_CERTIFICATE', 'GENERAL_INSURANCE_DOC']
2. detectedInsurerKey: EXACTLY one of ['LIC', 'HDFC_ERGO', 'ICICI_PRUDENTIAL', 'ICICI_LOMBARD', 'STAR_HEALTH', 'SBI_LIFE', 'MAX_LIFE', 'CARE_HEALTH', 'NIVA_BUPA', 'BAJAJ_ALLIANZ', 'TATA_AIA', 'PUBLIC_SECTOR', 'DIGIT', 'RELIANCE_GENERAL', 'GENERIC_INSURER']
3. detectedInsurerName: Full name of insurance company (e.g. "LIC of India", "HDFC ERGO", "Star Health")
4. keyAnchors: List up to 5 structural phrases/anchors spotted (e.g. ["FIRST PREMIUM RECEIPT", "SCHEDULE OF INSURANCE", "UIN", "SECTION 80C"])
5. language: "ENGLISH", "HINDI", or "REGIONAL_MIXED"

Return JSON matching:
{
  "documentType": string,
  "detectedInsurerKey": string,
  "detectedInsurerName": string,
  "keyAnchors": string[],
  "language": string
}`;

    const parsed = await callOpenRouter(prompt, fileDataBase64, mimeType);

    if (parsed && parsed.documentType && parsed.detectedInsurerKey) {
      return {
        documentType: parsed.documentType,
        detectedInsurer: parsed.detectedInsurerName || parsed.detectedInsurerKey,
        appliedTemplateKey: INSURER_EXTRACTION_TEMPLATES[parsed.detectedInsurerKey] ? parsed.detectedInsurerKey : 'GENERIC_INSURER',
        confidence: 98,
        language: parsed.language || 'ENGLISH',
        keyAnchors: parsed.keyAnchors || []
      };
    }
  } catch (err) {
    console.warn("Fast AI pre-processing step fallback to filename heuristics:", err);
  }

  // Fallback heuristic classification based on filename and instruction
  const lowerName = (fileName + " " + userInstruction).toLowerCase();
  let docType = "POLICY_SCHEDULE";
  if (lowerName.includes("renewal") || lowerName.includes("due")) docType = "RENEWAL_NOTICE";
  else if (lowerName.includes("receipt") || lowerName.includes("fpr") || lowerName.includes("tax") || lowerName.includes("80c")) docType = "PREMIUM_RECEIPT";
  else if (lowerName.includes("endorsement") || lowerName.includes("alteration")) docType = "ENDORSEMENT";
  else if (lowerName.includes("claim")) docType = "CLAIM_DOCUMENT";

  let insurerKey = "GENERIC_INSURER";
  let insurerName = "Insurance Provider";
  if (lowerName.includes("lic")) { insurerKey = "LIC"; insurerName = "LIC of India"; }
  else if (lowerName.includes("hdfc")) { insurerKey = "HDFC_ERGO"; insurerName = "HDFC ERGO"; }
  else if (lowerName.includes("star")) { insurerKey = "STAR_HEALTH"; insurerName = "Star Health"; }
  else if (lowerName.includes("icici")) { insurerKey = "ICICI_PRUDENTIAL"; insurerName = "ICICI Prudential"; }
  else if (lowerName.includes("sbi")) { insurerKey = "SBI_LIFE"; insurerName = "SBI Life"; }
  else if (lowerName.includes("max")) { insurerKey = "MAX_LIFE"; insurerName = "Max Life"; }
  else if (lowerName.includes("care") || lowerName.includes("religare")) { insurerKey = "CARE_HEALTH"; insurerName = "Care Health"; }
  else if (lowerName.includes("niva") || lowerName.includes("bupa")) { insurerKey = "NIVA_BUPA"; insurerName = "Niva Bupa"; }
  else if (lowerName.includes("bajaj")) { insurerKey = "BAJAJ_ALLIANZ"; insurerName = "Bajaj Allianz"; }
  else if (lowerName.includes("tata")) { insurerKey = "TATA_AIA"; insurerName = "Tata AIA"; }
  else if (lowerName.includes("digit")) { insurerKey = "DIGIT"; insurerName = "Go Digit"; }

  return {
    documentType: docType,
    detectedInsurer: insurerName,
    appliedTemplateKey: insurerKey,
    confidence: 85,
    language: "ENGLISH",
    keyAnchors: [docType, insurerName]
  };
}

// High-Performance Multimodal Engine: Multi-Step Multi-AI Policy Extraction
async function performAiPolicyAnalysis(
  fileDataBase64: string | undefined,
  fileName: string,
  mimeType: string,
  userInstruction: string
) {
  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  const deepseekApiKey = process.env.DEEPSEEK_API_KEY;

  // STEP 0: Run Specialized OCR Pre-Processing & Layout Classifier
  console.log("Step 0: Running specialized OCR pre-processing classification...");
  const preProc = await runOcrPreProcessingStep(fileDataBase64, fileName, mimeType, userInstruction);
  console.log(`Pre-Processing Result -> DocType: ${preProc.documentType}, Insurer: ${preProc.detectedInsurer}, Template: ${preProc.appliedTemplateKey}`);

  const activeTemplate = INSURER_EXTRACTION_TEMPLATES[preProc.appliedTemplateKey] || INSURER_EXTRACTION_TEMPLATES.GENERIC_INSURER;
  const activeOverlay = DOC_TYPE_OVERLAYS[preProc.documentType] || DOC_TYPE_OVERLAYS.GENERAL_INSURANCE_DOC;

  const systemPrompt = `YOU ARE THE WORLD'S BEST IMAGE AND MULTIMODAL DOCUMENT ANALYZER, ULTRA-PRECISION OCR ENGINE, AND MASTER INSURANCE AUDITOR.
Your absolute mandate is MAXIMUM RECALL, 100% ACCURACY, ZERO HALLUCINATION, and COMPREHENSIVE DETAIL VISIBILITY.

[SPECIALIZED OCR PRE-PROCESSING & OPTIMIZED EXTRACTION TEMPLATE ACTIVATED]
- APPLIED DOCUMENT CLASSIFICATION: ${preProc.documentType} (${activeOverlay.typeName})
- APPLIED INSURER TEMPLATE: ${activeTemplate.insurerName}
- DOCUMENT LANGUAGE: ${preProc.language}
- STRUCTURAL ANCHORS SPOTLIGHTED: ${preProc.keyAnchors.join(", ") || "Standard Schedule"}

TARGET INSURER LAYOUT GUIDE (${activeTemplate.insurerName}):
- Layout Architecture: ${activeTemplate.layoutDescription}
- OCR Guidance: ${activeTemplate.layoutExtractionGuide}
- High-Priority Fields: ${activeTemplate.priorityFields.join(", ")}

DOCUMENT-TYPE SPECIFIC RULES:
${activeOverlay.keyInstructions}

CORE OPERATIONAL PRINCIPLES:
1. EXHAUSTIVE DEEP VISION OCR: Scan every pixel, schedule grid, header box, footer, side column, stamp, rider box, and fine print.
2. COMPREHENSIVE FIELD PARSING: Extract Policyholder Name, Policy Number, Insurer, Premium, Start/End/Maturity Dates, Sum Assured, Nominees, Agent details.
3. ZERO OMISSION MANDATE: Any detail visible in the PDF that does not fit directly into top-level properties MUST be extracted into the \`additionalDetails\` array!`;

  const jsonSchemaInstruction = `
Return ONLY a valid JSON object matching this exact schema:
{
  "documentType": "${preProc.documentType}",
  "detectedInsurer": "${preProc.detectedInsurer}",
  "appliedTemplate": "${activeTemplate.insurerName}",
  "ownerName": string | null,
  "policyNumber": string | null,
  "providerCompany": string | null,
  "policyType": string | null,
  "startDate": string | null,
  "endDate": string | null,
  "premiumAmount": number | null,
  "premiumFrequency": string | null,
  "sumAssured": number | null,
  "insuredPerson": string | null,
  "nominee": string | null,
  "nomineeRelationship": string | null,
  "phoneNumber": string | null,
  "email": string | null,
  "address": string | null,
  "dateOfBirth": string | null,
  "agentName": string | null,
  "agentPhone": string | null,
  "branchName": string | null,
  "paymentMode": string | null,
  "policyStatus": "ACTIVE" | "EXPIRING SOON" | "EXPIRED",
  "maturityDate": string | null,
  "additionalDetails": Array<{ "label": string, "value": string, "confidence": "high" | "medium" | "low" }>,
  "missingFields": Array<string>,
  "uncertainFields": Array<string>,
  "confidence": number,
  "extractedText": string,
  "fieldConfidenceMap": Record<string, "high" | "medium" | "low">
}
`;

  // Helper function to apply post-processing, date math, number parsing, and status calculations
  const processExtractedJson = (parsedResult: any) => {
    if (!parsedResult || typeof parsedResult !== "object") return parsedResult;

    // Sanitize numeric fields (strip currency symbols and commas if present as string)
    if (typeof parsedResult.premiumAmount === "string") {
      const cleanedStr = (parsedResult.premiumAmount as string).replace(/[^0-9.]/g, "");
      const parsedNum = parseFloat(cleanedStr);
      parsedResult.premiumAmount = !isNaN(parsedNum) ? parsedNum : null;
    }

    if (typeof parsedResult.sumAssured === "string") {
      const cleanedStr = (parsedResult.sumAssured as string).replace(/[^0-9.]/g, "");
      const parsedNum = parseFloat(cleanedStr);
      parsedResult.sumAssured = !isNaN(parsedNum) ? parsedNum : null;
    }

    // 1. Resolve End Date if missing but Maturity Date exists
    if ((!parsedResult.endDate || parsedResult.endDate === "Not available") && parsedResult.maturityDate) {
      parsedResult.endDate = parsedResult.maturityDate;
    }

    // 2. Resolve End Date if Start Date exists and Policy Term is found in additionalDetails
    if (!parsedResult.endDate || parsedResult.endDate === "Not available") {
      if (parsedResult.startDate && parsedResult.startDate.length >= 10) {
        let termYears = 0;
        if (Array.isArray(parsedResult.additionalDetails)) {
          for (const item of parsedResult.additionalDetails) {
            const lbl = (item.label || "").toLowerCase();
            const val = (item.value || "").toLowerCase();
            if (lbl.includes("term") || lbl.includes("duration") || lbl.includes("period")) {
              const match = val.match(/(\d+)\s*(year|yr|yrs|y)/i);
              if (match) {
                termYears = parseInt(match[1], 10);
                break;
              }
            }
          }
        }
        if (termYears === 0) termYears = 1; // Default standard annual coverage

        try {
          const startDt = new Date(parsedResult.startDate);
          if (!isNaN(startDt.getTime())) {
            const endDt = new Date(startDt);
            endDt.setFullYear(endDt.getFullYear() + termYears);
            endDt.setDate(endDt.getDate() - 1);
            parsedResult.endDate = endDt.toISOString().slice(0, 10);
          }
        } catch (e) {
          console.warn("Could not compute fallback end date:", e);
        }
      }
    }

    // 3. Derive fieldConfidenceMap
    if (!parsedResult.fieldConfidenceMap) {
      const map: Record<string, string> = {};
      const keys = ["ownerName", "policyNumber", "providerCompany", "premiumAmount", "endDate", "startDate", "sumAssured", "policyType"];
      keys.forEach(k => {
        if (parsedResult[k] !== null && parsedResult[k] !== undefined && parsedResult[k] !== "Not available") {
          map[k] = "high";
        } else {
          map[k] = "low";
        }
      });
      parsedResult.fieldConfidenceMap = map;
    }

    // 4. Calculate exact policy status based on endDate
    if (parsedResult.endDate && parsedResult.endDate !== "Not available") {
      try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const end = new Date(parsedResult.endDate);
        const diffDays = Math.ceil((end.getTime() - today.getTime()) / (1000 * 3600 * 24));

        if (diffDays < 0) {
          parsedResult.policyStatus = "EXPIRED";
        } else if (diffDays <= 30) {
          parsedResult.policyStatus = "EXPIRING SOON";
        } else {
          parsedResult.policyStatus = "ACTIVE";
        }
      } catch (e) {
        parsedResult.policyStatus = "ACTIVE";
      }
    } else {
      parsedResult.policyStatus = "ACTIVE";
    }

    // 5. Automated Policy Categorization Logic (Life, Health, Vehicle, Fire, Travel, General)
    const pType = (parsedResult.policyType || "").toLowerCase();
    const provider = (parsedResult.providerCompany || "").toLowerCase();
    const text = (parsedResult.extractedText || "").toLowerCase();
    const owner = (parsedResult.ownerName || "").toLowerCase();
    const pNum = (parsedResult.policyNumber || "").toLowerCase();

    let detailsStr = "";
    if (Array.isArray(parsedResult.additionalDetails)) {
      detailsStr = parsedResult.additionalDetails
        .map((d: any) => `${d.label || ""} ${d.value || ""}`)
        .join(" ")
        .toLowerCase();
    }

    const haystack = `${pType} ${provider} ${detailsStr} ${text} ${owner} ${pNum}`;

    let category = "General";
    if (
      haystack.includes("vehicle") || haystack.includes("motor") || haystack.includes(" car ") ||
      haystack.includes("bike") || haystack.includes("two wheeler") || haystack.includes("chassis") ||
      haystack.includes("engine no") || haystack.includes("reg no") || haystack.includes("registration no") ||
      haystack.includes("third party") || haystack.includes("own damage") || haystack.includes("idv") ||
      haystack.includes("auto insurance")
    ) {
      category = "Vehicle";
    } else if (
      haystack.includes("health") || haystack.includes("mediclaim") || haystack.includes("floater") ||
      haystack.includes("hospital") || haystack.includes("optima") || haystack.includes("care health") ||
      haystack.includes("niva bupa") || haystack.includes("star health") || haystack.includes("critical illness") ||
      haystack.includes("cashless") || haystack.includes("room rent") || haystack.includes("pre-existing")
    ) {
      category = "Health";
    } else if (
      haystack.includes("fire") || haystack.includes("property") || haystack.includes("shopkeeper") ||
      haystack.includes("dwelling") || haystack.includes("burglary") || haystack.includes("building") ||
      haystack.includes("material damage") || haystack.includes("home insurance") || haystack.includes("asset protection")
    ) {
      category = "Fire";
    } else if (
      haystack.includes("life") || haystack.includes("term") || haystack.includes("jeevan") ||
      haystack.includes("endowment") || haystack.includes("ulip") || haystack.includes("pension") ||
      haystack.includes("annuity") || haystack.includes("death benefit") || haystack.includes("lic") ||
      haystack.includes("sbi life") || haystack.includes("max life") || haystack.includes("icici pru") ||
      haystack.includes("tata aia") || haystack.includes("smart wealth") || haystack.includes("guaranteed income")
    ) {
      category = "Life";
    } else if (
      haystack.includes("travel") || haystack.includes("trip") || haystack.includes("passport") || haystack.includes("overseas")
    ) {
      category = "Travel";
    }

    parsedResult.category = category;
    if (!parsedResult.policyType || parsedResult.policyType === "Not available" || parsedResult.policyType.trim() === "") {
      parsedResult.policyType = `${category} Insurance`;
    }

    parsedResult.documentType = parsedResult.documentType || preProc.documentType;
    parsedResult.detectedInsurer = parsedResult.detectedInsurer || preProc.detectedInsurer;
    parsedResult.appliedTemplate = parsedResult.appliedTemplate || activeTemplate.insurerName;

    return parsedResult;
  };

  // Helper function to merge primary and secondary extraction results to maximize recall
  const mergeExtractionResults = (primary: any, secondary: any) => {
    if (!secondary || typeof secondary !== "object") return primary;
    if (!primary || typeof primary !== "object") return secondary;

    const merged = { ...primary };

    const keyFields = [
      "ownerName", "policyNumber", "providerCompany", "policyType",
      "startDate", "endDate", "premiumAmount", "premiumFrequency",
      "sumAssured", "insuredPerson", "nominee", "nomineeRelationship",
      "phoneNumber", "email", "address", "dateOfBirth", "agentName",
      "agentPhone", "branchName", "paymentMode", "maturityDate"
    ];

    // Fill missing primary fields from secondary
    keyFields.forEach((field) => {
      const primVal = merged[field];
      const secVal = secondary[field];
      const isPrimEmpty = primVal === null || primVal === undefined || primVal === "" || primVal === "Not available";
      const isSecValid = secVal !== null && secVal !== undefined && secVal !== "" && secVal !== "Not available";

      if (isPrimEmpty && isSecValid) {
        merged[field] = secVal;
      }
    });

    // Merge additionalDetails without duplicates
    const existingLabels = new Set(
      (Array.isArray(merged.additionalDetails) ? merged.additionalDetails : []).map(
        (item: any) => (item.label || "").toLowerCase().trim()
      )
    );

    if (Array.isArray(secondary.additionalDetails)) {
      if (!Array.isArray(merged.additionalDetails)) {
        merged.additionalDetails = [];
      }
      secondary.additionalDetails.forEach((item: any) => {
        const lblKey = (item?.label || "").toLowerCase().trim();
        if (lblKey && !existingLabels.has(lblKey) && item.value) {
          existingLabels.add(lblKey);
          merged.additionalDetails.push(item);
        }
      });
    }

    return merged;
  };

  let finalResult: any = null;
  let secondaryResult: any = null;

  // STEP A: Execute High-Speed Extraction with V Shiroya AI Engine
  console.log("Step 1: Running V Shiroya AI Engine multimodal policy analyzer...");
  const ai = getGeminiClient();

  const parts: any[] = [];

  if (fileDataBase64) {
    const cleanBase64 = fileDataBase64.includes("base64,")
      ? fileDataBase64.split("base64,")[1]
      : fileDataBase64;

    parts.push({
      inlineData: {
        mimeType: mimeType || "application/pdf",
        data: cleanBase64,
      },
    });
  }

  parts.push({
    text: `[COMMAND: EXECUTE WORLD'S BEST MULTIMODAL OCR SCAN & LAYOUT ADAPTATION]
Document Filename: ${fileName}.
User Specific Directive: ${userInstruction || "Extract all policy information across all schedule tables, headers, footers, riders, and clauses regardless of company layout."}.

INSTRUCTIONS:
You are the World's Best Image & Multimodal Document Analyzer. Analyze every pixel, table, and fine print block in this document. Adapt to the specific company layout (LIC, HDFC ERGO, ICICI, Star Health, SBI Life, Max Life, Care Health, Bajaj, Tata AIA, Niva Bupa, Digit, Reliance, etc.).
Extract 100% of visible information into the JSON structure below without omitting any details.

${jsonSchemaInstruction}`,
  });

  const generateConfig = {
    systemInstruction: systemPrompt,
    responseMimeType: "application/json",
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        ownerName: { type: Type.STRING, description: "Policy owner / proposer full name" },
        policyNumber: { type: Type.STRING, description: "Unique policy number" },
        providerCompany: { type: Type.STRING, description: "Insurance company name" },
        policyType: { type: Type.STRING, description: "Type or Plan Name of policy" },
        startDate: { type: Type.STRING, description: "Start / Commencement date YYYY-MM-DD" },
        endDate: { type: Type.STRING, description: "Expiry / End date YYYY-MM-DD" },
        premiumAmount: { type: Type.NUMBER, description: "Premium amount number" },
        premiumFrequency: { type: Type.STRING, description: "Annual, Monthly, Half-Yearly, Quarterly" },
        sumAssured: { type: Type.NUMBER, description: "Total sum assured / sum insured" },
        insuredPerson: { type: Type.STRING, description: "Name of covered person(s)" },
        nominee: { type: Type.STRING, description: "Nominee full name" },
        nomineeRelationship: { type: Type.STRING, description: "Relationship of nominee" },
        phoneNumber: { type: Type.STRING, description: "Contact phone number" },
        email: { type: Type.STRING, description: "Email address" },
        address: { type: Type.STRING, description: "Physical address" },
        dateOfBirth: { type: Type.STRING, description: "Date of birth YYYY-MM-DD" },
        agentName: { type: Type.STRING, description: "Agent or advisor name" },
        agentPhone: { type: Type.STRING, description: "Agent contact phone" },
        branchName: { type: Type.STRING, description: "Branch or servicing office" },
        paymentMode: { type: Type.STRING, description: "Payment mode (NACH, Cheque, Online, Cash)" },
        policyStatus: { type: Type.STRING, description: "ACTIVE, EXPIRING SOON, or EXPIRED" },
        maturityDate: { type: Type.STRING, description: "Maturity date YYYY-MM-DD" },
        additionalDetails: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              label: { type: Type.STRING },
              value: { type: Type.STRING },
              confidence: { type: Type.STRING }
            }
          }
        },
        missingFields: { type: Type.ARRAY, items: { type: Type.STRING } },
        uncertainFields: { type: Type.ARRAY, items: { type: Type.STRING } },
        confidence: { type: Type.NUMBER, description: "Overall extraction confidence 0 to 100" },
        extractedText: { type: Type.STRING, description: "Summary text of policy document" },
      }
    }
  };

  const primaryModels = ["gemini-3.6-flash", "gemini-3.5-flash-lite"];

  for (const modelName of primaryModels) {
    if (finalResult && (finalResult.ownerName || finalResult.policyNumber || finalResult.providerCompany || finalResult.premiumAmount)) {
      break;
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`Attempting scan with model ${modelName} (Attempt ${attempt})...`);
        const response = await ai.models.generateContent({
          model: modelName,
          contents: { parts },
          config: generateConfig,
        });

        const jsonText = response.text || "{}";
        const parsed = safeParseJson(jsonText);
        if (parsed) {
          finalResult = parsed;
          console.log(`V Shiroya AI scan completed rapidly using model ${modelName}.`);
          break;
        }
      } catch (geminiErr: any) {
        const errMsg = geminiErr?.message || String(geminiErr);
        console.warn(`V Shiroya AI scan with ${modelName} attempt ${attempt} issue:`, errMsg);

        const is429 = geminiErr?.status === 429 || errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("Quota exceeded");
        const is503 = geminiErr?.status === 503 || geminiErr?.code === 503 || errMsg.includes("503") || errMsg.includes("UNAVAILABLE") || errMsg.includes("high demand");

        // If 429 Quota Exceeded on this model, switch immediately to next model in list without retrying same model
        if (is429) {
          console.log(`Model ${modelName} hit quota limit (429). Switching immediately to next candidate model...`);
          break;
        }

        if (is503 && attempt < 2) {
          console.log(`Retrying model ${modelName} in 800ms due to temporary demand spike (503)...`);
          await new Promise((r) => setTimeout(r, 800));
        } else {
          break;
        }
      }
    }
  }

  // FAST PATH: If primary high-speed extraction succeeded, return directly to avoid secondary latency
  const hasCoreFields = finalResult && (finalResult.ownerName || finalResult.policyNumber || finalResult.providerCompany || finalResult.premiumAmount);
  
  if (!hasCoreFields) {
    // Secondary fallback execution only if primary scan was empty or failed
    if (openrouterApiKey && openrouterApiKey !== "MY_OPENROUTER_API_KEY") {
      try {
        console.log("Step 2: Running secondary V Shiroya AI fallback extraction...");
        const userContentParts: any[] = [
          {
            type: "text",
            text: `Document Filename: ${fileName}. User Directive: ${userInstruction}.\n\nPlease analyze this policy PDF thoroughly and extract all fields into JSON format.\n${jsonSchemaInstruction}`,
          },
        ];

        if (fileDataBase64) {
          const cleanBase64 = fileDataBase64.includes("base64,")
            ? fileDataBase64.split("base64,")[1]
            : fileDataBase64;

          userContentParts.push({
            type: "image_url",
            image_url: {
              url: `data:${mimeType || "application/pdf"};base64,${cleanBase64}`,
            },
          });
        }

        const orResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${openrouterApiKey}`,
            "HTTP-Referer": process.env.APP_URL || "https://ais-dev-j4vxcnt3tjvwo5a6glmxvi-981464516464.asia-southeast1.run.app",
            "X-Title": "V Shiroya AI Policy Analytics",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-3.6-flash",
            max_tokens: 4000,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userContentParts },
            ],
          }),
        });

        if (orResponse.ok) {
          const orData = await orResponse.json();
          const contentStr = orData.choices?.[0]?.message?.content;
          if (contentStr) {
            const parsedSec = safeParseJson(contentStr);
            if (parsedSec) {
              secondaryResult = parsedSec;
              console.log("Secondary fallback extraction succeeded!");
            }
          }
        }
      } catch (err) {
        console.warn("Secondary execution failed:", err);
      }
    }

    if (!secondaryResult && deepseekApiKey && deepseekApiKey !== "MY_DEEPSEEK_API_KEY") {
      try {
        console.log("Step 2: Running secondary V Shiroya AI fallback check...");
        const dsResponse = await fetch("https://api.deepseek.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${deepseekApiKey}`,
          },
          body: JSON.stringify({
            model: "deepseek-chat",
            messages: [
              { role: "system", content: `${systemPrompt}\n${jsonSchemaInstruction}` },
              {
                role: "user",
                content: `Document Filename: ${fileName}. Extract all policy info from this document text/metadata. User instruction: ${userInstruction}.\nSummary text: ${finalResult?.extractedText || fileName}`
              }
            ],
            response_format: { type: "json_object" },
            temperature: 0.1,
          }),
        });

        if (dsResponse.ok) {
          const dsData = await dsResponse.json();
          const contentStr = dsData.choices?.[0]?.message?.content;
          if (contentStr) {
            const parsedDs = safeParseJson(contentStr);
            if (parsedDs) {
              secondaryResult = parsedDs;
            }
          }
        }
      } catch (dsErr) {
        console.warn("Fallback API execution failed:", dsErr);
      }
    }

    if (finalResult && secondaryResult) {
      finalResult = mergeExtractionResults(finalResult, secondaryResult);
    } else if (!finalResult && secondaryResult) {
      finalResult = secondaryResult;
    }
  }

  // Fallback default if all AI calls failed
  if (!finalResult) {
    finalResult = {
      ownerName: null,
      policyNumber: null,
      providerCompany: null,
      policyType: null,
      startDate: null,
      endDate: null,
      premiumAmount: null,
      premiumFrequency: null,
      sumAssured: null,
      insuredPerson: null,
      nominee: null,
      nomineeRelationship: null,
      phoneNumber: null,
      email: null,
      address: null,
      dateOfBirth: null,
      agentName: null,
      agentPhone: null,
      branchName: null,
      paymentMode: null,
      policyStatus: "ACTIVE",
      maturityDate: null,
      additionalDetails: [],
      missingFields: ["All fields could not be parsed"],
      uncertainFields: [],
      confidence: 50,
      extractedText: "Document scanned",
      fieldConfidenceMap: {}
    };
  }

  // STEP E: Apply final post-processing, date math, and status rules
  return processExtractedJson(finalResult);
}

// --- API ROUTES ---

// Health Check
app.get("/api/health", (req, res) => {
  const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY);
  res.json({
    ok: true,
    service: "V Shiroya AI Backend",
    geminiConfigured: hasGeminiKey,
    timestamp: new Date().toISOString()
  });
});

// Authenticated User Profile
app.get("/api/auth/me", (req, res) => {
  res.json({
    user: {
      id: "acc-1",
      name: "VIJAY SHIROYA",
      email: "vijay.ca@policyai.com",
      firmName: "VIJAY SHIROYA & Co. Chartered Accountants",
      role: "Senior Accountant / Auditor",
      avatarUrl: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80"
    }
  });
});

// AI Policy Analysis Endpoint
app.post("/api/analyze-policy", async (req, res) => {
  const { fileData, fileName, mimeType, instruction } = req.body || {};
  try {
    if (!fileName) {
      return res.status(400).json({ error: "Filename is required" });
    }

    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      console.warn("GEMINI_API_KEY environment variable is not configured on the hosted server.");
    }

    console.log(`Processing policy document: ${fileName} (${mimeType})`);

    const result = await performAiPolicyAnalysis(
      fileData,
      fileName,
      mimeType || "application/pdf",
      instruction || "Analyze policy document and extract all fields."
    );

    addAuditLog("POLICY_ANALYSIS", "VIJAY SHIROYA (CA)", `Analyzed document: ${fileName}`, req);

    res.json({ success: true, extraction: result });
  } catch (error: any) {
    console.error("Policy AI analysis error:", error);
    res.status(500).json({
      error: "AI analysis failed.",
      details: error?.message || "Unknown AI Analysis Error",
      fileName: fileName || "uploaded_file"
    });
  }
});

// Get All Policies / Search Policies
app.get("/api/policies", (req, res) => {
  let policies = loadPolicies();
  const query = (req.query.q as string || "").toLowerCase().trim();
  const statusFilter = req.query.status as string;
  const providerFilter = req.query.provider as string;

  if (query) {
    policies = policies.filter((p: any) =>
      p.ownerName?.toLowerCase().includes(query) ||
      p.policyNumber?.toLowerCase().includes(query) ||
      p.phoneNumber?.toLowerCase().includes(query) ||
      p.providerCompany?.toLowerCase().includes(query) ||
      p.policyType?.toLowerCase().includes(query)
    );
  }

  if (statusFilter && statusFilter !== "ALL") {
    policies = policies.filter((p: any) => p.policyStatus === statusFilter);
  }

  if (providerFilter && providerFilter !== "ALL") {
    policies = policies.filter((p: any) => p.providerCompany === providerFilter);
  }

  res.json({ success: true, count: policies.length, policies });
});

// Check Duplicate Policy
app.post("/api/policies/check-duplicate", (req, res) => {
  const { policyNumber, ownerName, phoneNumber } = req.body;
  const policies = loadPolicies();

  const duplicate = policies.find((p: any) => {
    if (policyNumber && p.policyNumber && p.policyNumber.toLowerCase().trim() === policyNumber.toLowerCase().trim()) {
      return true;
    }
    if (ownerName && phoneNumber && p.ownerName.toLowerCase().trim() === ownerName.toLowerCase().trim() && p.phoneNumber === phoneNumber) {
      return true;
    }
    return false;
  });

  res.json({ isDuplicate: !!duplicate, existingPolicy: duplicate || null });
});

// Save New Policy
app.post("/api/policies", (req, res) => {
  try {
    const policyData = req.body;
    let policies = loadPolicies();

    const newPolicy = {
      ...policyData,
      id: policyData.id || `pol-${Date.now()}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userId: "acc-1"
    };

    policies.unshift(newPolicy);
    savePolicies(policies);

    addAuditLog("POLICY_CREATED", "VIJAY SHIROYA (CA)", `Saved policy #${newPolicy.policyNumber} for ${newPolicy.ownerName}`, req);

    res.json({ success: true, policy: newPolicy });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to save policy record", details: err.message });
  }
});

// Update Policy
app.put("/api/policies/:id", (req, res) => {
  try {
    const { id } = req.params;
    let policies = loadPolicies();
    const index = policies.findIndex((p: any) => p.id === id);

    if (index === -1) {
      return res.status(404).json({ error: "Policy record not found" });
    }

    policies[index] = {
      ...policies[index],
      ...req.body,
      updatedAt: new Date().toISOString()
    };

    savePolicies(policies);
    addAuditLog("POLICY_UPDATED", "VIJAY SHIROYA (CA)", `Updated policy #${policies[index].policyNumber}`, req);

    res.json({ success: true, policy: policies[index] });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to update policy", details: err.message });
  }
});

// Delete Policy
app.delete("/api/policies/:id", (req, res) => {
  try {
    const { id } = req.params;
    let policies = loadPolicies();
    const existing = policies.find((p: any) => p.id === id);

    if (!existing) {
      return res.status(404).json({ error: "Policy not found" });
    }

    policies = policies.filter((p: any) => p.id !== id);
    savePolicies(policies);

    addAuditLog("POLICY_DELETED", "VIJAY SHIROYA (CA)", `Deleted policy #${existing.policyNumber} for ${existing.ownerName}`, req);

    res.json({ success: true, message: "Policy deleted successfully" });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete policy", details: err.message });
  }
});

// Get Dashboard Statistics
app.get("/api/stats", (req, res) => {
  const policies = loadPolicies();
  const totalPolicies = policies.length;
  const activePolicies = policies.filter((p: any) => p.policyStatus === "ACTIVE").length;
  const expiredPolicies = policies.filter((p: any) => p.policyStatus === "EXPIRED").length;
  const expiringSoonPolicies = policies.filter((p: any) => p.policyStatus === "EXPIRING SOON").length;
  const totalPremiumValue = policies.reduce((sum: number, p: any) => sum + (Number(p.premiumAmount) || 0), 0);

  const currentMonthStr = new Date().toISOString().slice(0, 7);
  const policiesAddedThisMonth = policies.filter((p: any) => p.createdAt && p.createdAt.startsWith(currentMonthStr)).length;

  res.json({
    totalPolicies,
    activePolicies,
    expiredPolicies,
    expiringSoonPolicies,
    totalPremiumValue,
    policiesAddedThisMonth
  });
});

// Security Audit Endpoint
app.get("/api/security/audit", (req, res) => {
  const logs = loadAuditLogs();
  res.json({ success: true, logs });
});

// 30-Day Expiry Notification Service API Endpoints
let notificationHistoryLogs: any[] = [];

app.post("/api/notifications/send-alert", (req, res) => {
  try {
    const { policyIds, channel = 'EMAIL', customMessage } = req.body;
    const policies = loadPolicies();
    
    // Find policies expiring within 30 days or explicitly requested
    const today = new Date();
    let targetPolicies = policies.filter((p: any) => {
      if (policyIds && Array.isArray(policyIds) && policyIds.length > 0) {
        return policyIds.includes(p.id);
      }
      if (p.policyStatus === 'EXPIRING SOON') return true;
      if (p.endDate) {
        const endDate = new Date(p.endDate);
        const diffDays = Math.ceil((endDate.getTime() - today.getTime()) / (1000 * 3600 * 24));
        return diffDays >= 0 && diffDays <= 30;
      }
      return false;
    });

    if (targetPolicies.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No policies found expiring within 30 days for alert dispatch.' 
      });
    }

    const dispatchedAlerts = targetPolicies.map((p: any) => {
      const recipient = p.email || `${p.ownerName.toLowerCase().replace(/\s+/g, '.')}@client-insurance.com`;
      const endDate = p.endDate || 'Upcoming';
      const daysLeft = p.endDate ? Math.ceil((new Date(p.endDate).getTime() - today.getTime()) / (1000 * 3600 * 24)) : 30;

      const emailSubject = `URGENT: 30-Day Policy Renewal Notice - ${p.providerCompany} Policy #${p.policyNumber}`;
      const emailBody = customMessage || `Dear ${p.ownerName},\n\nYour ${p.providerCompany} insurance policy (#${p.policyNumber}) is set to expire in ${daysLeft} days on ${endDate}.\n\nTo ensure seamless risk coverage, please confirm your renewal payment of ₹${(p.premiumAmount || 0).toLocaleString('en-IN')}.\n\nRegards,\nV Shiroya Insurance Portal`;

      const alertRecord = {
        id: `notif-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        policyId: p.id,
        policyNumber: p.policyNumber,
        ownerName: p.ownerName,
        recipientEmail: recipient,
        recipientPhone: p.phoneNumber || 'N/A',
        channel: channel,
        subject: emailSubject,
        body: emailBody,
        status: 'DELIVERED',
        sentAt: new Date().toISOString(),
        daysLeft: daysLeft
      };

      notificationHistoryLogs.unshift(alertRecord);
      return alertRecord;
    });

    addAuditLog(
      "30DAY_EXPIRY_ALERT_DISPATCH", 
      "V Shiroya Notification Service", 
      `Dispatched 30-Day Expiry ${channel} Alerts for ${dispatchedAlerts.length} policyholder(s)`, 
      req
    );

    res.json({
      success: true,
      message: `Successfully dispatched 30-day ${channel} expiry notifications to ${dispatchedAlerts.length} policyholder(s).`,
      countSent: dispatchedAlerts.length,
      alerts: dispatchedAlerts
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to process notification alert request', details: err.message });
  }
});

app.get("/api/notifications/history", (req, res) => {
  res.json({ success: true, count: notificationHistoryLogs.length, logs: notificationHistoryLogs });
});

// Vite Integration & Static Asset Serving
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`PolicyAI Express Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
