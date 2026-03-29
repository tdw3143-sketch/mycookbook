import json
import os
import re
import time
import uuid
from datetime import datetime

import anthropic
import requests
from dotenv import load_dotenv
load_dotenv()
from bs4 import BeautifulSoup
from flask import Flask, jsonify, render_template, request
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import text

app = Flask(__name__)

# Railway (and most cloud hosts) terminate TLS at their edge proxy and forward
# plain HTTP to the app. ProxyFix makes Flask trust the X-Forwarded-* headers
# so sessions and secure cookies work correctly over HTTPS.
from werkzeug.middleware.proxy_fix import ProxyFix
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Support SQLite locally and PostgreSQL on Railway
_db_url = os.environ.get("DATABASE_URL", "")
if not _db_url:
    _data_dir = os.path.join(os.path.dirname(__file__), "data")
    os.makedirs(_data_dir, exist_ok=True)
    _db_url = f"sqlite:///{os.path.join(_data_dir, 'local.db')}"
elif _db_url.startswith("postgres://"):
    # Railway provides postgres:// but SQLAlchemy needs postgresql://
    _db_url = _db_url.replace("postgres://", "postgresql://", 1)

app.config["SQLALCHEMY_DATABASE_URI"] = _db_url
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db = SQLAlchemy(app)


# ---------------------------------------------------------------------------
# Database models
# ---------------------------------------------------------------------------

class Recipe(db.Model):
    __tablename__ = "recipes"
    id           = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    title        = db.Column(db.String(500),  default="")
    description  = db.Column(db.Text,         default="")
    image        = db.Column(db.Text,         default="")
    ingredients  = db.Column(db.JSON,         default=list)
    instructions = db.Column(db.JSON,         default=list)
    prep_time    = db.Column(db.String(100),  default="")
    cook_time    = db.Column(db.String(100),  default="")
    servings     = db.Column(db.Integer,      nullable=True)
    nutrition    = db.Column(db.JSON,         default=dict)
    source_url   = db.Column(db.Text,         default="")
    tags         = db.Column(db.JSON,         default=list)
    favourite    = db.Column(db.Boolean,      default=False, nullable=False, server_default="0")
    created_at   = db.Column(db.DateTime,     default=datetime.utcnow)
    updated_at   = db.Column(db.DateTime,     nullable=True)

    def to_dict(self):
        return {
            "id":           self.id,
            "title":        self.title or "",
            "description":  self.description or "",
            "image":        self.image or "",
            "ingredients":  self.ingredients or [],
            "instructions": self.instructions or [],
            "prepTime":     self.prep_time or "",
            "cookTime":     self.cook_time or "",
            "servings":     self.servings,
            "nutrition":    self.nutrition or {},
            "source_url":   self.source_url or "",
            "tags":         self.tags or [],
            "favourite":    bool(self.favourite),
            "created_at":   self.created_at.isoformat() + "Z" if self.created_at else "",
            "updated_at":   self.updated_at.isoformat() + "Z" if self.updated_at else None,
        }


class MealPlan(db.Model):
    __tablename__ = "meal_plans"
    id         = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name       = db.Column(db.String(500), default="Untitled Week")
    plan       = db.Column(db.JSON,        default=dict)
    people     = db.Column(db.Integer,     default=2)
    created_at = db.Column(db.DateTime,    default=datetime.utcnow)

    def to_dict(self):
        return {
            "id":         self.id,
            "name":       self.name or "",
            "plan":       self.plan or {},
            "people":     self.people or 2,
            "created_at": self.created_at.isoformat() + "Z" if self.created_at else "",
        }


# Create tables on first run, and migrate away from user_id columns if needed
with app.app_context():
    db.create_all()
    try:
        with db.engine.connect() as conn:
            conn.execute(text("ALTER TABLE recipes DROP COLUMN IF EXISTS user_id"))
            conn.execute(text("ALTER TABLE meal_plans DROP COLUMN IF EXISTS user_id"))
            conn.commit()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Helpers: Albert Heijn API  (server-level tokens, not per-user)
# ---------------------------------------------------------------------------

AH_TOKENS_FILE = os.path.join(os.path.dirname(__file__), "data", "ah_tokens.json")
AH_BASE      = "https://api.ah.nl"
AH_CLIENT_ID = "appie-ios"
AH_UA        = "Appie/9.28 (iPhone17,3; iPhone; CPU OS 26_1 like Mac OS X)"
AH_LOGIN_URL = (
    "https://login.ah.nl/secure/oauth/authorize"
    "?client_id=appie-ios&response_type=code"
    "&redirect_uri=appie%3A%2F%2Flogin-exit"
)


