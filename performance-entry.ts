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
function requestBody(init?: RequestInit): Record<string, any> | null { if (typeof init?.body !== "string") return null; try { const parsed = JSON.parse(init.body); return isObject(parsed) ? parsed : null; } catch { return null; } }
function messages(body: Record<string, any>): any[] { return Array.isArray(body.messages) ? body.messages : []; }
function hasPart(body: Record<string, any>, type: string): boolean { return messages(body).some((m:any)=>Array.isArray(m?.content)&&m.content.some((p:any)=>p?.type===type)); }
function hasImageInput(body: Record<string, any>): boolean { return hasPart(body,"image_url"); }
function hasPdfInput(body: Record<string, any>): boolean { return hasPart(body,"file"); }
function cachedSnapshot(response: Response): Promise<CachedResponse> { return response.text().then(body=>({status:response.status,headers:[...response.headers.entries()],body,expiresAt:Date.now()+CACHE_TTL_MS})); }
function responseFromSnapshot(snapshot: CachedResponse): Response { return new Response(snapshot.body,{status:snapshot.status,headers:snapshot.headers}); }
function pruneCache(){const now=Date.now();for(const[k,v]of responseCache)if(v.expiresAt<=now)responseCache.delete(k);while(responseCache.size>CACHE_MAX_ENTRIES){const first=responseCache.keys().next().value as string|undefined;if(!first)break;responseCache.delete(first);}}
function cacheKey(body: Record<string, any>): string|null{if(!hasPdfInput(body))return null;const hash=createHash("sha256");hash.update(String(body.model||""));for(const m of messages(body)){hash.update(String(m?.role||""));for(const p of Array.isArray(m?.content)?m.content:[]){if(p?.type==="file")hash.update(String(p?.file?.file_data||p?.file_data||""));else if(p?.type==="text")hash.update(String(p?.text||""));}}return hash.digest("hex");}
function contentText(data:any): string { const c=data?.choices?.[0]?.message?.content; return typeof c === "string" ? c : Array.isArray(c) ? c.map((p:any)=>p?.text||"").join("\n") : ""; }
function parseJsonText(text:string): any|null { try{return JSON.parse(String(text||"").replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"").trim());}catch{const s=String(text||"");const a=s.indexOf("{");const b=s.lastIndexOf("}");try{return a>=0&&b>a?JSON.parse(s.slice(a,b+1)):null;}catch{return null;}} }
function amount(value:any): any { if(value===null||value===undefined||value==="") return null; if(typeof value==="number") return Number.isFinite(value)?value:null; const s=String(value).replace(/[^0-9.]/g,""); const n=Number(s); return Number.isFinite(n)&&s?n:null; }
function normalizeExtraction(result:any): any {
  const out=isObject(result)?{...result}:{};
  const aliases:Record<string,string[]>= {
    maturityDate:["maturity_date","maturity","dateOfMaturity","date_of_maturity","maturityBenefitDate","maturityDateOfPolicy"],
    sumAssured:["sum_assured","sumInsured","sum_insured","assuredAmount","insuredAmount","totalSumAssured","baseSumAssured","assuredSum"],
    premiumAmount:["premium","premium_amount","totalPremium","total_premium","annualPremium","annual_premium","installmentPremium"],
    startDate:["start_date","effectiveDate","effective_date","policyStartDate","riskStartDate"],
    endDate:["end_date","expiryDate","expiry_date","policyEndDate","riskEndDate"]
  };
  for(const [canonical,keys] of Object.entries(aliases)) if(out[canonical]===null||out[canonical]===undefined||String(out[canonical]).trim()==="") for(const key of keys) if(out[key]!==null&&out[key]!==undefined&&String(out[key]).trim()!==""){out[canonical]=out[key];break;}
  out.premiumAmount=amount(out.premiumAmount);
  out.sumAssured=amount(out.sumAssured);
  const evidence=[String(out.extractedText||""),...(Array.isArray(out.additionalDetails)?out.additionalDetails.map((x:any)=>`${x?.label||""}: ${x?.value||""}`):[])].join("\n");
  const findDate=(labels:string[])=>{const re=new RegExp(`(?:${labels.join("|")})[^\\dA-Za-z]{0,40}(\\d{1,2}[-/.](?:[A-Za-z]{3,9}|\\d{1,2})[-/.]\\d{2,4}|\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2})`,`i`);return evidence.match(re)?.[1]||null;};
  const findAmount=(labels:string[])=>{const re=new RegExp(`(?:${labels.join("|")})[^\\d]{0,40}(?:₹|Rs\\.?|INR|)?\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)`,`i`);const m=evidence.match(re);return m?.[1]?amount(m[1]):null;};
  if(!out.maturityDate) out.maturityDate=findDate(["maturity date","date of maturity","maturity"])||null;
  if(out.sumAssured===null) out.sumAssured=findAmount(["sum assured","sum insured","assured amount","insured amount","total sum assured"]);
  if(out.premiumAmount===null) out.premiumAmount=findAmount(["premium amount","premium","total premium","annual premium","installment premium"]);
  if(!Array.isArray(out.uncertainFields)) out.uncertainFields=[];
  return out;
}
function missingCritical(result:any): string[]{ const checks:[string,any][]=[["maturityDate",result?.maturityDate],["sumAssured",result?.sumAssured],["premiumAmount",result?.premiumAmount]]; return checks.filter(([,v])=>v===null||v===undefined||String(v).trim()==="").map(([k])=>k); }
function recoveryBody(body:Record<string,any>,missing:string[]):Record<string,any>{const copy=JSON.parse(JSON.stringify(body));const user=messages(copy).find((m:any)=>m.role==="user");if(user&&Array.isArray(user.content)){const part=user.content.find((p:any)=>p?.type==="text");const extra=`\n\nRECOVERY PASS: The first extraction may have omitted fields. Re-read the COMPLETE PDF and explicitly locate these fields: ${missing.join(", ")}. Keep every field already found, but fill any missing values only from document evidence. Separate PREMIUM AMOUNT from SUM ASSURED/SUM INSURED. Search schedule, benefit table, maturity/term section, declarations, endorsements and continuation pages. Return the complete JSON schema, not a partial answer.`;if(part)part.text=String(part.text||"")+extra;else user.content.push({type:"text",text:extra});}return copy;}

