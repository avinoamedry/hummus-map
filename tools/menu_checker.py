"""Menu checker: finds hummus and ful dishes (and their prices) on restaurant websites.

Runs on your own computer, so there are no approvals and no blocking of AI tools.

Usage (Windows, in Command Prompt):
    pip install pypdf
    python menu_checker.py C:\\Users\\User\\Desktop\\prague_places.parquet

Input: an Overture "place" file downloaded with overturemaps-py (.parquet),
       or a CSV with at least the columns name, website (optional: id, lat, lon, address, category).
Output (next to the input file):
    menu_results.csv   one row per hummus/ful line found, with the price if one is next to it
    places_checked.csv one row per place: what happened (found / no mention / blocked / error...)

Polite by design: obeys robots.txt, one request at a time per site, small time-outs,
and never touches delivery platforms or social networks (their terms forbid it).
"""
import csv
import io
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request
import urllib.robotparser
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from html.parser import HTMLParser
from pathlib import Path

USER_AGENT = "HummusMapMenuChecker/1.0 (personal research; https://avinoamedry.github.io/hummus-map/)"
TIMEOUT = 15            # seconds per request
MAX_BYTES = 8_000_000   # skip anything bigger (huge PDFs)
MAX_MENU_PAGES = 6      # menu pages/PDFs to open per site, besides the home page
WORKERS = 8             # sites checked at the same time

# ---- which Overture places to check ------------------------------------------------
STRONG = {"middle_eastern_restaurant", "lebanese_restaurant", "falafel_restaurant", "kosher_restaurant",
          "jewish_restaurant", "halal_restaurant", "arabian_restaurant", "israeli_restaurant",
          "syrian_restaurant", "egyptian_restaurant", "palestinian_restaurant", "iraqi_restaurant"}
POSSIBLE = {"mediterranean_restaurant", "afghani_restaurant", "armenian_restaurant", "moroccan_restaurant",
            "vegan_restaurant", "vegetarian_restaurant"}
# Turkish, Persian, Greek and doner places only if the name says hummus (Moody's rule)
EXCLUDED = {"turkish_restaurant", "persian_restaurant", "greek_restaurant", "doner_kebab_restaurant"}
NAME_HINT = re.compile(r"hum+[ou]s|hom+os|houmous|falaf|shawarma|shawerma|šawarm|levant|beirut|tel.?aviv|"
                       r"jerusal|sabab|yalla|habibi|leban|syri|israel|tahin|damasc|aleppo|baghdad|mezze|\bpita\b", re.I)
FOOD_WORDS = ("restaurant", "cafe", "bistro", "fast_food", "food", "deli", "bakery", "caterer", "coffee", "bar")

# ---- what to look for on the menus ---------------------------------------------------
HUMMUS = re.compile(r"\b(?:hum+[ou]s|hom+[ou]s|hou?m+ous|chum+us|hummos)\b|חומוס|حمص", re.I)
FUL = re.compile(r"\b(?:ful|foul|fuul|m[ae]?dam+[ae]s|mudam+as|medames|fava(?: beans?)?)\b|פול|فول", re.I)
TRAILING_NUMBER = re.compile(r"(?<![\d.,])(\d{2,4}(?:[.,]\d{1,2})?)\s*(?:,-|,–|\.-)?\s*$")
PRICE = re.compile(
    r"(?:(€|£|\$|CHF)\s?(\d{1,4}(?:[.,]\d{1,2})?))"
    r"|(?:(\d{1,4}(?:[.,]\d{1,2})?)\s?(?:,-|,–|\.-)?\s?(Kč|Kc|CZK|EUR|€|zł|PLN|Ft|HUF|£|GBP|CHF|SEK|DKK|NOK|kr|lei|RON|lv|BGN|din|RSD|kn|Kn)\b)",
    re.I)