def load_ah_tokens():
    if not os.path.exists(AH_TOKENS_FILE):
        return None
    with open(AH_TOKENS_FILE, "r", encoding="utf-8") as f:
        try:
            return json.load(f)
        except (json.JSONDecodeError, ValueError):
            return None


def save_ah_tokens(tokens):
    os.makedirs(os.path.dirname(AH_TOKENS_FILE), exist_ok=True)
    with open(AH_TOKENS_FILE, "w", encoding="utf-8") as f:
        json.dump(tokens, f, indent=2)


def _ah_headers(access_token=None):
    h = {
        "User-Agent": AH_UA,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Application": AH_CLIENT_ID,
        "X-ClientVersion": "9.28",
    }
    if access_token:
        h["Authorization"] = f"Bearer {access_token}"
    return h


def _exchange_ah_code(code):
    resp = requests.post(
        f"{AH_BASE}/mobile-auth/v1/auth/token",
        headers=_ah_headers(),
        json={"clientId": AH_CLIENT_ID, "code": code, "redirectUri": "appie://login-exit"},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def _refresh_ah_token(tokens):
    resp = requests.post(
        f"{AH_BASE}/mobile-auth/v1/auth/token/refresh",
        headers=_ah_headers(),
        json={"clientId": AH_CLIENT_ID, "refreshToken": tokens["refresh_token"]},
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    tokens["access_token"] = data["access_token"]
    tokens["expires_at"] = int(time.time()) + data.get("expires_in", 3600)
    if "refresh_token" in data:
        tokens["refresh_token"] = data["refresh_token"]
    save_ah_tokens(tokens)
    return tokens


def get_valid_ah_tokens():
    tokens = load_ah_tokens()
    if not tokens:
        return None
    if int(time.time()) >= tokens.get("expires_at", 0) - 60:
        try:
            tokens = _refresh_ah_token(tokens)
        except Exception:
            return None
    return tokens


# ---------------------------------------------------------------------------
# Helpers: scraping
# ---------------------------------------------------------------------------

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,nl;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
}

EMPTY_RECIPE = {
    "title": "",
    "description": "",
    "image": "",
    "ingredients": [],
    "instructions": [],
    "prepTime": "",
    "cookTime": "",
    "servings": None,
    "nutrition": {},
    "source_url": "",
}


def f_to_c(match):
    f = float(match.group(1))
    c = round((f - 32) * 5 / 9)
    return f"{c}°C"


_UNIT_SUBS = [
    (re.compile(r"(\d+(?:\.\d+)?)\s*°?\s*(?:degrees?\s*)?[Ff]ahrenheit\b", re.IGNORECASE), f_to_c),
    (re.compile(r"(\d+(?:\.\d+)?)\s*°[Ff]\b"),                                              f_to_c),
    (re.compile(r"(\d+(?:\.\d+)?)\s*degrees?\s+[Ff]\b",           re.IGNORECASE),           f_to_c),
    (re.compile(r"(\d+(?:[./]\d+)?)\s*cups?\b", re.IGNORECASE),
     lambda m: f"{_fmt(float(m.group(1)) * 240)} ml"),
    (re.compile(r"(\d+(?:[./]\d+)?)\s*(?:tablespoons?|tbsps?|Tbsps?)\b", re.IGNORECASE),
     lambda m: f"{_fmt(float(m.group(1)) * 15)} ml"),
    (re.compile(r"(\d+(?:[./]\d+)?)\s*(?:teaspoons?|tsps?)\b", re.IGNORECASE),
     lambda m: f"{_fmt(float(m.group(1)) * 5)} ml"),
    (re.compile(r"(\d+(?:[./]\d+)?)\s*fl\.?\s*oz\.?\b", re.IGNORECASE),
     lambda m: f"{_fmt(float(m.group(1)) * 30)} ml"),
    (re.compile(r"(\d+(?:[./]\d+)?)\s*(?:pounds?|lbs?)\b", re.IGNORECASE),
     lambda m: _weight_str(float(m.group(1)) * 454)),
    (re.compile(r"(\d+(?:[./]\d+)?)\s*oz\.?\b(?!\s*fl)", re.IGNORECASE),
     lambda m: f"{_fmt(float(m.group(1)) * 28)} g"),
    (re.compile(r"(\d+(?:\.\d+)?)\s*(?:inches?|in\.?)\b", re.IGNORECASE),
     lambda m: f"{_fmt(float(m.group(1)) * 2.54)} cm"),
]


def _fmt(n):
    if n == int(n):
        return int(n)
    return round(n, 1)


def _weight_str(grams):
    if grams >= 1000:
        return f"{_fmt(grams / 1000)} kg"
    return f"{_fmt(grams)} g"


def _simple_fraction(s):
    if "/" in s:
        parts = s.split("/", 1)
        try:
            return float(parts[0]) / float(parts[1])
        except (ValueError, ZeroDivisionError):
            return None
    return None


def convert_units(text):
    for pattern, repl in _UNIT_SUBS:
        text = pattern.sub(repl, text)
    return text


def convert_recipe_units(recipe):
    recipe["ingredients"] = [convert_units(i) for i in recipe.get("ingredients") or []]
    recipe["instructions"] = [convert_units(i) for i in recipe.get("instructions") or []]
    return recipe


def parse_duration(value):
    if not value:
        return ""
    value = str(value).strip()
    if not value.startswith("PT") and not value.startswith("P"):
        return value
    hours = re.search(r"(\d+)H", value)
    minutes = re.search(r"(\d+)M", value)
    parts = []
    if hours:
        parts.append(f"{hours.group(1)} hr")
    if minutes:
        parts.append(f"{minutes.group(1)} min")
    return " ".join(parts) if parts else value


def coerce_list(value):
    if not value:
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, list):
        result = []
        for item in value:
            if isinstance(item, dict):
                if item.get("@type") == "HowToSection":
                    for step in item.get("itemListElement", []):
                        text = step.get("text") or step.get("name") or ""
                        if text:
                            result.append(text.strip())
                else:
                    text = item.get("text") or item.get("name") or ""
                    if text:
                        result.append(text.strip())
            elif isinstance(item, str):
                if item.strip():
                    result.append(item.strip())
        return result
    return []


