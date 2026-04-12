from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import json
import os
import re
import traceback
import requests as http_requests
from bs4 import BeautifulSoup

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from pathlib import Path
env_path = Path(".env.local")
if env_path.exists():
    for line in env_path.read_text().splitlines():
        if line.strip() and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_VLM = "qwen/qwen3.6-plus"
DEFAULT_LLM = "qwen/qwen3.6-plus"

# (Include all the helper functions here as they were before)
def scrape_landing_page(url: str) -> dict:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        )
    }
    resp = http_requests.get(url, headers=headers, timeout=20, allow_redirects=True)
    resp.raise_for_status()
    html = resp.text
    soup = BeautifulSoup(html, "html.parser")
    from urllib.parse import urlparse
    parsed = urlparse(url)
    base_url = f"{parsed.scheme}://{parsed.netloc}"

    elements = {"title": soup.title.string.strip() if soup.title and soup.title.string else "", "h1": [tag.get_text(strip=True) for tag in soup.find_all("h1")][:3], "h2": [tag.get_text(strip=True) for tag in soup.find_all("h2")][:5], "hero_paragraph": "", "cta_buttons": [], "meta_description": "", "base_url": base_url, "raw_html": html}
    meta = soup.find("meta", attrs={"name": "description"})
    if meta: elements["meta_description"] = meta.get("content", "")
    action_kw = ["get", "start", "try", "buy", "sign", "join", "book", "free", "demo", "contact", "learn"]
    for tag in soup.find_all(["a", "button"]):
        text = tag.get_text(strip=True)
        if text and len(text) < 60 and any(kw in text.lower() for kw in action_kw):
            elements["cta_buttons"].append(text)
    elements["cta_buttons"] = list(dict.fromkeys(elements["cta_buttons"]))[:5]
    for p in soup.find_all("p"):
        if len(p.get_text(strip=True)) > 40:
            elements["hero_paragraph"] = p.get_text(strip=True)
            break
    return elements

def _safe_parse_json(raw: str) -> dict:
    raw = raw.strip()
    if raw.startswith("```"):
        lines = raw.split("\n")
        if lines[0].startswith("```"): lines = lines[1:]
        if lines and lines[-1].strip() == "```": lines = lines[:-1]
        raw = "\n".join(lines)
    raw = raw.strip()
    try: return json.loads(raw)
    except json.JSONDecodeError: pass
    match = re.search(r'\{[\s\S]*\}', raw)
    if match:
        try: return json.loads(match.group())
        except json.JSONDecodeError: pass
    raise ValueError(f"Could not parse LLM response as JSON. Raw output: {raw[:200]}")

def analyze_ad_creative(image_b64: str = None, image_url: str = None, vlm_model: str = DEFAULT_VLM) -> dict:
    if image_b64:
        if not image_b64.startswith("data:"): image_b64 = f"data:image/jpeg;base64,{image_b64}"
        image_content = {"type": "image_url", "image_url": {"url": image_b64}}
    elif image_url:
        image_content = {"type": "image_url", "image_url": {"url": image_url}}
    else: raise ValueError("Either image_b64 or image_url must be provided.")

    payload = {
        "model": vlm_model,
        "messages": [
            {"role": "system", "content": "You are an expert advertising analyst. You analyze ad creatives and extract structured information. Always respond with valid JSON only, no markdown fences, no preamble, no explanation."},
            {"role": "user", "content": [image_content, {"type": "text", "text": "Analyze this advertisement image carefully. Extract: headline, sub_headline, offer, cta_text, target_pain_point, tone, target_audience, product_or_service, key_benefit, visual_style. Respond in valid JSON."}]}
        ]
    }
    resp = http_requests.post(OPENROUTER_BASE, json=payload, headers={"Authorization": f"Bearer {OPENROUTER_API_KEY}"}, timeout=45)
    resp.raise_for_status()
    return _safe_parse_json(resp.json()["choices"][0]["message"]["content"])

