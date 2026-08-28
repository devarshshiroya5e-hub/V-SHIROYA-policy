import { useEffect, useMemo, useState } from "react";

type Result = Record<string, any>;
type ItemResult = { id: string; fileName: string; extraction?: Result; error?: string; status: "queued" | "analyzing" | "done" | "error" };
const fields = [["Policy holder","ownerName"],["Policy number","policyNumber"],["Insurer","providerCompany"],["Policy type","policyType"],["Category","category"],["Start date","startDate"],["End date","endDate"],["Premium","premiumAmount"],["Frequency","premiumFrequency"],["Sum assured","sumAssured"],["Insured person","insuredPerson"],["Nominee","nominee"],["Nominee relation","nomineeRelationship"],["Phone","phoneNumber"],["Email","email"],["Address","address"],["DOB","dateOfBirth"],["Agent","agentName"],["Agent phone","agentPhone"],["Branch","branchName"],["Payment mode","paymentMode"],["Maturity","maturityDate"]] as const;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const ACCEPTED = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").trim().replace(/\/$/, "");
const apiUrl = (path: string) => `${API_BASE}${path}`;
const instruction = "Extract every policy detail, coverage, premium, nominee, dates, riders, endorsements, insured assets, limits, deductibles, exclusions and important clauses. Never guess missing values. Analyze every page.";

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Could not read the selected file."));
    r.readAsDataURL(file);
  });
}