def parse_nutrition(nutrition_obj):
    if not nutrition_obj or not isinstance(nutrition_obj, dict):
        return {}
    mapping = {
        "calories": "calories",
        "proteinContent": "protein",
        "carbohydrateContent": "carbs",
        "fatContent": "fat",
        "fiberContent": "fiber",
        "sugarContent": "sugar",
        "sodiumContent": "sodium",
    }
    result = {}
    for schema_key, label in mapping.items():
        val = nutrition_obj.get(schema_key)
        if val:
            result[label] = str(val)
    return result


def extract_from_json_ld(soup, source_url):
    """Try to find a schema.org Recipe in JSON-LD blocks."""
    # og:image is usually the hero photo the site chose; prefer it as thumbnail
    def _og(prop):
        tag = soup.find("meta", property=prop) or soup.find("meta", attrs={"name": prop})
        return (tag.get("content") or "").strip() if tag else ""
    page_og_image = _og("og:image") or _og("twitter:image")

    scripts = soup.find_all("script", type="application/ld+json")
    for script in scripts:
        try:
            raw = script.string or ""
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue

        if isinstance(data, dict) and "@graph" in data:
            data = data["@graph"]

        candidates = data if isinstance(data, list) else [data]

        for item in candidates:
            if not isinstance(item, dict):
                continue
            item_type = item.get("@type", "")
            types = item_type if isinstance(item_type, list) else [item_type]
            if not any("Recipe" in t for t in types):
                continue

            image_raw = item.get("image")
            image_url = ""
            if isinstance(image_raw, str):
                image_url = image_raw
            elif isinstance(image_raw, dict):
                image_url = image_raw.get("url", "")
            elif isinstance(image_raw, list) and image_raw:
                first = image_raw[0]
                image_url = first if isinstance(first, str) else first.get("url", "") if isinstance(first, dict) else ""

            servings_raw = item.get("recipeYield") or item.get("yield")
            servings = None
            if servings_raw:
                if isinstance(servings_raw, list):
                    servings_raw = servings_raw[0] if servings_raw else ""
                m = re.search(r"\d+", str(servings_raw))
                servings = int(m.group()) if m else None

            recipe = {
                "title":        item.get("name", "").strip(),
                "description":  item.get("description", "").strip(),
                "image":        page_og_image or image_url,
                "ingredients":  coerce_list(item.get("recipeIngredient")),
                "instructions": coerce_list(item.get("recipeInstructions")),
                "prepTime":     parse_duration(item.get("prepTime")),
                "cookTime":     parse_duration(item.get("cookTime")),
                "servings":     servings,
                "nutrition":    parse_nutrition(item.get("nutrition")),
                "source_url":   source_url,
            }
            return recipe

    return None


