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

function applyReplacements(
  rawHtml: string,
  replacements: Record<string, unknown>,
  baseUrl: string
) {
  let html = rawHtml;

  // Fix relative URLs for assets
  html = html.replace(
    /(<(?:link|script|img|source|video|audio)[^>]*\s(?:href|src)=["'])(\/)/gi,
    (_match: string, pre: string) => `${pre}${baseUrl}/`
  );

  // Add <base> tag so all relative URLs resolve correctly
  if (!/<base\s/i.test(html)) {
    html = html.replace(
      /(<head[^>]*>)/i,
      `$1\n<base href="${baseUrl}/">`
    );
  }

  // Replace <title> and meta in <head> — safe, doesn't affect React root
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

  // ── NON-INVASIVE INJECTION ──
  // We do NOT modify DOM elements directly because that breaks React/Next.js
  // hydration (causes blank hero sections). Instead we inject:
  // 1) CSS ::before pseudo-element for the banner (zero DOM impact)
  // 2) A post-load <script> that modifies text AFTER React hydration completes

  const bannerCSS = `
    body::before {
      content: "\\2726  Personalized by Troopod AI \\2014 Ad-matched Landing Page";
      display: block;
      background: linear-gradient(90deg, #6366f1, #a21caf);
      color: white;
      text-align: center;
      padding: 10px 16px;
      font-size: 13px;
      font-family: system-ui, -apple-system, sans-serif;
      position: sticky;
      top: 0;
      z-index: 99999;
      letter-spacing: 0.02em;
      font-weight: 500;
    }
  `;

  // Build post-hydration replacement entries
  const textReplacements: Array<{ selector: string; text: string }> = [];
  if (replacements.new_h1) {
    textReplacements.push({ selector: "h1", text: String(replacements.new_h1) });
  }
  if (replacements.new_h2) {
    textReplacements.push({ selector: "h2", text: String(replacements.new_h2) });
  }
  if (replacements.new_hero_paragraph) {
    textReplacements.push({ selector: "__hero_p__", text: String(replacements.new_hero_paragraph) });
  }
  if (replacements.new_cta_primary) {
    textReplacements.push({ selector: "__cta__", text: String(replacements.new_cta_primary) });
  }

  const replacementsJson = JSON.stringify(textReplacements).replace(/</g, "\\u003c");

  const injectionScript = `
    <script>
      (function() {
        function applyChanges() {
          var reps = ${replacementsJson};
          for (var i = 0; i < reps.length; i++) {
            var r = reps[i];
            try {
              if (r.selector === '__hero_p__') {
                var ps = document.querySelectorAll('p');
                for (var j = 0; j < ps.length; j++) {
                  if (ps[j].textContent.trim().length > 30) {
                    ps[j].textContent = r.text;
                    break;
                  }
                }
              } else if (r.selector === '__cta__') {
                var btns = document.querySelectorAll('a, button');
                var kw = ['get','start','try','buy','sign','join','book','free','demo','contact','learn','analyse','analyze'];
                for (var j = 0; j < btns.length; j++) {
                  var txt = btns[j].textContent.trim().toLowerCase();
                  if (txt.length < 60 && kw.some(function(k) { return txt.indexOf(k) !== -1; })) {
                    btns[j].textContent = r.text;
                    break;
                  }
                }
              } else {
                var el = document.querySelector(r.selector);
                if (el) el.textContent = r.text;
              }
            } catch(e) { /* skip failed replacement */ }
          }
        }
        // Wait for React hydration to finish before modifying text
        if (document.readyState === 'complete') {
          setTimeout(applyChanges, 2000);
        } else {
          window.addEventListener('load', function() {
            setTimeout(applyChanges, 2000);
          });
        }
      })();
    </script>
  `;

  // Inject CSS into <head> — no DOM change, banner via pseudo-element
  html = html.replace(
    /(<\/head>)/i,
    `<style>${bannerCSS}</style>\n$1`
  );

  // Inject script before </body> — runs after hydration
  if (/<\/body>/i.test(html)) {
    html = html.replace(/(<\/body>)/i, `${injectionScript}\n$1`);
  } else {
    html += injectionScript;
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

    // ── Step 4: Apply replacements (instant, no network call) ──
    let modifiedHtml: string;
    try {
      modifiedHtml = applyReplacements(
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
