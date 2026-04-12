import { NextRequest, NextResponse } from "next/server";

// Allow up to 60 seconds for the full pipeline (scrape + 2 LLM calls + stitch)
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
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
  }
  throw new Error(`Could not parse LLM JSON. Raw: ${text.slice(0, 200)}`);
}

// ─── CSS Inlining ───────────────────────────────────
// Fetches all external stylesheets and inlines them as <style> tags.
// This ensures CSS survives even when we strip <script> tags.
async function inlineExternalCss(html: string, baseUrl: string): Promise<string> {
  const cssEntries: Array<{ fullMatch: string; url: string }> = [];

  // Match <link rel="stylesheet" href="..."> in both attribute orders
  const linkRegex = /<link[^>]*>/gi;
  let lm;
  while ((lm = linkRegex.exec(html)) !== null) {
    const tag = lm[0];
    if (!/rel\s*=\s*["']stylesheet["']/i.test(tag)) continue;
    const hrefMatch = tag.match(/href\s*=\s*["']([^"']+)["']/i);
    if (hrefMatch) {
      cssEntries.push({ fullMatch: tag, url: hrefMatch[1] });
    }
  }

  // Fetch each CSS file in parallel (with timeout)
  const fetches = cssEntries.map(async (entry) => {
    let absUrl = entry.url;
    if (absUrl.startsWith("//")) {
      absUrl = "https:" + absUrl;
    } else if (absUrl.startsWith("/")) {
      absUrl = baseUrl + absUrl;
    } else if (!absUrl.startsWith("http")) {
      absUrl = baseUrl + "/" + absUrl;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(absUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) return null;
      let css = await res.text();

      // Fix relative url() references inside CSS to be absolute
      css = css.replace(
        /url\(\s*['"]?(?!data:|https?:|\/\/)(\/?)([^'")\s]+)['"]?\s*\)/g,
        (_match, slash: string, path: string) =>
          `url(${baseUrl}${slash ? "/" : "/"}${path})`
      );

      return { fullMatch: entry.fullMatch, inlined: `<style>/* ${absUrl} */\n${css}</style>` };
    } catch {
      return null;
    }
  });

  const results = await Promise.all(fetches);
  for (const r of results) {
    if (r) {
      html = html.replace(r.fullMatch, r.inlined);
    }
  }

  return html;
}

// ─── Pipeline stages ────────────────────────────────

async function scrapeLandingPage(url: string) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`LP fetch failed: ${res.status}`);
  const html = await res.text();
  const parsedUrl = new URL(url);
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? titleMatch[1].replace(/<[^>]+>/g, "").trim()
    : "";

  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
    .filter(Boolean)
    .slice(0, 3);

  const h2s = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
    .filter(Boolean)
    .slice(0, 5);

  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim());
  const heroParagraph = paras.find((p) => p.length > 40) || "";

  const metaMatch =
    html.match(
      /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i
    ) ||
    html.match(
      /<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i
    );
  const metaDescription = metaMatch ? metaMatch[1].trim() : "";

  const actionKw = [
    "get","start","try","buy","sign","join","book","free","demo","contact","learn",
  ];
  const btnMatches = [
    ...html.matchAll(/<(?:a|button)[^>]*>([\s\S]*?)<\/(?:a|button)>/gi),
  ];
  const ctaButtons = btnMatches
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
    .filter(
      (t) => t && t.length < 60 && actionKw.some((kw) => t.toLowerCase().includes(kw))
    )
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 5);

  return {
    title,
    h1: h1s,
    h2: h2s,
    hero_paragraph: heroParagraph,
    cta_buttons: ctaButtons,
    meta_description: metaDescription,
    base_url: baseUrl,
    raw_html: html,
  };
}