def extract_fallback(soup, source_url):
    def og(prop):
        tag = soup.find("meta", property=prop) or soup.find("meta", attrs={"name": prop})
        return (tag.get("content") or "").strip() if tag else ""

    title = og("og:title") or og("twitter:title") or (soup.title.string.strip() if soup.title else "")
    description = og("og:description") or og("description") or og("twitter:description")
    image = og("og:image") or og("twitter:image")

    return {
        "title": title, "description": description, "image": image,
        "ingredients": [], "instructions": [],
        "prepTime": "", "cookTime": "", "servings": None, "nutrition": {},
        "source_url": source_url,
    }


# ---------------------------------------------------------------------------
# Multi-recipe HTML extraction
# ---------------------------------------------------------------------------

def _text(tag):
    return tag.get_text(separator=" ", strip=True)


def _looks_like_ingredient(line):
    line = line.strip()
    if not line or len(line) > 120:
        return False
    return bool(re.match(r"^[\d½¼¾⅓⅔⅛⅜⅝⅞(]|^\w.*\b(g|kg|ml|l|tsp|tbsp|cup|oz|lb|pinch|dash|bunch|clove|slice|can|tin|pack)\b", line, re.IGNORECASE))


def _looks_like_instruction(line):
    line = line.strip()
    if not line or len(line) < 15:
        return False
    return True


def extract_multi_recipes(soup, source_url):
    if not soup.body:
        return None

    def og(prop):
        tag = soup.find("meta", property=prop)
        return (tag.get("content") or "").strip() if tag else ""
    page_image = og("og:image")

    headings = soup.body.find_all(["h2", "h3"])
    if len(headings) < 2:
        return None

    recipes = []
    for heading in headings:
        title = _text(heading).strip()
        if len(title) < 4 or re.match(r"^(jump to|table of|contents|notes?|tips?|faq|related|more|about|comment|share|print|ingredients?|instructions?|directions?)$", title, re.IGNORECASE):
            continue

        ingredients = []
        instructions = []
        found_img = ""

        heading_level = int(heading.name[1])
        sibling = heading.find_next_sibling()
        while sibling:
            sname = sibling.name or ""
            if sname in ("h1", "h2", "h3", "h4") and int(sname[1]) <= heading_level:
                break

            if not found_img:
                img = sibling.find("img") if hasattr(sibling, "find") else None
                if img:
                    found_img = img.get("src") or img.get("data-src") or ""

            if sname == "ul":
                items = [_text(li) for li in sibling.find_all("li")]
                items = [i for i in items if i]
                ing_like = sum(1 for i in items if _looks_like_ingredient(i))
                if ing_like >= len(items) * 0.4:
                    ingredients.extend(items)
                else:
                    instructions.extend(items)
            elif sname == "ol":
                items = [_text(li) for li in sibling.find_all("li")]
                instructions.extend(i for i in items if i)
            elif sname in ("p", "div"):
                text = _text(sibling).strip()
                numbered = re.findall(r"(?:^|\n)\s*\d+[.)]\s+(.+)", text)
                if numbered:
                    instructions.extend(numbered)
                elif re.match(r"^[-•]\s", text):
                    lines = [l.lstrip("-•").strip() for l in text.splitlines() if l.strip()]
                    ingredients.extend(l for l in lines if l)

            sibling = sibling.find_next_sibling()

        if (ingredients or instructions) and len(title) > 3:
            recipes.append({
                "title": title, "description": "",
                "image": found_img or page_image,
                "ingredients": ingredients, "instructions": instructions,
                "prepTime": "", "cookTime": "", "servings": None, "nutrition": {},
                "source_url": source_url,
            })

    if len(recipes) >= 2:
        return recipes
    return None


def is_youtube_url(url):
    return "youtube.com/watch" in url or "youtu.be/" in url


