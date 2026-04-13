"use client";

import { useState, useRef, useEffect } from "react";

type AppState = "idle" | "processing" | "success" | "error";

interface PipelineStep {
  id: string;
  label: string;
  description: string;
  status: "pending" | "active" | "done" | "error";
}

interface ChangeRecord {
  element: string;
  original: string | null;
  updated: string;
}

interface AdData {
  headline?: string;
  offer?: string;
  tone?: string;
  target_audience?: string;
  key_promise?: string;
}

interface ApiResult {
  modified_html: string;
  changes_summary: ChangeRecord[];
  ad_insights: AdData;
  error?: string;
}

const INITIAL_STEPS: PipelineStep[] = [
  {
    id: "fetch_lp",
    label: "Loading Landing Page",
    description: "Fetching target URL and diagnosing SPA rendering requirements",
    status: "pending",
  },
  {
    id: "ad_analyzer",
    label: "Analyzing Ad Creative",
    description: "Extracting messaging, tone, offer, and target audience",
    status: "pending",
  },
  {
    id: "hero_extractor",
    label: "Extracting Hero Section",
    description: "Surgically isolating the above-the-fold hero content",
    status: "pending",
  },
  {
    id: "hero_enhance",
    label: "Enhancing Copy",
    description: "Aligning text based on CRO principles",
    status: "pending",
  },
  {
    id: "stitch",
    label: "Stitching & Validating",
    description: "Re-inserting enhanced block into inert HTML and structural validation",
    status: "pending",
  },
  {
    id: "finalize",
    label: "Finalizing Output",
    description: "Preparing live preview rendering",
    status: "pending",
  },
];

function StepIcon({ status }: { status: PipelineStep["status"] }) {
  if (status === "done") {
    return (
      <div className="flex items-center justify-center w-6 h-6 rounded-full bg-white text-black">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 13l4 4L19 7" />
        </svg>
      </div>
    );
  }
  if (status === "active") {
    return (
      <div className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-800 border border-gray-600">
        <div className="w-2.5 h-2.5 rounded-full bg-white animate-pulse" />
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="flex items-center justify-center w-6 h-6 rounded-full bg-red-900 border border-red-500 text-white">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </div>
    );
  }
  return <div className="flex items-center justify-center w-6 h-6 rounded-full bg-black border border-gray-700" />;
}