async function analyzeAdCreative(
  imageB64?: string | null,
  imageUrl?: string | null,
  vlmModel = DEFAULT_VLM
) {
  let imageContent: Record<string, unknown>;
  if (imageB64) {
    const src = imageB64.startsWith("data:")
      ? imageB64
      : `data:image/jpeg;base64,${imageB64}`;
    imageContent = { type: "image_url", image_url: { url: src } };
  } else if (imageUrl) {
    imageContent = { type: "image_url", image_url: { url: imageUrl } };
  } else {
    throw new Error("Either image_b64 or image_url must be provided.");
  }

  const resp = await openrouterPost({
    model: vlmModel,
    messages: [
      {
        role: "system",
        content:
          "You are an expert advertising analyst. Analyze ad creatives and extract structured information. ALWAYS respond with valid JSON only — no markdown, no preamble.",
      },
      {
        role: "user",
        content: [
          imageContent,
          {
            type: "text",
            text: "Analyze this ad image. Extract these fields as JSON: headline, sub_headline, offer, cta_text, target_pain_point, tone, target_audience, product_or_service, key_benefit, visual_style. Respond ONLY with a JSON object.",
          },
        ],
      },
    ],
  });

  return safeParseLLMJson(
    resp.choices[0].message.content as string
  );
}

async function generateReplacements(
  lpElements: Record<string, unknown>,
  adInsights: Record<string, unknown>,
  llmModel = DEFAULT_LLM
) {
  const userPrompt = `Ad details:
${JSON.stringify(adInsights, null, 2)}

Current LP elements:
- title: ${lpElements.title}
- h1: ${JSON.stringify(lpElements.h1)}
- h2: ${JSON.stringify(lpElements.h2)}
- hero_paragraph: ${lpElements.hero_paragraph}
- cta_buttons: ${JSON.stringify(lpElements.cta_buttons)}
- meta_description: ${lpElements.meta_description}

Rewrite LP elements to match the ad message. Return ONLY a JSON object with: new_h1, new_h2, new_hero_paragraph, new_cta_primary, new_title, new_meta_description, changes_summary (array of short strings). No markdown fences.`;

  const resp = await openrouterPost({
    model: llmModel,
    messages: [
      {
        role: "system",
        content:
          "You are a CRO specialist. Return strict JSON only — no explanations, no markdown.",
      },
      { role: "user", content: userPrompt },
    ],
  });

  return safeParseLLMJson(
    resp.choices[0].message.content as string
  );
}