def handle_youtube(url):
    oembed_url = f"https://www.youtube.com/oembed?url={requests.utils.quote(url)}&format=json"
    title = "YouTube Video Recipe"
    try:
        resp = requests.get(oembed_url, timeout=8)
        if resp.ok:
            title = resp.json().get("title", title)
    except Exception:
        pass
    return {
        "title": title,
        "description": "Video recipes aren't auto-extracted yet. Add ingredients and instructions manually after saving.",
        "image": f"https://img.youtube.com/vi/{_yt_id(url)}/hqdefault.jpg",
        "ingredients": [], "instructions": [],
        "prepTime": "", "cookTime": "", "servings": None, "nutrition": {},
        "source_url": url,
    }


def infer_servings(ingredients, instructions):
    all_text = " ".join(ingredients + instructions)
    m = re.search(
        r"\b(?:serves?|for|makes?|yield[s:]?)\s+(\d+)\s*(?:people|persons?|portions?|servings?)?\b",
        all_text, re.IGNORECASE
    )
    if m:
        return int(m.group(1))
    return None


def _yt_id(url):
    m = re.search(r"(?:v=|youtu\.be/)([A-Za-z0-9_-]{11})", url)
    return m.group(1) if m else ""


def scrape_recipe(url):
    url = url.strip()
    if is_youtube_url(url):
        return handle_youtube(url)
    try:
        session = requests.Session()
        session.headers.update(HEADERS)
        resp = session.get(url, timeout=15, allow_redirects=True)
        resp.raise_for_status()
    except requests.RequestException as exc:
        err = str(exc)
        if "403" in err or "401" in err or "blocked" in err.lower():
            return {"error": (
                "This website is blocking imports. Try copying the recipe URL "
                "from your phone's browser instead, or take a photo of the recipe "
                "and use the 📷 Photo button."
            )}
        return {"error": f"Could not fetch URL: {exc}"}
    soup = BeautifulSoup(resp.text, "html.parser")
    recipe = extract_from_json_ld(soup, url)
    if recipe:
        return convert_recipe_units(recipe)
    multi = extract_multi_recipes(soup, url)
    if multi:
        return {"multi": True, "recipes": [convert_recipe_units(r) for r in multi]}
    return convert_recipe_units(extract_fallback(soup, url))


# ---------------------------------------------------------------------------
# Routes: index
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# Routes: recipes
# ---------------------------------------------------------------------------

@app.route("/api/recipes", methods=["GET"])
def get_recipes():
    recipes = Recipe.query.order_by(Recipe.created_at).all()
    return jsonify([r.to_dict() for r in recipes])


@app.route("/api/recipes", methods=["POST"])
def add_recipe():
    data = request.get_json(force=True)
    if not data:
        return jsonify({"error": "No data provided"}), 400

    source_url = (data.get("source_url") or "").strip()
    if source_url:
        existing = Recipe.query.filter_by(source_url=source_url).first()
        if existing:
            return jsonify({"duplicate": True, "existing": existing.to_dict()}), 409

    recipe = Recipe(
        title        = data.get("title", "Untitled Recipe"),
        description  = data.get("description", ""),
        image        = data.get("image", ""),
        ingredients  = [convert_units(i) for i in data.get("ingredients", [])],
        instructions = [convert_units(i) for i in data.get("instructions", [])],
        prep_time    = data.get("prepTime", ""),
        cook_time    = data.get("cookTime", ""),
        servings     = data.get("servings") or infer_servings(
            data.get("ingredients", []), data.get("instructions", [])
        ) or 2,
        nutrition    = data.get("nutrition", {}),
        source_url   = source_url,
        tags         = data.get("tags", []),
    )
    db.session.add(recipe)
    db.session.commit()
    return jsonify(recipe.to_dict()), 201


@app.route("/api/recipes/<recipe_id>", methods=["PUT", "PATCH"])
def update_recipe(recipe_id):
    data = request.get_json(force=True)
    if not data:
        return jsonify({"error": "No data provided"}), 400

    recipe = Recipe.query.filter_by(id=recipe_id).first()
    if not recipe:
        return jsonify({"error": "Recipe not found"}), 404

    if "title"       in data: recipe.title       = data["title"]
    if "description" in data: recipe.description = data["description"]
    if "image"       in data: recipe.image        = data["image"]
    if "prepTime"    in data: recipe.prep_time    = data["prepTime"]
    if "cookTime"    in data: recipe.cook_time    = data["cookTime"]
    if "servings"    in data: recipe.servings     = data["servings"]
    if "nutrition"   in data: recipe.nutrition    = data["nutrition"]
    if "source_url"  in data: recipe.source_url   = data["source_url"]
    if "tags"        in data: recipe.tags         = data["tags"]
    if "favourite"   in data: recipe.favourite    = bool(data["favourite"])
    if "ingredients"  in data:
        recipe.ingredients  = [convert_units(i) for i in (data["ingredients"] or [])]
    if "instructions" in data:
        recipe.instructions = [convert_units(i) for i in (data["instructions"] or [])]

    recipe.updated_at = datetime.utcnow()
    db.session.commit()
    return jsonify(recipe.to_dict())


