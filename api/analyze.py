from http.server import BaseHTTPRequestHandler
import json
import os
import re
import traceback
import urllib.request
import urllib.error

# ────────────────────────────────────────────────
# Config
# ────────────────────────────────────────────────
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions"

# Safe, widely-available OpenRouter models
DEFAULT_VLM = "openai/gpt-4o-mini"   # vision + cheap
DEFAULT_LLM = "openai/gpt-4o-mini"   # text + cheap


# ────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────
def _openrouter_post(payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        OPENROUTER_BASE,
        data=body,
        headers={
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://troopod-assignment.vercel.app",
            "X-Title": "Troopod AdPersonalizer",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=55) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _safe_parse_json(raw: str) -> dict:
    raw = raw.strip()
    # Strip markdown fences
    if raw.startswith("```"):
        lines = raw.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        raw = "\n".join(lines).strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    match = re.search(r'\{[\s\S]*\}', raw)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass
    raise ValueError(f"Could not parse LLM JSON. Raw: {raw[:300]}")


def scrape_landing_page(url: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            )
        },
    )
    from urllib.parse import urlparse
    parsed = urlparse(url)
    base_url = f"{parsed.scheme}://{parsed.netloc}"

    with urllib.request.urlopen(req, timeout=20) as resp:
        html = resp.read().decode("utf-8", errors="replace")

    # Simple regex-based extraction (no beautifulsoup on Vercel to keep bundle small)
    title_m = re.search(r'<title[^>]*>(.*?)</title>', html, re.IGNORECASE | re.DOTALL)
    title = re.sub(r'<[^>]+>', '', title_m.group(1)).strip() if title_m else ""

    h1s = [re.sub(r'<[^>]+>', '', m).strip()
           for m in re.findall(r'<h1[^>]*>(.*?)</h1>', html, re.IGNORECASE | re.DOTALL)][:3]
    h2s = [re.sub(r'<[^>]+>', '', m).strip()
           for m in re.findall(r'<h2[^>]*>(.*?)</h2>', html, re.IGNORECASE | re.DOTALL)][:5]

    paras = re.findall(r'<p[^>]*>(.*?)</p>', html, re.IGNORECASE | re.DOTALL)
    hero_paragraph = ""
    for p in paras:
        text = re.sub(r'<[^>]+>', '', p).strip()
        if len(text) > 40:
            hero_paragraph = text
            break

    meta_m = re.search(r'<meta[^>]*name=["\']description["\'][^>]*content=["\']([^"\']*)["\']', html, re.IGNORECASE)
    if not meta_m:
        meta_m = re.search(r'<meta[^>]*content=["\']([^"\']*)["\'][^>]*name=["\']description["\']', html, re.IGNORECASE)
    meta_description = meta_m.group(1).strip() if meta_m else ""

    action_kw = ["get", "start", "try", "buy", "sign", "join", "book", "free", "demo", "contact", "learn"]
    raw_btns = re.findall(r'<(?:a|button)[^>]*>(.*?)</(?:a|button)>', html, re.IGNORECASE | re.DOTALL)
    cta_buttons = []
    for b in raw_btns:
        text = re.sub(r'<[^>]+>', '', b).strip()
        if text and len(text) < 60 and any(kw in text.lower() for kw in action_kw):
            cta_buttons.append(text)
    cta_buttons = list(dict.fromkeys(cta_buttons))[:5]

    return {
        "title": title,
        "h1": h1s,
        "h2": h2s,
        "hero_paragraph": hero_paragraph,
        "cta_buttons": cta_buttons,
        "meta_description": meta_description,
        "base_url": base_url,
        "raw_html": html,
    }