// Route OCR to the vision-capable model and final text extraction to the faster text model.
globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=typeof input==="string"?input:input instanceof URL?input.toString():input.url;if(!url.startsWith(NVIDIA_URL)||typeof init?.body!=="string")return nativeFetch(input,init);const body=requestBody(init);if(!body)return nativeFetch(input,init);const rewritten={...body};if(hasImageInput(rewritten)){rewritten.model=NVIDIA_OCR_MODEL;rewritten.max_tokens=NVIDIA_OCR_MAX_TOKENS;}else{rewritten.model=NVIDIA_FINAL_MODEL;rewritten.max_tokens=NVIDIA_FINAL_MAX_TOKENS;rewritten.chat_template_kwargs={...(isObject(rewritten.chat_template_kwargs)?rewritten.chat_template_kwargs:{}),enable_thinking:false};}return nativeFetch(input,{...init,body:JSON.stringify(rewritten)});}) as typeof globalThis.fetch;

void (async()=>{
  await import("./nvidia-fetch-bridge.ts");
  const bridgeFetch=globalThis.fetch.bind(globalThis);
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=typeof input==="string"?input:input instanceof URL?input.toString():input.url;
    if(!url.startsWith(OPENROUTER_URL)) return bridgeFetch(input,init);
    const body=requestBody(init); if(!body) return bridgeFetch(input,init);
    const key=cacheKey(body); pruneCache();
    if(key){const hit=responseCache.get(key);if(hit&&hit.expiresAt>Date.now())return responseFromSnapshot(hit);if(hit)responseCache.delete(key);const pending=inFlight.get(key);if(pending)return responseFromSnapshot(await pending);}
    const work=(async()=>{
      let response=await bridgeFetch(input,init); if(!response.ok)return await cachedSnapshot(response);
      const raw=await response.text(); let envelope:any; try{envelope=JSON.parse(raw);}catch{return {status:response.status,headers:[...response.headers.entries()],body:raw,expiresAt:Date.now()+CACHE_TTL_MS};}
      const original=parseJsonText(contentText(envelope)); if(!original){return {status:response.status,headers:[...response.headers.entries()],body:raw,expiresAt:Date.now()+CACHE_TTL_MS};}
      let extraction=normalizeExtraction(original); const missing=missingCritical(extraction);
      if(missing.length>0){
        try{
          const retry=await bridgeFetch(OPENROUTER_URL,{...init,body:JSON.stringify(recoveryBody(body,missing))});
          if(retry.ok){const retryRaw=await retry.text();const retryEnv=JSON.parse(retryRaw);const repaired=normalizeExtraction(parseJsonText(contentText(retryEnv))||{});for(const field of missing)if(repaired[field]!==null&&repaired[field]!==undefined&&String(repaired[field]).trim()!=="")extraction[field]=repaired[field];if(Array.isArray(repaired.additionalDetails)){const existing=Array.isArray(extraction.additionalDetails)?extraction.additionalDetails:[];const seen=new Set(existing.map((x:any)=>`${x?.label||""}|${x?.value||""}`));for(const x of repaired.additionalDetails){const k=`${x?.label||""}|${x?.value||""}`;if(!seen.has(k)){existing.push(x);seen.add(k);}}extraction.additionalDetails=existing.slice(0,100);}}
        }catch(error){console.warn("Policy field recovery pass failed; keeping primary extraction:",error instanceof Error?error.message:error);}
      }
      envelope.choices=envelope.choices||[]; envelope.choices[0]=envelope.choices[0]||{message:{}}; envelope.choices[0].message=envelope.choices[0].message||{}; envelope.choices[0].message.content=JSON.stringify(extraction);
      return {status:response.status,headers:[...response.headers.entries()],body:JSON.stringify(envelope),expiresAt:Date.now()+CACHE_TTL_MS};
    })().finally(()=>{if(key)inFlight.delete(key);});
    if(key)inFlight.set(key,work);
    const snapshot=await work; if(key&&snapshot.status>=200&&snapshot.status<300){responseCache.set(key,snapshot);pruneCache();}return responseFromSnapshot(snapshot);
  }) as typeof globalThis.fetch;
  await import("./server.ts");
})().catch(error=>{console.error("Failed to start V-SHIROYA optimized backend:",error);process.exit(1);});