@app.route("/api/recipes/<recipe_id>", methods=["DELETE"])
def delete_recipe(recipe_id):
    recipe = Recipe.query.filter_by(id=recipe_id).first()
    if not recipe:
        return jsonify({"error": "Recipe not found"}), 404
    db.session.delete(recipe)
    db.session.commit()
    return jsonify({"ok": True})


@app.route("/api/import", methods=["POST"])
def import_recipe():
    data = request.get_json(force=True)
    if not data or not data.get("url"):
        return jsonify({"error": "No URL provided"}), 400
    result = scrape_recipe(data["url"])
    if "error" in result:
        return jsonify(result), 422
    return jsonify(result)


@app.route("/api/ping")
def ping():
    return jsonify({"ok": True})


@app.route("/api/import/image", methods=["POST"])
def import_recipe_from_image():
    print("[image-import] request received", flush=True)
    data = request.get_json(force=True) or {}
    image_b64  = data.get("image")
    media_type = data.get("mediaType", "image/jpeg")
    print(f"[image-import] image size: {len(image_b64) if image_b64 else 0} chars, mediaType: {media_type}", flush=True)

    if not image_b64:
        return jsonify({"error": "No image provided"}), 400

    try:
        print("[image-import] calling Claude API…", flush=True)
        client = anthropic.Anthropic()
        message = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=2048,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": image_b64}},
                    {"type": "text", "text": (
                        "Extract the recipe from this image. "
                        "Return ONLY a JSON object with these fields:\n"
                        '{"title": "", "description": "", "ingredients": [], '
                        '"instructions": [], "prepTime": "", "cookTime": "", "servings": null}\n'
                        "ingredients and instructions must be arrays of strings. "
                        "servings must be an integer or null. "
                        'If no recipe is visible, return {"error": "No recipe found in image"}.'
                    )},
                ],
            }],
        )
        result = json.loads(message.content[0].text)
    except anthropic.AuthenticationError:
        print("[image-import] auth error", flush=True)
        return jsonify({"error": "ANTHROPIC_API_KEY is not set or invalid"}), 500
    except (json.JSONDecodeError, IndexError, KeyError) as exc:
        print(f"[image-import] parse error: {exc}", flush=True)
        return jsonify({"error": "Could not parse recipe from image"}), 422
    except Exception as exc:
        print(f"[image-import] exception: {exc}", flush=True)
        return jsonify({"error": str(exc)}), 500
    print("[image-import] success", flush=True)

    if "error" in result:
        return jsonify(result), 422

    recipe = {**EMPTY_RECIPE, **result, "source_url": ""}
    return jsonify(convert_recipe_units(recipe))


@app.route("/api/import/json", methods=["POST"])
def import_from_json():
    """One-time migration: import recipes from an uploaded recipes.json file."""
    data = request.get_json(force=True) or {}
    recipes_data = data.get("recipes")
    if not isinstance(recipes_data, list):
        return jsonify({"error": "Expected {recipes: [...]}"}), 400

    imported = 0
    skipped  = 0
    for r in recipes_data:
        if not isinstance(r, dict):
            continue
        source_url = (r.get("source_url") or "").strip()
        if source_url and Recipe.query.filter_by(source_url=source_url).first():
            skipped += 1
            continue
        recipe = Recipe(
            title        = r.get("title", "Untitled Recipe"),
            description  = r.get("description", ""),
            image        = r.get("image", ""),
            ingredients  = r.get("ingredients", []),
            instructions = r.get("instructions", []),
            prep_time    = r.get("prepTime", ""),
            cook_time    = r.get("cookTime", ""),
            servings     = r.get("servings"),
            nutrition    = r.get("nutrition", {}),
            source_url   = source_url,
            tags         = r.get("tags", []),
        )
        db.session.add(recipe)
        imported += 1

    db.session.commit()
    return jsonify({"ok": True, "imported": imported, "skipped": skipped})


