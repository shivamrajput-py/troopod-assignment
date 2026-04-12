import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_VLM = "google/gemini-3.1-flash-lite-preview";
const DEFAULT_LLM = "google/gemini-3.1-flash-lite-preview";

// ─── Helpers ────────────────────────────────────────
async function openrouterPost(payload: Record<string, unknown>) {
  const res = await fetch(OPENROUTER_BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://troopod-lp-personalizer.vercel.app",
      "X-Title": "Troopod AdPersonalizer",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

function safeParseLLMJson(raw: string): Record<string, unknown> {
  let text = raw.trim();
  if (text.startsWith("```")) {
    const lines = text.split("\n");
    if (lines[0].startsWith("```")) lines.shift();
    if (lines.length && lines[lines.length - 1].trim() === "```") lines.pop();
    text = lines.join("\n").trim();
  }
  try { return JSON.parse(text); } catch { /* */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* */ } }
  throw new Error(`Could not parse LLM JSON. Raw: ${text.slice(0, 200)}`);
}

// ─── Pipeline stages ────────────────────────────────
async function scrapeLandingPage(url: string) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`LP fetch failed: ${res.status}`);
  const html = await res.text();
  const parsedUrl = new URL(url);
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "";

  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim()).filter(Boolean).slice(0, 3);

  const h2s = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim()).filter(Boolean).slice(0, 5);

  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim());
  const heroParagraph = paras.find((p) => p.length > 40) || "";

  const metaMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
  const metaDescription = metaMatch ? metaMatch[1].trim() : "";

  const actionKw = ["get","start","try","buy","sign","join","book","free","demo","contact","learn"];
  const btnMatches = [...html.matchAll(/<(?:a|button)[^>]*>([\s\S]*?)<\/(?:a|button)>/gi)];
  const ctaButtons = btnMatches
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
    .filter((t) => t && t.length < 60 && actionKw.some((kw) => t.toLowerCase().includes(kw)))
    .filter((v, i, a) => a.indexOf(v) === i).slice(0, 5);

  return { title, h1: h1s, h2: h2s, hero_paragraph: heroParagraph, cta_buttons: ctaButtons, meta_description: metaDescription, base_url: baseUrl, raw_html: html };
}

async function analyzeAdCreative(imageB64?: string | null, imageUrl?: string | null, vlmModel = DEFAULT_VLM) {
  let imageContent: Record<string, unknown>;
  if (imageB64) {
    const src = imageB64.startsWith("data:") ? imageB64 : `data:image/jpeg;base64,${imageB64}`;
    imageContent = { type: "image_url", image_url: { url: src } };
  } else if (imageUrl) {
    imageContent = { type: "image_url", image_url: { url: imageUrl } };
  } else {
    throw new Error("Either image_b64 or image_url must be provided.");
  }

  const resp = await openrouterPost({
    model: vlmModel,
    messages: [
      { role: "system", content: "You are an expert advertising analyst. Analyze ad creatives and extract structured information. ALWAYS respond with valid JSON only — no markdown, no preamble." },
      { role: "user", content: [imageContent, { type: "text", text: "Analyze this ad image. Extract these fields as JSON: headline, sub_headline, offer, cta_text, target_pain_point, tone, target_audience, product_or_service, key_benefit, visual_style. Respond ONLY with a JSON object." }] },
    ],
  });
  return safeParseLLMJson(resp.choices[0].message.content as string);
}

async function generateReplacements(lpElements: Record<string, unknown>, adInsights: Record<string, unknown>, llmModel = DEFAULT_LLM) {
  const userPrompt = `Ad details:\n${JSON.stringify(adInsights, null, 2)}\n\nCurrent LP elements:\n- title: ${lpElements.title}\n- h1: ${JSON.stringify(lpElements.h1)}\n- h2: ${JSON.stringify(lpElements.h2)}\n- hero_paragraph: ${lpElements.hero_paragraph}\n- cta_buttons: ${JSON.stringify(lpElements.cta_buttons)}\n- meta_description: ${lpElements.meta_description}\n\nRewrite LP elements to match the ad message. Return ONLY a JSON object with: new_h1, new_h2, new_hero_paragraph, new_cta_primary, new_title, new_meta_description, changes_summary (array of short strings). No markdown fences.`;

  const resp = await openrouterPost({
    model: llmModel,
    messages: [
      { role: "system", content: "You are a CRO specialist. Return strict JSON only — no explanations, no markdown." },
      { role: "user", content: userPrompt },
    ],
  });
  return safeParseLLMJson(resp.choices[0].message.content as string);
}