CURRENCY = {"kč": "CZK", "kc": "CZK", "czk": "CZK", "€": "EUR", "eur": "EUR", "zł": "PLN", "pln": "PLN",
            "ft": "HUF", "huf": "HUF", "£": "GBP", "gbp": "GBP", "chf": "CHF", "sek": "SEK", "dkk": "DKK",
            "nok": "NOK", "kr": "SEK/DKK/NOK", "lei": "RON", "ron": "RON", "lv": "BGN", "bgn": "BGN",
            "din": "RSD", "rsd": "RSD", "kn": "HRK", "$": "USD"}
MENU_LINK = re.compile(r"men[uüù]|j[ií]deln|l[ií]stek|karta|carte|speisekarte|food|jidlo|jídlo|nab[ií]dka|"
                       r"essen|cardápio|carta|piatti|dishes|order|objedn|\.pdf\b", re.I)
SKIP_HOSTS = re.compile(r"facebook\.|instagram\.|wolt\.|foodora\.|bolt\.|ubereats\.|deliveroo\.|lieferando\.|"
                        r"google\.|tripadvisor\.|yelp\.|booking\.|twitter\.|x\.com|tiktok\.|linktr\.ee", re.I)


def ssl_context():
    """Uses certifi's certificates when available (fixes 'certificate has expired' on some Windows PCs)."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


SSL = ssl_context()
_robots = {}


def allowed(url):
    parts = urllib.parse.urlsplit(url)
    base = f"{parts.scheme}://{parts.netloc}"
    if base not in _robots:
        rp = urllib.robotparser.RobotFileParser()
        try:
            req = urllib.request.Request(base + "/robots.txt", headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=TIMEOUT, context=SSL) as r:
                rp.parse(r.read(200_000).decode("utf-8", "replace").splitlines())
        except Exception:
            rp.parse([])  # no robots.txt = allowed
        _robots[base] = rp
    return _robots[base].can_fetch(USER_AGENT, url)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "en,cs;q=0.8,*;q=0.5"})
    with urllib.request.urlopen(req, timeout=TIMEOUT, context=SSL) as r:
        ctype = r.headers.get("Content-Type", "")
        data = r.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError("file too big")
        return r.geturl(), ctype, data


class PageParser(HTMLParser):
    """Collects visible text (line by line) and links."""
    BLOCK = {"p", "div", "li", "tr", "td", "th", "br", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "span", "dd", "dt"}

    def __init__(self):
        super().__init__()
        self.lines, self.links, self._buf, self._skip, self._href, self._atext = [], [], [], 0, None, []

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript", "svg"):
            self._skip += 1
        if tag in self.BLOCK:
            self._flush()
        if tag == "a":
            self._href = dict(attrs).get("href")
            self._atext = []

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "svg") and self._skip:
            self._skip -= 1
        if tag in self.BLOCK:
            self._flush()
        if tag == "a" and self._href:
            self.links.append((self._href, " ".join(self._atext)))
            self._href = None

    def handle_data(self, data):
        if self._skip:
            return
        self._buf.append(data)
        if self._href is not None:
            self._atext.append(data.strip())

    def _flush(self):
        line = re.sub(r"\s+", " ", "".join(self._buf)).strip()
        if line:
            self.lines.append(line)
        self._buf = []

    def close(self):
        super().close()
        self._flush()


def pdf_lines(data):
    try:
        from pypdf import PdfReader
    except ImportError:
        raise RuntimeError("pypdf not installed: run  pip install pypdf")
    reader = PdfReader(io.BytesIO(data))
    text = "\n".join((page.extract_text() or "") for page in reader.pages[:40])
    return [re.sub(r"[ \t]+", " ", l).strip() for l in text.splitlines() if l.strip()]


def find_price(lines, i):
    """Price on the same line, else on the next line (PDF menus often put it there)."""
    for j in (i, i + 1):
        if j >= len(lines):
            break
        m = PRICE.search(lines[j])
        if m:
            if m.group(1):
                sym, num = m.group(1), m.group(2)
            else:
                num, sym = m.group(3), m.group(4)
            return num.replace(",", "."), CURRENCY.get(sym.lower(), sym)
        m = TRAILING_NUMBER.search(lines[j])  # "Hummus with pita ..... 135" or "135,-"
        if m and (j == i or len(lines[j]) < 20):
            return m.group(1).replace(",", "."), "?"
        m = re.match(r"\s*(\d{2,4}(?:[.,]\d{1,2})?)\b", lines[j])  # price alone on the next line
        if m and j > i and len(lines[j]) < 20:
            return m.group(1).replace(",", "."), "?"
    return "", ""


def scan(lines, page_url):
    hits = []
    for i, line in enumerate(lines):
        for dish, rx in (("hummus", HUMMUS), ("ful", FUL)):
            m = rx.search(line)
            if not m:
                continue
            start = max(0, m.start() - 80)
            snippet = line[start:start + 180].strip()
            price, cur = find_price(lines, i)
            hits.append({"dish": dish, "item_text": snippet, "price": price, "currency": cur, "page_url": page_url})
    return hits


def normalise_site(url):
    url = (url or "").strip()
    if not url:
        return None
    if not re.match(r"https?://", url, re.I):
        url = "http://" + url
    return None if SKIP_HOSTS.search(urllib.parse.urlsplit(url).netloc) else url


def check_place(place):
    out = {"status": "", "pages_checked": 0, "hits": []}
    site = normalise_site(place.get("website"))
    if not site:
        out["status"] = "no website (or only social/delivery link)"
        return place, out
    try:
        if not allowed(site):
            out["status"] = "site does not allow automated reading (robots.txt)"
            return place, out
        final, ctype, data = fetch(site)
    except Exception as e:
        out["status"] = f"error: {type(e).__name__}: {str(e)[:80]}"
        return place, out

    queue, seen = [(final, ctype, data)], {final}
    home_links = []
    while queue and out["pages_checked"] <= MAX_MENU_PAGES:
        url, ctype, data = queue.pop(0)
        out["pages_checked"] += 1
        try:
            if "pdf" in ctype.lower() or url.lower().endswith(".pdf") or data[:5] == b"%PDF-":
                lines = pdf_lines(data)
            else:
                p = PageParser()
                p.feed(data.decode("utf-8", "replace"))
                p.close()
                lines = p.lines
                if url == final:
                    home_links = p.links
        except Exception as e:
            out["status"] = out["status"] or f"could not read {url}: {str(e)[:60]}"
            continue
        out["hits"] += scan(lines, url)
        if url == final:
            host = urllib.parse.urlsplit(final).netloc.split(":")[0].removeprefix("www.")
            cands = []
            for href, text in home_links:
                if not href or href.startswith(("mailto:", "tel:", "#", "javascript:")):
                    continue
                full = urllib.parse.urljoin(final, href).split("#")[0]
                h = urllib.parse.urlsplit(full).netloc.split(":")[0].removeprefix("www.")
                is_pdf = full.lower().split("?")[0].endswith(".pdf")
                if (h != host and not is_pdf) or SKIP_HOSTS.search(h):
                    continue
                if MENU_LINK.search(full) or MENU_LINK.search(text or ""):
                    cands.append((0 if is_pdf else 1, full))
            for _, link in sorted(set(cands))[:MAX_MENU_PAGES]:
                if link in seen:
                    continue
                seen.add(link)
                try:
                    if allowed(link):
                        time.sleep(0.5)
                        queue.append(fetch(link))
                except Exception:
                    pass
    if out["hits"]:
        dishes = sorted({h["dish"] for h in out["hits"]})
        out["status"] = "found " + " + ".join(dishes)
    elif not out["status"]:
        out["status"] = "no hummus/ful mention found (menu may be an image, or loaded by JavaScript)"
    return place, out


# ---- reading the input ---------------------------------------------------------------
def from_parquet(path):
    import pyarrow.parquet as pq
    table = pq.read_table(path)
    cols = set(table.column_names)
    places = []
    for r in table.to_pylist():
        name = ((r.get("names") or {}).get("primary") or "").strip()
        cat = None
        if "taxonomy" in cols and r.get("taxonomy"):
            cat = r["taxonomy"].get("primary")
        elif "categories" in cols and r.get("categories"):
            cat = r["categories"].get("primary")
        if (r.get("operating_status") or "") in ("permanently_closed",):
            continue
        hint = bool(NAME_HINT.search(name))
        foodish = cat is None or any(w in cat for w in FOOD_WORDS)
        if cat in EXCLUDED and not re.search(r"hum+[ou]s|hom+os", name, re.I):
            continue
        if cat in STRONG or (hint and foodish):
            tier = "strong"
        elif cat in POSSIBLE:
            tier = "possible"
        else:
            continue
        lon = lat = ""
        try:
            from shapely import wkb
            g = wkb.loads(r["geometry"])
            lon, lat = round(g.x, 6), round(g.y, 6)
        except Exception:
            pass
        addr = ""
        if r.get("addresses"):
            a = r["addresses"][0] or {}
            addr = ", ".join(x for x in (a.get("freeform"), a.get("locality"), a.get("country")) if x)
        sites = [w for w in (r.get("websites") or []) if w]
        good = [w for w in sites if normalise_site(w)]
        places.append({"id": r.get("id", ""), "name": name, "category": cat or "", "tier": tier,
                       "confidence": round(r.get("confidence") or 0, 2), "lat": lat, "lon": lon,
                       "address": addr, "website": (good or sites or [""])[0]})
    # same name + same website = one place
    uniq = {}
    for p in places:
        uniq.setdefault((p["name"].lower(), p["website"].lower()), p)
    return list(uniq.values())


def from_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    return [{"id": r.get("id", ""), "name": r.get("name") or r.get("Place", ""), "category": r.get("category", ""),
             "tier": r.get("tier", ""), "confidence": r.get("confidence", ""), "lat": r.get("lat", ""),
             "lon": r.get("lon", ""), "address": r.get("address", ""), "website": r.get("website") or r.get("Website", "")}
            for r in rows]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    src = Path(sys.argv[1])
    places = from_parquet(src) if src.suffix.lower() == ".parquet" else from_csv(src)
    with_site = sum(1 for p in places if normalise_site(p["website"]))
    print(f"{len(places)} candidate places, {with_site} with a website to check.")
    today = date.today().isoformat()
    res_path, sum_path = src.with_name("menu_results.csv"), src.with_name("places_checked.csv")
    results, summary = [], []
    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(check_place, p) for p in places]
        for fut in as_completed(futures):
            place, out = fut.result()
            done += 1
            if done % 10 == 0 or done == len(places):
                print(f"  {done}/{len(places)} checked")
            summary.append({**place, "status": out["status"], "pages_checked": out["pages_checked"],
                            "hummus_lines": sum(h["dish"] == "hummus" for h in out["hits"]),
                            "ful_lines": sum(h["dish"] == "ful" for h in out["hits"]), "checked_date": today})
            seen = set()
            for h in out["hits"]:
                key = (h["dish"], h["item_text"].lower())
                if key in seen:
                    continue
                seen.add(key)
                results.append({"id": place["id"], "name": place["name"], "dish": h["dish"], "item_text": h["item_text"],
                                "price": h["price"], "currency": h["currency"], "page_url": h["page_url"],
                                "website": place["website"], "address": place["address"], "lat": place["lat"],
                                "lon": place["lon"], "checked_date": today})
    summary.sort(key=lambda s: (not s["status"].startswith("found"), s["name"].lower()))
    results.sort(key=lambda r: (r["name"].lower(), r["dish"]))
    for path, rows in ((res_path, results), (sum_path, summary)):
        if not rows:
            continue
        with open(path, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
    found = sum(1 for s in summary if s["status"].startswith("found"))
    print(f"\nDone. Hummus/ful found on {found} sites, {len(results)} menu lines.")
    print(f"Results:  {res_path}\nSummary:  {sum_path}")


if __name__ == "__main__":
    main()
