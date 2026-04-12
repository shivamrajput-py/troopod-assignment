# Troopod AdPersonalizer — System Design Document

> **Submission for:** AI PM Assignment – Troopod  
> **Author:** Shivam Rajput  
> **Live Demo:** [troopod-assignment.vercel.app](https://troopod-assignment.vercel.app)  
> **Repository:** [github.com/shivamrajput-py/troopod-assignment](https://github.com/shivamrajput-py/troopod-assignment)

---

## 1. What This System Does

The AdPersonalizer takes two inputs from a user:

1. **An ad creative** (uploaded image or image URL)
2. **A landing page URL**

It then outputs a **personalized version of that landing page** — where the hero section copy (headline, subheadline, CTA, meta description) has been surgically rewritten to match the ad's messaging, tone, and offer. The original page layout, styling, and structure remain completely intact.

---

## 2. How The System Works (Flow)

The pipeline runs in **four sequential stages**, each visible to the user in real time:

```
┌──────────────────────────────────────────────────────────┐
│  USER INPUT                                              │
│  • Ad creative (image upload / URL)                      │
│  • Landing page URL                                      │
│  • Model selection (VLM + LLM)                           │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────┐
│  STEP 1 — Scrape Landing Page                            │
│  Fetch the raw HTML of the target URL. Extract:          │
│  H1, H2, hero paragraph, CTA buttons, meta description, │
│  page title. Store original HTML for later stitching.    │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────┐
│  STEP 2 — Analyze Ad Creative (VLM)                      │
│  Send the ad image to a Vision Language Model via        │
│  OpenRouter. Extract: headline, offer, CTA text, tone,  │
│  target audience, key benefit, pain point.               │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────┐
│  STEP 3 — Generate CRO Replacements (LLM)               │
│  Feed both the LP elements and ad insights to the LLM.  │
│  It produces a structured JSON mapping:                  │
│  { new_h1, new_h2, new_hero_paragraph, new_cta_primary, │
│    new_title, new_meta_description, changes_summary }    │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────┐
│  STEP 4 — Surgical HTML Stitching                        │
│  Take the ORIGINAL raw HTML. Apply text-only regex       │
│  replacements for H1, H2, title, meta desc. Inject a    │
│  "Personalized by Troopod AI" banner. Fix relative URLs. │
│  Return the modified HTML to the frontend.               │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────┐
│  OUTPUT                                                  │
│  • Live iframe preview of the personalized page          │
│  • Ad insights summary card                              │
│  • List of surgical changes applied                      │
└──────────────────────────────────────────────────────────┘
```

---

## 3. Key Components / Agent Design

| Component | Technology | Role |
|---|---|---|
| **Frontend** | Next.js (React) + Tailwind CSS | Input form, real-time pipeline tracker, result preview with iframe |
| **API Route** | Next.js API Route (`/api/analyze`) | Orchestrates the full pipeline in a single serverless function |
| **VLM Agent** | OpenRouter → GPT-4o-mini (vision) | Analyzes ad creative images to extract structured advertising insights |
| **CRO Agent** | OpenRouter → GPT-4o-mini (text) | Rewrites LP copy to match ad messaging using CRO principles |
| **HTML Stitcher** | Regex-based text replacement | Surgically replaces text nodes in original HTML, preserving DOM structure |
| **Deployment** | Vercel (Serverless) | Zero-config deployment with env variable management |

**Agent Design Philosophy:**  
The agents are **not** given free-form creative control. Each agent has a tightly scoped role:
- The VLM agent extracts facts (JSON schema enforced)
- The CRO agent outputs a fixed-schema replacement map (JSON schema enforced)
- Neither agent ever generates or modifies HTML structure

---

## 4. Architectural Iterations & Challenges

We went through multiple approaches before arriving at the current architecture. Each taught us something critical about the problem space.

### Approach 1: Full HTML Scrape + LLM Hero Rewrite

**How it worked:** We scraped the full raw HTML of the landing page, used BeautifulSoup to parse out the hero section, sent that raw HTML block to the LLM, and asked it to return a modified HTML block. We then stitched the modified block back into the original DOM.

**Problems encountered:**
- **Broken UI / Malformed HTML:** The LLM frequently dropped CSS classes, omitted `data-*` attributes, broke Tailwind utility classes, and produced unclosed tags. Even small structural changes cascaded into completely broken layouts.
- **Client-side rendered content missing:** Many modern landing pages (React, Next.js, Vue) load content via JavaScript after the initial HTML. Our static `requests.get()` fetch returned empty `<div id="root"></div>` shells with no actual content to work with.
- **Unpredictable scope:** Giving the LLM raw HTML meant it could change anything — adding random elements, removing existing ones, or "improving" things we didn't ask it to touch.

### Approach 2: Content-Only Extraction via Jina Reader

**How it worked:** Instead of giving HTML to the LLM, we used Jina Reader to extract clean text content. The LLM worked purely as a copywriter, outputting `original_text → replacement_text` mappings. We then did string replacements on the original HTML.

**Problems encountered:**
- **Fuzzy text matching:** The text extracted by Jina didn't always match the raw HTML exactly (whitespace differences, HTML entities, text split across nested tags). This caused replacement misses.
- **Extra dependency:** Adding Jina Reader introduced another external service dependency and latency.

### Approach 3: Post-Render JavaScript Injection

**How it worked:** We explored generating a JavaScript snippet that would run after the original page fully loaded in the browser, find elements by selectors, and replace their text content on the fly.

**Problems encountered:**
- **Selector fragility:** Auto-generated CSS selectors were brittle — they broke when pages had dynamic class names (CSS modules, styled-components).
- **Timing complexity:** Ensuring the script ran after hydration but before the user sees the page was unreliable.

### Current Approach: Structured Element Extraction + Surgical Regex Stitching

**How it works (our solution):** We extract structured elements (H1s, H2s, CTAs, paragraphs) from the raw HTML using targeted regex. The LLM receives only this structured text, never raw HTML. It returns a fixed JSON schema of replacements. We apply these as text-node-only regex replacements on the original HTML, never touching tag structure, attributes, or CSS.

**Why it works:**
- The LLM has **zero access to** and **zero impact on** HTML structure
- Regex replacements target the first matching tag's text content only
- Original CSS classes, data attributes, and nested structures are preserved
- The `<base>` tag and URL fixups ensure assets load correctly in the iframe

---

## 5. How We Handle Edge Cases

### Broken UI

**Problem:** Any AI modification to HTML structure risks breaking the page layout.

**Solution:** The LLM never generates or modifies HTML. It only outputs plain text replacements (new headline, new paragraph, new CTA text). Our stitching layer applies these as text-content-only substitutions within existing tags, preserving every CSS class, attribute, and DOM structure. This makes structural breakage architecturally impossible.

### Hallucinations

**Problem:** The LLM might fabricate offers, features, or claims not present in the ad.

**Solution:** We ground the LLM by providing it with the exact extracted ad insights (headline, offer, tone, benefit) and instruct it to work only within those boundaries. The system prompt explicitly constrains: "Match the ad tone, don't invent new claims." Additionally, we enforce strict JSON schema output — if the LLM produces anything outside the expected keys, the JSON parser rejects it and the system fails safely rather than injecting hallucinated content.

### Inconsistent Outputs

**Problem:** LLMs can return different formats across calls — sometimes markdown, sometimes JSON with extra keys, sometimes plain text.

**Solution:** We enforce structured JSON output through:
1. System prompt: "Respond with valid JSON only — no markdown, no preamble"
2. Multi-layer JSON parser: strips markdown fences → tries `JSON.parse` → regex extracts first `{...}` block → tries again
3. If all parsing fails, the pipeline returns a clean error rather than passing garbage downstream

### Random / Unwanted Changes

**Problem:** The LLM might modify elements outside the hero section (footer, navbar, legal text).

**Solution:** The scope is architecturally restricted. We only extract and replace:
- First `<h1>` tag
- First `<h2>` tag  
- `<title>` tag
- Meta description
- (Future: first matching CTA button)

The stitching code uses `count=1` on all regex replacements, ensuring only the first match is modified. Footer text, navigation, legal disclaimers, and other page sections are never touched because the replacement logic doesn't target them.

---

## 6. Tech Stack Summary

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, Tailwind CSS 4 |
| API | Next.js API Routes (serverless) |
| AI Models | OpenRouter (GPT-4o-mini for vision + text) |
| HTML Processing | Regex-based surgical text replacement |
| Deployment | Vercel (auto-deploy from GitHub) |
| Fonts | Inter + Outfit (Google Fonts) |

---

## 7. What's Shown in the UI

1. **Input form** — Upload ad creative + enter landing page URL + select AI models
2. **Live pipeline tracker** — Real-time step-by-step progress:
   - Step 1: Scraping Landing Page
   - Step 2: Analyzing Ad Creative  
   - Step 3: Generating CRO Replacements
   - Step 4: Stitching Modified Page
3. **Results dashboard** — Ad insights extracted + list of surgical changes applied
4. **Live preview** — Full iframe render of the personalized landing page with a "Personalized by Troopod AI" banner

---

## 8. Assumptions Made

- We focus on the **hero section** (above-the-fold content) since that's where message match has the highest conversion impact
- The landing page must be **server-rendered** (returns meaningful HTML from a GET request). Fully client-rendered SPAs (empty HTML shell) are acknowledged as a limitation
- **OpenRouter** is used as the model gateway for flexible model selection
- The personalized page is a **preview** rendered in an iframe; it is not deployed as a persistent URL