function PipelineProgress({ steps }: { steps: PipelineStep[] }) {
  return (
    <div className="space-y-4">
      {steps.map((step, i) => (
        <div key={step.id} className="relative flex gap-4 overflow-hidden">
          {i < steps.length - 1 && (
            <div className={`absolute left-3 top-6 bottom-[-1rem] w-[1px] ${step.status === "done" ? "bg-gray-400" : "bg-gray-800"}`} />
          )}
          <div className="z-10 mt-1">
            <StepIcon status={step.status} />
          </div>
          <div className={`flex-1 ${step.status === "pending" ? "opacity-40" : "opacity-100"} transition-opacity duration-300`}>
            <div className="text-sm font-medium text-white tracking-wide">{step.label}</div>
            <div className="text-xs text-gray-500 mt-0.5">{step.description}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Home() {
  const [appState, setAppState] = useState<AppState>("idle");
  const [adMode, setAdMode] = useState<"url" | "upload">("upload");
  const [adUrl, setAdUrl] = useState("");
  const [adFile, setAdFile] = useState<File | null>(null);
  const [adBase64, setAdBase64] = useState<string | null>(null); // For preview only
  const [lpUrl, setLpUrl] = useState("");
  const [vlmModel, setVlmModel] = useState("google/gemini-3.1-flash-lite-preview");
  const [llmModel, setLlmModel] = useState("google/gemini-3.1-flash-lite-preview");
  const [result, setResult] = useState<ApiResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [steps, setSteps] = useState<PipelineStep[]>(INITIAL_STEPS);
  const [elapsedTime, setElapsedTime] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [previewReady, setPreviewReady] = useState(false);

  useEffect(() => {
    if (result?.modified_html && formRef.current) {
      setPreviewReady(false);
      setTimeout(() => {
        formRef.current?.submit();
        setPreviewReady(true);
      }, 100);
    }
  }, [result?.modified_html]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAdFile(file);
    const reader = new FileReader();
    reader.onload = (event) => setAdBase64(event.target?.result as string);
    reader.readAsDataURL(file);
  };

  const isFormValid = () => {
    if (!lpUrl.trim()) return false;
    if (adMode === "url" && !adUrl.trim()) return false;
    if (adMode === "upload" && !adFile) return false;
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid()) return;

    setAppState("processing");
    setErrorMsg("");
    setResult(null);
    setSteps(INITIAL_STEPS.map((s) => ({ ...s, status: "pending" as const })));
    setElapsedTime(0);

    const startTime = Date.now();
    timerRef.current = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    try {
      const formData = new FormData();
      formData.append("lp_url", lpUrl.trim());
      formData.append("vlm_model", vlmModel.trim());
      formData.append("llm_model", llmModel.trim());
      
      if (adMode === "url") {
        formData.append("ad_url", adUrl.trim());
      } else if (adFile) {
        formData.append("ad_image", adFile);
      }

      const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";
      const res = await fetch(`${BACKEND_URL}/api/personalize`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Server Error (${res.status}): ${txt}`);
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error("No readable stream from server");

      let finalData = null;
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        
        let newlineIdx;
        while ((newlineIdx = buffer.indexOf('\n\n')) >= 0) {
          const eventString = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 2);
          
          if (eventString.startsWith('data: ')) {
            const dataStr = eventString.slice(6).trim();
            if (!dataStr) continue;
            try {
              const data = JSON.parse(dataStr);
              if (data.status === 'error') {
                // We set the state and stop the stream immediately
                setErrorMsg(data.message || "Pipeline error");
                setAppState("error");
                setSteps(prev => prev.map(s => s.status === "active" ? { ...s, status: "error" as const } : s));
                return; // Exit the submit handler early
              }
              if (data.step) {
                setSteps(prev => {
                   const next = [...prev];
                   const stepIdx = next.findIndex(s => s.id === data.step);
                   if (stepIdx !== -1) {
                        for(let i=0; i<stepIdx; i++) if(next[i].status !== "error") next[i].status = "done";
                        next[stepIdx].status = "active";
                   }
                   return next;
                });
              }
              if (data.status === 'success') {
                finalData = data;
              }
            } catch (e) {
                console.error("Non-JSON or malformed SSE data:", e);
            }
          }
        }
      }

      if (!finalData) throw new Error("Stream ended without reaching final output");

      setSteps((prev) => prev.map((s) => ({ ...s, status: "done" as const })));
      await new Promise((r) => setTimeout(r, 600));

      setResult({
          modified_html: finalData.personalizedHtml,
          changes_summary: finalData.changeSummary || [],
          ad_insights: finalData.adData || {}
      });
      setAppState("success");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "An unexpected error occurred.";
      setErrorMsg(message);
      setSteps((prev) =>
        prev.map((s) => (s.status === "active" ? { ...s, status: "error" as const } : s))
      );
      setAppState("error");
    } finally {
      if (timerRef.current) clearInterval(timerRef.current);
    }
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };

  return (
    <div className="flex flex-col items-center justify-start min-h-screen pt-16 pb-16 px-4 bg-black text-gray-200 selection:bg-white selection:text-black font-sans">
      
      {/* Header */}
      <div className="text-center mb-16 max-w-xl mx-auto space-y-4">
        <h1 className="text-4xl md:text-5xl font-semibold tracking-tight text-white mb-4">
          Ad<span className="opacity-40">Personalizer</span>
        </h1>
        <p className="text-gray-500 text-sm md:text-base leading-relaxed max-w-md mx-auto">
          Synchronize landing page hero sections with advertising intent. Slick, robust, inert static previews.
        </p>
        
        <div className="text-gray-400 text-xs md:text-sm max-w-lg mx-auto mt-6 p-4 border border-gray-800 bg-[#0a0a0a] text-left space-y-2">
            <p>
              <span className="text-gray-500 mr-2">⚡</span> 
              Using a better and fast model gives better output.
            </p>
            <p>
              <span className="text-gray-500 mr-2">🌐</span> 
              Works with most of the websites, but faces challenges with websites having complex DOM.
            </p>
            <p>
              <span className="text-gray-500 mr-2">📖</span> 
              <a href="https://docs.google.com/document/d/1_y5762-6zBniegmQniDITzSuIG48m0rWlkaEAfAmY_M/edit?usp=sharing" target="_blank" rel="noreferrer" className="text-gray-300 hover:text-white underline underline-offset-4 decoration-gray-700 hover:decoration-white transition-colors">
                Get the idea of the architecture
              </a>
            </p>
        </div>
      </div>

      {/* ─── Processing State ─── */}
      {appState === "processing" && (
        <div className="w-full max-w-md animate-fade-in mb-10">
          <div className="p-8 rounded-none border border-gray-800 bg-[#0a0a0a]">
            <div className="flex items-center justify-between mb-8 pb-4 border-b border-gray-800">
              <h2 className="text-white text-sm font-semibold uppercase tracking-wider">Processing</h2>
              <span className="text-xs text-gray-500 font-mono">{formatTime(elapsedTime)} logs</span>
            </div>
            <PipelineProgress steps={steps} />
          </div>
        </div>
      )}

      {/* ─── Input Form ─── */}
      {(appState === "idle" || appState === "error") && (
        <form
          onSubmit={handleSubmit}
          className="w-full max-w-xl transition-all duration-300"
        >
          <div className="space-y-6">
            
            <div className="p-6 border border-gray-800 bg-[#0a0a0a]">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-white">I. Ad Creative</h2>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setAdMode("url")} className={`px-2 py-1 text-xs uppercase tracking-widest ${adMode === "url" ? "text-white border-b border-white" : "text-gray-600 hover:text-gray-400"}`}>Link</button>
                  <button type="button" onClick={() => setAdMode("upload")} className={`px-2 py-1 text-xs uppercase tracking-widest ${adMode === "upload" ? "text-white border-b border-white" : "text-gray-600 hover:text-gray-400"}`}>File</button>
                </div>
              </div>
              
              {adMode === "url" ? (
                <input
                  type="url"
                  placeholder="https://..."
                  className="w-full bg-black border border-gray-800 text-white px-4 py-3 text-sm focus:outline-none focus:border-gray-500 transition-colors"
                  value={adUrl}
                  onChange={(e) => setAdUrl(e.target.value)}
                />
              ) : (
                <div className="relative">
                  <label className="flex flex-col items-center justify-center w-full h-24 border border-dashed border-gray-700 bg-black cursor-pointer hover:border-gray-500 transition-colors">
                    <span className="text-xs text-gray-400 uppercase tracking-widest">{adFile ? adFile.name : "Select Image"}</span>
                    <input type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
                  </label>
                </div>
              )}
            </div>

            <div className="p-6 border border-gray-800 bg-[#0a0a0a]">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-white mb-4">II. Landing Page</h2>
              <input
                type="url"
                placeholder="https://..."
                className="w-full bg-black border border-gray-800 text-white px-4 py-3 text-sm focus:outline-none focus:border-gray-500 transition-colors"
                value={lpUrl}
                onChange={(e) => setLpUrl(e.target.value)}
              />
            </div>

            <div className="p-6 border border-gray-800 bg-[#0a0a0a]">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-white mb-4">III. Models</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs uppercase tracking-widest text-gray-600 mb-2">Vision</label>
                  <input type="text" className="w-full bg-black border border-gray-800 text-white px-3 py-2 text-xs focus:outline-none focus:border-gray-500" value={vlmModel} onChange={(e) => setVlmModel(e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs uppercase tracking-widest text-gray-600 mb-2">Text</label>
                  <input type="text" className="w-full bg-black border border-gray-800 text-white px-3 py-2 text-xs focus:outline-none focus:border-gray-500" value={llmModel} onChange={(e) => setLlmModel(e.target.value)} />
                </div>
              </div>
            </div>
          </div>

          {errorMsg && (
            <div className="mt-6 p-4 border border-gray-800 bg-black text-red-400 text-sm flex gap-3 items-start">
              <span className="font-mono text-xs uppercase pt-0.5">ERR</span>
              <p className="text-gray-400">{errorMsg}</p>
            </div>
          )}

          <div className="mt-8">
            <button type="submit" disabled={!isFormValid()} className="w-full bg-white text-black py-4 text-sm font-semibold uppercase tracking-widest hover:bg-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              Initialize
            </button>
          </div>
        </form>
      )}

      {/* ─── Result Area ─── */}
      {appState === "success" && result && (
        <div className="w-full max-w-[1600px] animate-fade-in font-sans">
          
          <div className="flex items-center justify-between mb-8 pb-4 border-b border-gray-800 text-white">
             <div className="text-sm uppercase tracking-widest opacity-50">{lpUrl}</div>
             <button onClick={() => { setAppState("idle"); setResult(null); setErrorMsg(""); setPreviewReady(false); }} className="text-xs uppercase tracking-widest hover:opacity-70 transition-opacity">
               [ Reset ]
             </button>
          </div>

          <div className="flex flex-col lg:flex-row gap-6 mb-8">
            <div className="flex-1 p-6 border border-gray-800 bg-[#0a0a0a]">
              <h3 className="text-sm uppercase tracking-wider text-white mb-6">Execution Signal</h3>
              <div className="grid grid-cols-2 gap-4 text-sm text-gray-400">
                {result.ad_insights.headline && <div className="col-span-2"><span className="uppercase text-xs opacity-50 block mb-1">Headline</span><span className="text-white">{result.ad_insights.headline}</span></div>}
                {result.ad_insights.offer && <div><span className="uppercase text-xs opacity-50 block mb-1">Offer</span><span className="text-white">{result.ad_insights.offer}</span></div>}
                {result.ad_insights.tone && <div><span className="uppercase text-xs opacity-50 block mb-1">Tone</span><span className="text-white capitalize">{result.ad_insights.tone}</span></div>}
              </div>
            </div>

            <div className="flex-1 p-6 border border-gray-800 bg-[#0a0a0a]">
              <h3 className="text-sm uppercase tracking-wider text-white mb-6">DOM Modifications</h3>
              <ul className="space-y-3 text-sm text-gray-400">
                {result.changes_summary.map((change, i) => (
                  <li key={i} className="flex flex-col">
                    <span className="uppercase text-xs opacity-50 mb-1">{change.element}</span>
                    <span className="text-white">{change.updated}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <form ref={formRef} method="POST" action="/api/preview" target="preview-frame" style={{ display: "none" }}>
            <textarea name="html" value={result.modified_html} readOnly />
          </form>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="flex flex-col w-full h-[75vh] border border-gray-800 bg-[#0a0a0a]">
               <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
                  <span className="text-xs uppercase tracking-widest text-gray-500">Original Architecture</span>
               </div>
               <iframe src={lpUrl} className="w-full h-full bg-white" title="Original" />
            </div>

            <div className="flex flex-col w-full h-[75vh] border border-gray-500 bg-[#0a0a0a] relative">
               <div className="px-4 py-3 border-b border-gray-500 flex items-center justify-between">
                  <span className="text-xs uppercase tracking-widest text-white">Enhanced Protocol</span>
               </div>
               {!previewReady && (
                 <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm z-10">
                   <div className="text-xs uppercase tracking-widest text-gray-400 animate-pulse">Rendering Inert Artifact...</div>
                 </div>
               )}
               <iframe name="preview-frame" className="w-full h-full bg-white" title="Personalized" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