def generate_replacements(lp_elements: dict, ad_insights: dict, llm_model: str = DEFAULT_LLM) -> dict:
    user_prompt = f"Ad details:\n{json.dumps(ad_insights, indent=2)}\nLP elements:\n{json.dumps(lp_elements, indent=2, default=str)}\nRewrite LP elements for seamless message match. Return JSON: new_h1, new_h2, new_hero_paragraph, new_cta_primary, new_title, new_meta_description, changes_summary. Keep it concise. Match the ad tone."
    payload = {
        "model": llm_model,
        "messages": [
            {"role": "system", "content": "You are a CRO specialist. Rewrite landing page elements to match the ad. Respond with strict JSON only."},
            {"role": "user", "content": user_prompt}
        ]
    }
    resp = http_requests.post(OPENROUTER_BASE, json=payload, headers={"Authorization": f"Bearer {OPENROUTER_API_KEY}"}, timeout=45)
    resp.raise_for_status()
    return _safe_parse_json(resp.json()["choices"][0]["message"]["content"])

def apply_replacements(raw_html: str, replacements: dict, base_url: str) -> str:
    soup = BeautifulSoup(raw_html, "html.parser")
    for tag in soup.find_all(["link", "script", "img"]):
        for attr in ["href", "src"]:
            val = tag.get(attr, "")
            if val.startswith("/") and not val.startswith("//"): tag[attr] = base_url + val
            elif val.startswith("//"): tag[attr] = "https:" + val
    if soup.find("h1") and replacements.get("new_h1"): soup.find("h1").string = replacements["new_h1"]
    if soup.find("h2") and replacements.get("new_h2"): soup.find("h2").string = replacements["new_h2"]
    if replacements.get("new_hero_paragraph"):
        for p in soup.find_all("p"):
            if len(p.get_text(strip=True)) > 40:
                p.string = replacements["new_hero_paragraph"]
                break
    if replacements.get("new_cta_primary"):
        for tag in soup.find_all(["a", "button"]):
            if any(kw in tag.get_text(strip=True).lower() for kw in ["get", "start", "try", "buy", "sign", "join"]):
                if tag.string is not None: tag.string = replacements["new_cta_primary"]
                else:
                    tag.clear()
                    tag.string = replacements["new_cta_primary"]
                break
    if soup.title and replacements.get("new_title"): soup.title.string = replacements["new_title"]
    banner = soup.new_tag("div")
    banner["style"] = "background: #6366f1; color: white; text-align: center; padding: 10px; font-size: 13px; position: sticky; top: 0; z-index: 99999;"
    banner.string = "✦ Personalized by Troopod AI — Ad-matched Landing Page"
    if soup.body: soup.body.insert(0, banner)
    if soup.head and not soup.find("base"): soup.head.insert(0, soup.new_tag("base", href=base_url + "/"))
    return str(soup)

def orchestrate(lp_url: str, image_b64: str = None, image_url: str = None, vlm_model: str = DEFAULT_VLM, llm_model: str = DEFAULT_LLM) -> dict:
    try: lp_elements = scrape_landing_page(lp_url)
    except Exception as e: return {"error": f"Failed to scrape: {e}"}
    try: ad_insights = analyze_ad_creative(image_b64, image_url, vlm_model)
    except Exception as e: return {"error": f"Failed to analyze ad: {e}"}
    try: replacements = generate_replacements(lp_elements, ad_insights, llm_model)
    except Exception as e: return {"error": f"Failed to generate replacements: {e}"}
    try: modified_html = apply_replacements(lp_elements["raw_html"], replacements, lp_elements["base_url"])
    except Exception as e: return {"error": f"Failed to apply: {e}"}
    return {"modified_html": modified_html, "changes_summary": replacements.get("changes_summary", []), "ad_insights": ad_insights, "error": None}

@app.post("/api/analyze")
async def analyze_endpoint(request: Request):
    try:
        data = await request.json()
        lp_url = data.get("lp_url")
        image_b64 = data.get("ad_image_b64")
        image_url = data.get("ad_image_url")
        vlm_model = data.get("vlm_model", DEFAULT_VLM) or DEFAULT_VLM
        llm_model = data.get("llm_model", DEFAULT_LLM) or DEFAULT_LLM
        if not lp_url: return JSONResponse(status_code=400, content={"error": "Missing lp_url"})
        result = orchestrate(lp_url, image_b64, image_url, vlm_model, llm_model)
        if result.get("error"): return JSONResponse(status_code=500, content=result)
        return result
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Internal server error: {str(e)}", "trace": traceback.format_exc()})
