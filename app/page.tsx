"use client";

import { useState, useCallback } from "react";

type AppState = "idle" | "processing" | "success" | "error";

interface ApiResult {
  modified_html: string;
  changes_summary: string[];
  ad_insights: Record<string, string>;
  replacements_applied: Record<string, string>;
  error?: string;
}

export default function Home() {
  const [appState, setAppState] = useState<AppState>("idle");
  const [adMode, setAdMode] = useState<"url" | "upload">("url");
  const [adUrl, setAdUrl] = useState("");
  const [adBase64, setAdBase64] = useState<string | null>(null);
  const [lpUrl, setLpUrl] = useState("");
  
  const [vlmModel, setVlmModel] = useState("qwen/qwen3.6-plus");
  const [llmModel, setLlmModel] = useState("qwen/qwen3.6-plus");
  
  const [result, setResult] = useState<ApiResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      setAdBase64(event.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  const isFormValid = () => {
    if (!lpUrl.trim()) return false;
    if (adMode === "url" && !adUrl.trim()) return false;
    if (adMode === "upload" && !adBase64) return false;
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid()) return;

    setAppState("processing");
    setErrorMsg("");
    setResult(null);

    try {
      const payload: Record<string, any> = { 
        lp_url: lpUrl.trim(),
        vlm_model: vlmModel.trim() || undefined,
        llm_model: llmModel.trim() || undefined,
      };
      if (adMode === "url") {
        payload.ad_image_url = adUrl.trim();
      } else {
        payload.ad_image_b64 = adBase64;
      }

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      
      if (!res.ok || data.error) {
        throw new Error(data.error || `Server error: ${res.status}`);
      }

      setResult(data);
      setAppState("success");
    } catch (err: any) {
      setErrorMsg(err.message || "An unexpected error occurred.");
      setAppState("error");
    }
  };

  return (
    <div className="flex flex-col items-center justify-start min-h-screen pt-20 pb-16 px-4">
      {/* Header */}
      <div className="text-center mb-12 max-w-2xl mx-auto space-y-4">
        <div className="inline-flex items-center gap-3 px-4 py-2 rounded-full bg-white/5 border border-white/10 mb-4 animate-fade-in text-sm font-medium">
          <span className="flex h-2 w-2 rounded-full bg-indigo-500 animate-pulse"></span>
          AI-Powered Personalization
        </div>
        <h1 className="text-5xl md:text-6xl font-display font-bold tracking-tight">
          Ad<span className="text-gradient">Personalizer</span>
        </h1>
        <p className="text-gray-400 text-lg md:text-xl">
          Instantly reshape your landing page to match the exact messaging and tone of your ad creative.
        </p>
      </div>

      {/* Main Form Area */}
      {(appState === "idle" || appState === "processing" || appState === "error") && (
        <form 
          onSubmit={handleSubmit}
          className={`glass-card rounded-3xl p-8 w-full max-w-3xl transition-all duration-300 ${
            appState === "processing" ? "opacity-50 pointer-events-none scale-[0.98]" : "opacity-100"
          }`}
        >
          <div className="space-y-8">
            
            {/* Step 1: Ad Creative */}
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold">1. Ad Creative</h2>
                <div className="flex gap-2 p-1 bg-black/40 rounded-lg border border-white/5">
                  <button
                    type="button"
                    onClick={() => setAdMode("url")}
                    className={`px-3 py-1.5 text-sm rounded-md transition-all ${adMode === "url" ? "bg-white/10 text-white" : "text-gray-400 hover:text-white"}`}
                  >
                    Image URL
                  </button>
                  <button
                    type="button"
                    onClick={() => setAdMode("upload")}
                    className={`px-3 py-1.5 text-sm rounded-md transition-all ${adMode === "upload" ? "bg-white/10 text-white" : "text-gray-400 hover:text-white"}`}
                  >
                    Upload File
                  </button>
                </div>
              </div>
              
              {adMode === "url" ? (
                <input
                  type="url"
                  placeholder="https://example.com/ad-image.jpg"
                  className="glass-input w-full"
                  value={adUrl}
                  onChange={(e) => setAdUrl(e.target.value)}
                />
              ) : (
                <div className="flex items-center justify-center w-full">
                  <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-xl cursor-pointer border-gray-600 bg-black/20 hover:bg-black/40 hover:border-indigo-500/50 transition-all">
                    <div className="flex flex-col items-center justify-center pt-5 pb-6">
                      <svg className="w-8 h-8 mb-3 text-gray-400" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 20 16">
                        <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 13h3a3 3 0 0 0 0-6h-.025A5.56 5.56 0 0 0 16 6.5 5.5 5.5 0 0 0 5.207 5.021C5.137 5.017 5.071 5 5 5a4 4 0 0 0 0 8h2.167M10 15V6m0 0L8 8m2-2 2 2"/>
                      </svg>
                      <p className="mb-2 text-sm text-gray-400"><span className="font-semibold text-white">Click to upload</span> or drag and drop</p>
                    </div>
                    <input type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
                  </label>
                </div>
              )}
              {adMode === "upload" && adBase64 && (
                <div className="mt-3 text-sm text-green-400 flex items-center gap-2">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                  Image uploaded successfully
                </div>
              )}
            </div>

            {/* Step 2: LP URL */}
            <div>
              <h2 className="text-xl font-semibold mb-4">2. Destination Landing Page URL</h2>
              <input
                type="url"
                placeholder="https://yourwebsite.com"
                className="glass-input w-full"
                value={lpUrl}
                onChange={(e) => setLpUrl(e.target.value)}
              />
            </div>

            {/* Step 3: Model Config */}
            <div>
              <h2 className="text-xl font-semibold mb-4">3. AI Configuration</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">VLM Model (Ad Vision)</label>
                  <input
                    type="text"
                    className="glass-input w-full"
                    value={vlmModel}
                    onChange={(e) => setVlmModel(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">LLM Model (Text Output)</label>
                  <input
                    type="text"
                    className="glass-input w-full"
                    value={llmModel}
                    onChange={(e) => setLlmModel(e.target.value)}
                  />
                </div>
              </div>
            </div>

          </div>

          {errorMsg && (
            <div className="mt-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex gap-3 items-start">
               <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
               {errorMsg}
            </div>
          )}

          <div className="mt-10 flex justify-center">
            <button
              type="submit"
              disabled={!isFormValid() || appState === "processing"}
              className="btn-primary w-full md:w-auto min-w-[240px] flex items-center justify-center gap-3"
            >
              {appState === "processing" ? (
                <>
                  <div className="spinner"></div>
                  <span>Analyzing Context...</span>
                </>
              ) : (
                <>
                  ✦ Personalize Page
                </>
              )}
            </button>
          </div>
        </form>
      )}

      {/* Result Area */}
      {appState === "success" && result && (
        <div className="w-full max-w-[1400px] animate-fade-in slide-up">
          
          <div className="flex flex-col lg:flex-row gap-6 mb-8">
            <div className="glass-card flex-1 rounded-2xl p-6 border-indigo-500/30">
               <h3 className="text-lg font-semibold text-indigo-400 mb-4 flex items-center gap-2">
                 <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                 Ad Insights Extracted
               </h3>
               <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <div><span className="text-gray-500 block mb-1">Detected Offer:</span> <span className="font-medium">{result.ad_insights.offer}</span></div>
                  <div><span className="text-gray-500 block mb-1">Tone:</span> <span className="font-medium capitalize">{result.ad_insights.tone}</span></div>
                  <div className="col-span-2"><span className="text-gray-500 block mb-1">Key Benefit:</span> <span className="font-medium">{result.ad_insights.key_benefit}</span></div>
               </div>
            </div>
            
            <div className="glass-card flex-1 rounded-2xl p-6 border-fuchsia-500/30">
               <h3 className="text-lg font-semibold text-fuchsia-400 mb-4 flex items-center gap-2">
                 <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                 Surgical Changes Applied
               </h3>
               <ul className="space-y-2 text-sm">
                  {result.changes_summary?.map((change, i) => (
                    <li key={i} className="flex gap-2 items-start">
                      <span className="text-fuchsia-400 mt-0.5">✦</span> 
                      <span className="text-gray-200">{change}</span>
                    </li>
                  ))}
               </ul>
            </div>
          </div>

          <div className="flex items-center justify-between mb-4">
             <h2 className="text-2xl font-display font-semibold">Personalized Live Preview</h2>
             <button onClick={() => setAppState("idle")} className="btn-secondary text-sm py-2">
               ← New Generation
             </button>
          </div>

          <div className="w-full rounded-2xl overflow-hidden glass-card border-white/20 shadow-2xl relative" style={{ height: "75vh" }}>
            <div className="absolute top-0 left-0 w-full h-8 bg-gray-900 border-b border-white/10 flex items-center px-4 gap-2">
               <div className="w-3 h-3 rounded-full bg-red-500"></div>
               <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
               <div className="w-3 h-3 rounded-full bg-green-500"></div>
               <div className="mx-auto flex-1 text-center text-xs text-gray-500 font-mono overflow-hidden whitespace-nowrap text-ellipsis px-10">
                 {lpUrl} — Modified
               </div>
            </div>
            <iframe
              srcDoc={result.modified_html}
              sandbox="allow-scripts allow-same-origin allow-popups"
              className="w-full h-full bg-white mt-8"
              title="Personalized Result"
            />
          </div>
        </div>
      )}

    </div>
  );
}