def analyze_ad_creative(image_b64: str = None, image_url: str = None, vlm_model: str = DEFAULT_VLM) -> dict:
    if image_b64:
        if not image_b64.startswith("data:"):
            image_b64 = f"data:image/jpeg;base64,{image_b64}"
        image_content = {"type": "image_url", "image_url": {"url": image_b64}}
    elif image_url:
        image_content = {"type": "image_url", "image_url": {"url": image_url}}
    else:
        raise ValueError("Either image_b64 or image_url must be provided.")

    payload = {
        "model": vlm_model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are an expert advertising analyst. "
                    "Analyze ad creatives and extract structured information. "
                    "ALWAYS respond with valid JSON only — no markdown, no preamble."
                ),
            },
            {
                "role": "user",
                "content": [
                    image_content,
                    {
                        "type": "text",
                        "text": (
                            "Analyze this ad image. Extract these fields as JSON: "
                            "headline, sub_headline, offer, cta_text, target_pain_point, "
                            "tone, target_audience, product_or_service, key_benefit, visual_style. "
                            "Respond ONLY with a JSON object."
                        ),
                    },
                ],
            },
        ],
    }
    resp = _openrouter_post(payload)
    return _safe_parse_json(resp["choices"][0]["message"]["content"])


def generate_replacements(lp_elements: dict, ad_insights: dict, llm_model: str = DEFAULT_LLM) -> dict:
    user_prompt = (
        f"Ad details:\n{json.dumps(ad_insights, indent=2)}\n\n"
        f"Current LP elements:\n"
        f"- title: {lp_elements.get('title', '')}\n"
        f"- h1: {lp_elements.get('h1', [])}\n"
        f"- h2: {lp_elements.get('h2', [])}\n"
        f"- hero_paragraph: {lp_elements.get('hero_paragraph', '')}\n"
        f"- cta_buttons: {lp_elements.get('cta_buttons', [])}\n"
        f"- meta_description: {lp_elements.get('meta_description', '')}\n\n"
        "Rewrite LP elements to match the ad message. "
        "Return ONLY a JSON object with these keys: "
        "new_h1, new_h2, new_hero_paragraph, new_cta_primary, new_title, new_meta_description, "
        "changes_summary (array of short strings describing each change). "
        "Keep tone consistent with the ad. No markdown fences."
    )
    payload = {
        "model": llm_model,
        "messages": [
            {
                "role": "system",
                "content": "You are a CRO specialist. Return strict JSON only — no explanations, no markdown.",
            },
            {"role": "user", "content": user_prompt},
        ],
    }
    resp = _openrouter_post(payload)
    return _safe_parse_json(resp["choices"][0]["message"]["content"])


def apply_replacements(raw_html: str, replacements: dict, base_url: str) -> str:
    # Fix relative URLs for assets so the iframe renders correctly
    def fix_url(match):
        tag_open = match.group(1)
        attr = match.group(2)
        val = match.group(3)
        quote = match.group(4)
        if val.startswith("http") or val.startswith("//") or val.startswith("data:"):
            return match.group(0)
        if val.startswith("//"):
            val = "https:" + val
        elif val.startswith("/"):
            val = base_url + val
        return f"{tag_open}{attr}={quote}{val}{quote}"

    html = re.sub(
        r'(<(?:link|script|img|source)[^>]*\s)((?:href|src)=)(["\']?)([^"\'>\s]+)(["\']?)',
        lambda m: (
            m.group(1) + m.group(2) + m.group(3) +
            (
                "https:" + m.group(4) if m.group(4).startswith("//") else
                base_url + m.group(4) if m.group(4).startswith("/") and not m.group(4).startswith("//") else
                m.group(4)
            ) + m.group(5)
        ),
        raw_html,
    )

    # Add base tag so relative links resolve properly
    if "<base" not in html.lower():
        html = html.replace("<head>", f'<head>\n<base href="{base_url}/">', 1)
        if "<head>" not in html.lower():
            html = f'<base href="{base_url}/">\n' + html

    # Surgical text replacement: only replace text content, preserve all tags
    def replace_first_tag_text(pattern: str, new_text: str, html_str: str) -> str:
        """Replace the inner text of the FIRST matching tag, preserving all attributes."""
        def replacer(m):
            return m.group(1) + new_text + m.group(3)
        result, n = re.subn(pattern, replacer, html_str, count=1, flags=re.IGNORECASE | re.DOTALL)
        return result if n > 0 else html_str

    if replacements.get("new_h1"):
        html = replace_first_tag_text(
            r'(<h1[^>]*>)([^<]*)(</h1>)',
            replacements["new_h1"],
            html,
        )

    if replacements.get("new_h2"):
        html = replace_first_tag_text(
            r'(<h2[^>]*>)([^<]*)(</h2>)',
            replacements["new_h2"],
            html,
        )

    if replacements.get("new_title"):
        html = replace_first_tag_text(
            r'(<title[^>]*>)([^<]*)(</title>)',
            replacements["new_title"],
            html,
        )

    if replacements.get("new_meta_description"):
        html = re.sub(
            r'(<meta[^>]*name=["\']description["\'][^>]*content=["\'])([^"\']*)',
            lambda m: m.group(1) + replacements["new_meta_description"],
            html,
            count=1,
            flags=re.IGNORECASE,
        )

    # Inject Troopod banner
    banner = (
        '<div style="background:linear-gradient(90deg,#6366f1,#a21caf);color:white;'
        'text-align:center;padding:10px 16px;font-size:13px;font-family:sans-serif;'
        'position:sticky;top:0;z-index:99999;letter-spacing:0.02em;">'
        '✦ Personalized by <strong>Troopod AI</strong> — Ad-matched Landing Page'
        '</div>'
    )
    # Try to inject after opening body tag
    if re.search(r'<body[^>]*>', html, re.IGNORECASE):
        html = re.sub(r'(<body[^>]*>)', f'\\1\n{banner}', html, count=1, flags=re.IGNORECASE)
    else:
        html = banner + "\n" + html

    return html