function displayValue(value: any) {
  if (value === null || value === undefined || String(value).trim() === "") return "Not available";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [items, setItems] = useState<ItemResult[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [health, setHealth] = useState<any>(null);

  useEffect(() => {
    fetch(apiUrl("/api/health"))
      .then(async r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(setHealth)
      .catch(() => setHealth({ configured: false, backendOffline: true }));
  }, []);

  function choose(next: FileList | null) {
    setError("");
    if (!next?.length) return;
    const incoming = Array.from(next);
    const invalid = incoming.find(f => !ACCEPTED.has(f.type) || f.size > MAX_FILE_BYTES);
    if (invalid) {
      setError(`${invalid.name}: unsupported type or file is larger than 100 MB.`);
      return;
    }
    const merged = [...files];
    for (const f of incoming) if (!merged.some(x => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified)) merged.push(f);
    setFiles(merged);
    setItems(merged.map((f, i) => ({ id: `${f.name}-${f.size}-${f.lastModified}-${i}`, fileName: f.name, status: "queued" })));
    setSelected(null);
  }

  function removeFile(id: string) {
    const index = items.findIndex(x => x.id === id);
    if (index < 0) return;
    const next = files.filter((_, i) => i !== index);
    setFiles(next);
    setItems(next.map((f, i) => ({ id: `${f.name}-${f.size}-${f.lastModified}-${i}`, fileName: f.name, status: "queued" })));
    setSelected(null);
  }

  async function analyzeOne(file: File, id: string) {
    setItems(prev => prev.map(x => x.id === id ? { ...x, status: "analyzing", error: undefined } : x));
    try {
      const data = await fileToDataUrl(file);
      const r = await fetch(apiUrl("/api/analyze-policy"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileData: data, fileName: file.name, mimeType: file.type || "application/pdf", instruction })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.details || d.error || `Analysis failed (${r.status})`);
      if (!d.extraction) throw new Error("AI returned no extraction result.");
      setItems(prev => prev.map(x => x.id === id ? { ...x, status: "done", extraction: d.extraction } : x));
      return true;
    } catch (e: any) {
      setItems(prev => prev.map(x => x.id === id ? { ...x, status: "error", error: e?.message || "Analysis failed" } : x));
      return false;
    }
  }

  async function analyzeAll() {
    if (!files.length || busy) return;
    setBusy(true); setError(""); setSelected(null);
    const startItems = files.map((f, i) => ({ id: `${f.name}-${f.size}-${f.lastModified}-${i}`, fileName: f.name, status: "queued" as const }));
    setItems(startItems);
    let cursor = 0;
    const worker = async () => { while (true) { const index = cursor++; if (index >= files.length) return; await analyzeOne(files[index], startItems[index].id); } };
    await Promise.all([worker(), worker()]);
    setBusy(false);
  }

  const doneCount = items.filter(x => x.status === "done").length;
  const errorCount = items.filter(x => x.status === "error").length;
  const active = useMemo(() => items.find(x => x.id === selected) || items.find(x => x.status === "done"), [items, selected]);
  const result = active?.extraction;

  return <div className="app">
    <header><div><b>V SHIROYA <span>POLICY AI</span></b><small>Insurance document intelligence & audit</small></div><label className={health?.configured ? "ready" : "notready"}>● {health?.configured ? `AI ready · ${health.configuredKeyCount || 1} key(s)` : health?.backendOffline ? "Backend offline" : "AI key not configured"}</label></header>
    <main>
      <section className="hero"><div><small>MULTIMODAL POLICY ANALYZER</small><h1>Turn policy documents into <em>actionable intelligence.</em></h1><p>Upload one or many PDFs or policy images. Each uploaded file gets its own independent result.</p></div><aside>{health?.models?.[0] || "NVIDIA / OpenRouter"}<small>Active AI model</small></aside></section>
      <div className="workspace">
        <section className="panel">
          <div className="title"><h2>01 · Upload documents</h2><label>Choose files<input type="file" multiple accept="application/pdf,image/png,image/jpeg,image/webp" onChange={e => choose(e.target.files)} /></label></div>
          <div className="drop">↑<strong>{files.length ? `${files.length} document${files.length === 1 ? "" : "s"} selected` : "Drop your policies here"}</strong><small>PDF, PNG, JPG or WEBP · up to 100 MB each · bulk upload supported</small></div>
          {files.length > 0 && <div className="file-list">{files.map((f, i) => { const item = items[i]; return <div className="file-row" key={item?.id || `${f.name}-${i}`}><span>{i + 1}. {f.name}</span><small>{item?.status === "done" ? "✓ Done" : item?.status === "analyzing" ? "Analyzing…" : item?.status === "error" ? "✕ Error" : "Queued"}</small><button type="button" onClick={() => removeFile(item?.id || "")} disabled={busy}>×</button></div>; })}</div>}
          <button disabled={!files.length || busy} onClick={analyzeAll}>{busy ? `Analyzing ${doneCount + errorCount}/${files.length}…` : `Analyze ${files.length || ""} polic${files.length === 1 ? "y" : "ies"} →`}</button>
          {error && <div className="error">{error}</div>}
          <p className="note">Results are kept separate by filename. A failed document does not remove other results.</p>
        </section>
        <section className="panel">
          <div className="title"><h2>02 · Analysis results</h2>{items.length > 0 && <label className="status">{doneCount}/{items.length} complete</label>}</div>
          {items.length > 0 && <div className="result-tabs">{items.map((item, i) => <button type="button" key={item.id} className={active?.id === item.id ? "active" : ""} onClick={() => setSelected(item.id)}>{i + 1}. {item.fileName}{item.status === "done" ? " ✓" : item.status === "error" ? " ✕" : item.status === "analyzing" ? " …" : ""}</button>)}</div>}
          {!active && !busy && <div className="empty"><b>✦</b><h3>Waiting for documents</h3><p>Upload policies and start analysis.</p></div>}
          {active?.status === "analyzing" && <div className="empty"><b>✦</b><h3>Reading {active.fileName}…</h3><p>PDF text extraction, page OCR and structured field extraction are running.</p></div>}
          {active?.status === "error" && <div className="error">{active.error || "This document could not be analyzed."}</div>}
          {result && <div>
            <div className="confidence"><b>{result.confidence ?? 0}%</b><span>AI confidence · {active?.fileName}</span></div>
            <div className="grid">{fields.map(([l,k]) => <div className="field" key={k}><small>{l}</small><strong>{displayValue(result[k])}</strong></div>)}</div>
            <h3>Additional details</h3>
            {Array.isArray(result.additionalDetails) && result.additionalDetails.length > 0 ? result.additionalDetails.map((x: any, i: number) => <div className="detail" key={i}><b>{displayValue(x?.label)}</b><span>{displayValue(x?.value)}</span></div>) : <div className="detail"><b>No additional details extracted</b><span>The document did not provide extra fields outside the named schema, or the model could not verify them.</span></div>}
            {Array.isArray(result.uncertainFields) && result.uncertainFields.length > 0 && <><h3>Needs verification</h3><div className="detail"><b>Uncertain fields</b><span>{result.uncertainFields.join(", ")}</span></div></>}
            {Array.isArray(result.missingFields) && result.missingFields.length > 0 && <details><summary>Fields not found in document</summary><pre>{result.missingFields.join("\n")}</pre></details>}
            <details><summary>Extracted text</summary><pre>{result.extractedText || "No extracted text returned."}</pre></details>
          </div>}
        </section>
      </div>
    </main>
    <footer>V Shiroya Policy AI · Server-side multimodal analysis · {files.length ? `${doneCount} results for ${files.length} uploads` : "Ready"}</footer>
  </div>;
}