# ---------------------------------------------------------------------------
# Routes: meal plans
# ---------------------------------------------------------------------------

@app.route("/api/plans", methods=["GET"])
def get_plans():
    plans = MealPlan.query.order_by(MealPlan.created_at).all()
    return jsonify([p.to_dict() for p in plans])


@app.route("/api/plans", methods=["POST"])
def add_plan():
    data = request.get_json(force=True)
    if not data:
        return jsonify({"error": "No data provided"}), 400
    plan = MealPlan(
        name    = data.get("name", "Untitled Week"),
        plan    = data.get("plan", {}),
        people  = data.get("people", 2),
    )
    db.session.add(plan)
    db.session.commit()
    return jsonify(plan.to_dict()), 201


@app.route("/api/plans/<plan_id>", methods=["DELETE"])
def delete_plan(plan_id):
    plan = MealPlan.query.filter_by(id=plan_id).first()
    if not plan:
        return jsonify({"error": "Plan not found"}), 404
    db.session.delete(plan)
    db.session.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Routes: Albert Heijn
# ---------------------------------------------------------------------------

@app.route("/api/ah/status", methods=["GET"])
def ah_status():
    tokens = load_ah_tokens()
    return jsonify({"authenticated": tokens is not None})


@app.route("/api/ah/connect", methods=["POST"])
def ah_connect():
    data = request.get_json(force=True) or {}
    raw = (data.get("code") or "").strip()
    if not raw:
        return jsonify({"error": "No code provided"}), 400

    m = re.search(r"[?&]code=([^&]+)", raw)
    code = m.group(1) if m else raw

    try:
        result = _exchange_ah_code(code)
    except requests.HTTPError as exc:
        return jsonify({"error": f"AH auth failed: {exc.response.status_code}"}), 502
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502

    tokens = {
        "access_token":  result["access_token"],
        "refresh_token": result["refresh_token"],
        "expires_at":    int(time.time()) + result.get("expires_in", 3600),
    }
    save_ah_tokens(tokens)
    return jsonify({"ok": True})


@app.route("/api/ah/disconnect", methods=["DELETE"])
def ah_disconnect():
    if os.path.exists(AH_TOKENS_FILE):
        os.remove(AH_TOKENS_FILE)
    return jsonify({"ok": True})


@app.route("/api/ah/shopping-list", methods=["POST"])
def ah_push_shopping_list():
    tokens = get_valid_ah_tokens()
    if not tokens:
        return jsonify({"error": "Not authenticated with Albert Heijn"}), 401

    data = request.get_json(force=True) or {}
    items = data.get("items", [])
    if not items:
        return jsonify({"error": "No items provided"}), 400

    payload = [
        {"description": str(item), "quantity": 1, "type": "SHOPPABLE", "originCode": "PRD"}
        for item in items if str(item).strip()
    ]

    try:
        resp = requests.patch(
            f"{AH_BASE}/mobile-services/shoppinglist/v2/items",
            headers=_ah_headers(tokens["access_token"]),
            json=payload,
            timeout=20,
        )
        resp.raise_for_status()
    except requests.HTTPError as exc:
        body = ""
        try:
            body = exc.response.text[:200]
        except Exception:
            pass
        return jsonify({"error": f"AH API error {exc.response.status_code}: {body}"}), 502
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502

    return jsonify({"ok": True, "count": len(payload)})


# ---------------------------------------------------------------------------
# PWA
# ---------------------------------------------------------------------------

@app.route("/manifest.json")
def manifest():
    return app.send_static_file("manifest.json")


@app.route("/sw.js")
def service_worker():
    response = app.send_static_file("sw.js")
    response.headers["Service-Worker-Allowed"] = "/"
    response.headers["Cache-Control"] = "no-cache"
    return response


if __name__ == "__main__":
    import socket
    host = "0.0.0.0"
    port = 5000
    try:
        local_ip = socket.gethostbyname(socket.gethostname())
    except Exception:
        local_ip = "your-pc-ip"
    print(f"\n  Local:   http://localhost:{port}")
    print(f"  Network: http://{local_ip}:{port}  <- open this on your phone\n")
    app.run(debug=True, host=host, port=port)