// ─── Stitching ──────────────────────────────────────
// KEEP all scripts and CSS intact. Only modify text content and inject
// a CSS-only banner via <style> in <head> (zero DOM impact).
function applyReplacements(rawHtml: string, replacements: Record<string, unknown>, baseUrl: string): string {
  let html = rawHtml;

  // Add <base> tag for asset resolution
  if (!/<base\s/i.test(html)) {
    html = html.replace(/(<head[^>]*>)/i, `$1\n<base href="${baseUrl}/">`);
  }

  // Replace title (in <head>, safe)
  if (replacements.new_title) {
    html = html.replace(/(<title[^>]*>)([\s\S]*?)(<\/title>)/i, `$1${replacements.new_title}$3`);
  }
  // Replace meta description (in <head>, safe)
  if (replacements.new_meta_description) {
    html = html.replace(/(<meta[^>]*name=["']description["'][^>]*content=["'])([^"']*)/i, `$1${replacements.new_meta_description}`);
  }

  // Inject banner via CSS pseudo-element only — ZERO DOM changes
  const bannerStyle = `<style>body::before{content:"\\2726  Personalized by Troopod AI \\2014 Ad-matched Landing Page";display:block;background:linear-gradient(90deg,#6366f1,#a21caf);color:#fff;text-align:center;padding:10px 16px;font-size:13px;font-family:system-ui,sans-serif;position:sticky;top:0;z-index:99999;letter-spacing:.02em;font-weight:500}</style>`;
  html = html.replace(/(<\/head>)/i, `${bannerStyle}\n$1`);

  // Inject a DELAYED script that modifies text AFTER page fully loads + hydrates
  const textMods: Array<{s: string; t: string}> = [];
  if (replacements.new_h1) textMods.push({s: "h1", t: String(replacements.new_h1)});
  if (replacements.new_h2) textMods.push({s: "h2", t: String(replacements.new_h2)});
  if (replacements.new_hero_paragraph) textMods.push({s: "p_hero", t: String(replacements.new_hero_paragraph)});
  if (replacements.new_cta_primary) textMods.push({s: "cta", t: String(replacements.new_cta_primary)});

  const modsJson = JSON.stringify(textMods).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

  const modScript = `<script>
(function(){
  var mods=${modsJson};
  function go(){
    for(var i=0;i<mods.length;i++){
      var m=mods[i];
      try{
        if(m.s==='p_hero'){
          var ps=document.querySelectorAll('p');
          for(var j=0;j<ps.length;j++){if(ps[j].textContent.trim().length>30){ps[j].textContent=m.t;break;}}
        }else if(m.s==='cta'){
          var bs=document.querySelectorAll('a,button');
          var kw=['get','start','try','buy','sign','join','book','free','demo','contact','learn','analyse','analyze'];
          for(var j=0;j<bs.length;j++){var tx=bs[j].textContent.trim().toLowerCase();if(tx.length<60&&kw.some(function(k){return tx.indexOf(k)!==-1})){bs[j].textContent=m.t;break;}}
        }else{
          var el=document.querySelector(m.s);
          if(el)el.textContent=m.t;
        }
      }catch(e){}
    }
  }
  // Run after page is fully loaded + React hydrated
  function schedule(){setTimeout(go,3000);}
  if(document.readyState==='complete')schedule();
  else window.addEventListener('load',schedule);
})();
<\/script>`;

  if (/<\/body>/i.test(html)) {
    html = html.replace(/(<\/body>)/i, `${modScript}\n$1`);
  } else {
    html += modScript;
  }

  return html;
}

// ─── API Route Handler ──────────────────────────────
export async function POST(request: NextRequest) {
  try {
    const data = await request.json();
    const lpUrl = (data.lp_url || "").trim();
    const imageB64 = data.ad_image_b64 || null;
    const imageUrl = (data.ad_image_url || "").trim() || null;
    const vlmModel = (data.vlm_model || "").trim() || DEFAULT_VLM;
    const llmModel = (data.llm_model || "").trim() || DEFAULT_LLM;

    if (!lpUrl) return NextResponse.json({ error: "Missing lp_url" }, { status: 400 });
    if (!OPENROUTER_API_KEY) return NextResponse.json({ error: "OPENROUTER_API_KEY not configured." }, { status: 500 });

    // Step 1+2: Parallel
    const [lpResult, adResult] = await Promise.allSettled([
      scrapeLandingPage(lpUrl),
      analyzeAdCreative(imageB64, imageUrl, vlmModel),
    ]);

    if (lpResult.status === "rejected") return NextResponse.json({ error: `Failed to scrape LP: ${lpResult.reason}` }, { status: 500 });
    if (adResult.status === "rejected") return NextResponse.json({ error: `Failed to analyze ad: ${adResult.reason}` }, { status: 500 });

    const lpElements = lpResult.value;
    const adInsights = adResult.value;

    // Step 3: Generate
    let replacements: Record<string, unknown>;
    try {
      replacements = await generateReplacements(lpElements, adInsights, llmModel);
    } catch (e: unknown) {
      return NextResponse.json({ error: `Failed to generate replacements: ${e instanceof Error ? e.message : e}` }, { status: 500 });
    }

    // Step 4: Stitch — keep ALL scripts/CSS, only inject CSS banner + delayed text mod script
    const modifiedHtml = applyReplacements(lpElements.raw_html, replacements, lpElements.base_url);

    return NextResponse.json({
      modified_html: modifiedHtml,
      changes_summary: replacements.changes_summary || [],
      ad_insights: adInsights,
      lp_url: lpUrl,
      error: null,
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: `Unexpected server error: ${e instanceof Error ? e.message : e}` }, { status: 500 });
  }
}