// ─── HTML Stitching ─────────────────────────────────
// Strategy:
//   1) Inline all external CSS (so styles survive without JS)
//   2) Strip all <script> tags (prevents SPA hydration from blanking the page)
//   3) Apply text replacements directly on the static HTML
//   4) Add <base> tag for remaining asset URLs (images, fonts)
//   5) Inject banner <div>
async function applyReplacements(
  rawHtml: string,
  replacements: Record<string, unknown>,
  baseUrl: string
): Promise<string> {
  let html = rawHtml;

  // ── STEP 1: Inline all external CSS ──
  // This fetches every <link rel="stylesheet"> and replaces it with <style>
  // so that CSS is preserved even after we strip <script> tags
  html = await inlineExternalCss(html, baseUrl);

  // Also inline any <style> tags that use @import
  // (some Next.js apps load CSS via @import in inline styles)

  // ── STEP 2: Strip ALL <script> tags ──
  // Modern SPAs (Next.js/React) hydrate on load. In a srcDoc iframe,
  // hydration fails and React WIPES the server-rendered DOM.
  // Removing scripts preserves the pre-rendered HTML + inlined CSS.
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<script[^>]*\/>/gi, ""); // self-closing scripts

  // ── STEP 3: Add <base> tag for remaining assets (images, fonts) ──
  if (!/<base\s/i.test(html)) {
    html = html.replace(
      /(<head[^>]*>)/i,
      `$1\n<base href="${baseUrl}/">`
    );
  }

  // ── STEP 4: Apply text replacements ──
  if (replacements.new_title) {
    html = html.replace(
      /(<title[^>]*>)([\s\S]*?)(<\/title>)/i,
      `$1${replacements.new_title}$3`
    );
  }
  if (replacements.new_meta_description) {
    html = html.replace(
      /(<meta[^>]*name=["']description["'][^>]*content=["'])([^"']*)/i,
      `$1${replacements.new_meta_description}`
    );
  }
  if (replacements.new_h1) {
    html = html.replace(
      /(<h1[^>]*>)([\s\S]*?)(<\/h1>)/i,
      `$1${replacements.new_h1}$3`
    );
  }
  if (replacements.new_h2) {
    html = html.replace(
      /(<h2[^>]*>)([\s\S]*?)(<\/h2>)/i,
      `$1${replacements.new_h2}$3`
    );
  }

  // Replace hero paragraph
  if (replacements.new_hero_paragraph) {
    let replaced = false;
    html = html.replace(
      /(<p[^>]*>)([\s\S]*?)(<\/p>)/gi,
      (match, open: string, content: string, close: string) => {
        if (!replaced && content.replace(/<[^>]+>/g, "").trim().length > 30) {
          replaced = true;
          return `${open}${replacements.new_hero_paragraph}${close}`;
        }
        return match;
      }
    );
  }

  // Replace CTA
  if (replacements.new_cta_primary) {
    const ctaKw = ["get","start","try","buy","sign","join","book","free","demo","contact","learn","analyse","analyze"];
    let replaced = false;
    html = html.replace(
      /(<(?:a|button)[^>]*>)([\s\S]*?)(<\/(?:a|button)>)/gi,
      (match, open: string, content: string, close: string) => {
        const text = content.replace(/<[^>]+>/g, "").trim();
        if (!replaced && text.length < 60 && ctaKw.some(kw => text.toLowerCase().includes(kw))) {
          replaced = true;
          return `${open}${replacements.new_cta_primary}${close}`;
        }
        return match;
      }
    );
  }

  // ── STEP 5: Inject banner ──
  const banner = `<div style="background:linear-gradient(90deg,#6366f1,#a21caf);color:white;text-align:center;padding:10px 16px;font-size:13px;font-family:system-ui,sans-serif;position:sticky;top:0;z-index:99999;letter-spacing:0.02em;font-weight:500;">&#10022; Personalized by <strong>Troopod AI</strong> &mdash; Ad-matched Landing Page</div>`;
  if (/<body[^>]*>/i.test(html)) {
    html = html.replace(/(<body[^>]*>)/i, `$1\n${banner}`);
  } else {
    html = banner + "\n" + html;
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

    if (!lpUrl) {
      return NextResponse.json({ error: "Missing lp_url" }, { status: 400 });
    }
    if (!OPENROUTER_API_KEY) {
      return NextResponse.json(
        { error: "OPENROUTER_API_KEY not configured. Add it in Vercel Dashboard > Settings > Environment Variables." },
        { status: 500 }
      );
    }

    // ── Step 1 + 2: Run LP scrape and Ad analysis IN PARALLEL ──
    const [lpResult, adResult] = await Promise.allSettled([
      scrapeLandingPage(lpUrl),
      analyzeAdCreative(imageB64, imageUrl, vlmModel),
    ]);

    if (lpResult.status === "rejected") {
      return NextResponse.json(
        { error: `Failed to scrape LP: ${lpResult.reason}` },
        { status: 500 }
      );
    }
    if (adResult.status === "rejected") {
      return NextResponse.json(
        { error: `Failed to analyze ad: ${adResult.reason}` },
        { status: 500 }
      );
    }

    const lpElements = lpResult.value;
    const adInsights = adResult.value;

    // ── Step 3: Generate replacements ──
    let replacements: Record<string, unknown>;
    try {
      replacements = await generateReplacements(lpElements, adInsights, llmModel);
    } catch (e: unknown) {
      return NextResponse.json(
        { error: `Failed to generate replacements: ${e instanceof Error ? e.message : e}` },
        { status: 500 }
      );
    }

    // ── Step 4: Apply replacements (includes CSS inlining + script stripping) ──
    let modifiedHtml: string;
    try {
      modifiedHtml = await applyReplacements(
        lpElements.raw_html,
        replacements,
        lpElements.base_url
      );
    } catch (e: unknown) {
      return NextResponse.json(
        { error: `Failed to apply replacements: ${e instanceof Error ? e.message : e}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      modified_html: modifiedHtml,
      changes_summary: replacements.changes_summary || [],
      ad_insights: adInsights,
      error: null,
    });
  } catch (e: unknown) {
    return NextResponse.json(
      {
        error: `Unexpected server error: ${e instanceof Error ? e.message : e}`,
      },
      { status: 500 }
    );
  }
}