def orchestrate(lp_url: str, image_b64=None, image_url=None, vlm_model=DEFAULT_VLM, llm_model=DEFAULT_LLM) -> dict:
    try:
        lp_elements = scrape_landing_page(lp_url)
    except Exception as e:
        return {"error": f"Failed to scrape landing page: {e}"}

    try:
        ad_insights = analyze_ad_creative(image_b64, image_url, vlm_model)
    except Exception as e:
        return {"error": f"Failed to analyze ad creative: {e}"}

    try:
        replacements = generate_replacements(lp_elements, ad_insights, llm_model)
    except Exception as e:
        return {"error": f"Failed to generate replacements: {e}"}

    try:
        modified_html = apply_replacements(lp_elements["raw_html"], replacements, lp_elements["base_url"])
    except Exception as e:
        return {"error": f"Failed to apply replacements: {e}"}

    return {
        "modified_html": modified_html,
        "changes_summary": replacements.get("changes_summary", []),
        "ad_insights": ad_insights,
        "error": None,
    }


# ────────────────────────────────────────────────
# Vercel Handler — stdlib only, no FastAPI/uvicorn
# ────────────────────────────────────────────────
class handler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            raw_body = self.rfile.read(content_length)
            data = json.loads(raw_body.decode("utf-8"))

            lp_url = data.get("lp_url", "").strip()
            image_b64 = data.get("ad_image_b64")
            image_url = data.get("ad_image_url", "").strip() or None
            vlm_model = data.get("vlm_model", "").strip() or DEFAULT_VLM
            llm_model = data.get("llm_model", "").strip() or DEFAULT_LLM

            if not lp_url:
                self._send_json(400, {"error": "Missing lp_url"})
                return

            if not OPENROUTER_API_KEY:
                self._send_json(500, {"error": "OPENROUTER_API_KEY not configured on server."})
                return

            result = orchestrate(lp_url, image_b64, image_url, vlm_model, llm_model)

            if result.get("error"):
                self._send_json(500, result)
            else:
                self._send_json(200, result)

        except json.JSONDecodeError as e:
            self._send_json(400, {"error": f"Invalid JSON in request body: {e}"})
        except Exception as e:
            self._send_json(500, {"error": f"Unexpected server error: {e}", "trace": traceback.format_exc()})

    def do_GET(self):
        self._send_json(200, {"status": "ok", "message": "AdPersonalizer API is running."})

    def log_message(self, format, *args):
        pass  # suppress default logging noise
