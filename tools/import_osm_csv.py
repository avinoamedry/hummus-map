"""ייבוא חד-פעמי של מקומות מ-OSM (ייצוא QuickOSM/Overpass ל-CSV) לשכבה hummus_places.

שימוש:
    python tools/import_osm_csv.py [data/osm_places.csv] [data/hummus_app.gpkg]

- שורה שמספר העמודות בה שונה מהכותרת מדולגת ומדווחת.
- מקום שה-osm_id שלו כבר קיים בשכבה לא נדרס.
- score, serves_*, diet_kosher, kashrut_*, reviewer_note נשארים ריקים (נאספים ידנית).
- השדה country (ISO2) נוסף לשכבה אם חסר, ומתמלא בחיתוך מרחבי מול tools/europe_countries.geojson
  (Natural Earth 1:10m). הוא קובע את אזור הזמן ואת החגים (PH) בחישוב השעות.
- אם node ו-opening_hours מותקנים (npm i opening_hours), ערכי השעות נבדקים ומודפס דוח שגיאות.
"""
import csv
import html
import json
import re
import shutil
import sqlite3
import subprocess
import sys
import unicodedata
from pathlib import Path

import geopandas as gpd
import pandas as pd
import pyogrio
from shapely import wkt

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "osm_places.csv"
GPKG_PATH = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "data" / "hummus_app.gpkg"
LAYER = "hummus_places"
COUNTRIES_PATH = Path(__file__).with_name("europe_countries.geojson")

# CSV (OSM) -> שדה ב-GPKG
COLUMN_MAP = {
    "name": "name",
    "addr:city": "addr_city",
    "addr:street": "addr_street",
    "addr:housenumber": "addr_housenumber",
    "opening_hours": "opening_hours",
    "phone": "phone",
    "website": "website",
    "contact:instagram": "instagram",
    "diet:vegan": "diet_vegan",
    "diet:vegetarian": "diet_vegetarian",
    "check_date:opening_hours": "last_checked",
}


def clean(value):
    value = html.unescape((value or "").strip())
    return value or None


def slugify(name):
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")
    return slug or "place"


def unique_slug(base, taken):
    slug, n = base, 2
    while slug in taken:
        slug, n = f"{base}-{n}", n + 1
    taken.add(slug)
    return slug


def read_csv_rows(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader)
        good, broken = [], []
        for line_no, row in enumerate(reader, start=2):
            if not any(row):
                continue
            if len(row) != len(header):
                broken.append((line_no, row, len(row)))
            else:
                good.append(dict(zip(header, row)))
    return header, good, broken


def check_hours(values):
    """מריץ את opening_hours.js דרך node. מחזיר {ערך: שגיאה} או None אם אין node/ספרייה."""
    checker = Path(__file__).with_name("check_hours.cjs")
    if not values:
        return {}
    if not shutil.which("node"):
        return None
    proc = subprocess.run(["node", str(checker)], input=json.dumps(values),
                          capture_output=True, text=True, cwd=ROOT)
    if proc.returncode != 0:
        print(f"  (בדיקת שעות דולגה: {proc.stderr.strip().splitlines()[-1] if proc.stderr else 'node failed'})")
        return None
    return json.loads(proc.stdout)


def ensure_country_column(path):
    with sqlite3.connect(path) as con:
        cols = [r[1] for r in con.execute(f'PRAGMA table_info("{LAYER}")')]
        if "country" not in cols:
            con.execute(f'ALTER TABLE "{LAYER}" ADD COLUMN "country" TEXT')
            print("נוסף שדה country לשכבה")


def fill_countries(path):
    """ממלא country לנקודות שבהן הוא ריק. נקודה שלא נופלת בפוליגון (קו חוף) מקבלת את המדינה הקרובה עד 5 ק"מ."""
    places = pyogrio.read_dataframe(path, layer=LAYER, fid_as_index=True)
    todo = places[places["country"].isna() & places.geometry.notna()]
    if todo.empty:
        return []
    countries = gpd.read_file(COUNTRIES_PATH)[["country", "geometry"]].to_crs(3035)
    pts = todo[["geometry"]].to_crs(3035)
    joined = gpd.sjoin_nearest(pts, countries, how="left", max_distance=5000)
    joined = joined[~joined.index.duplicated()]
    updates = [(cc, int(fid)) for fid, cc in joined["country"].items() if isinstance(cc, str)]
    with sqlite3.connect(path) as con:
        # טריגרי ה-rtree של GeoPackage מתקמפלים עם פונקציות ST_*. כאן הגאומטריה לא משתנה,
        # ולכן מספיקות פונקציות דמה כדי שהעדכון יעבור.
        for fn in ("ST_IsEmpty", "ST_MinX", "ST_MaxX", "ST_MinY", "ST_MaxY"):
            con.create_function(fn, 1, lambda g: 0)
        con.executemany(f'UPDATE "{LAYER}" SET country = ? WHERE fid = ?', updates)
    unresolved = [places.loc[fid, "name"] for fid, cc in joined["country"].items() if not isinstance(cc, str)]
    return unresolved


def main():
    header, rows, broken = read_csv_rows(CSV_PATH)
    print(f"CSV: {len(rows) + len(broken)} שורות נתונים, {len(header)} עמודות בכותרת")

    ensure_country_column(GPKG_PATH)
    existing = pyogrio.read_dataframe(GPKG_PATH, layer=LAYER)
    known_osm = set(existing["osm_id"].dropna().astype("int64"))
    taken_slugs = set(existing["slug"].dropna())
    next_id = int(existing["place_id"].max()) + 1 if existing["place_id"].notna().any() else 1

    records, skipped_dupes = [], []
    for row in rows:
        osm_type, _, osm_id = (row.get("@id") or "").partition("/")
        osm_id = int(osm_id) if osm_id.isdigit() else None
        if osm_id in known_osm:
            skipped_dupes.append(clean(row.get("name")))
            continue
        rec = {field: clean(row.get(col)) for col, field in COLUMN_MAP.items()}
        rec.update(
            geometry=wkt.loads(row["WKT"]),
            osm_type=osm_type or None,
            osm_id=osm_id,
            source="osm",
            place_id=next_id,
            slug=unique_slug(slugify(rec["name"] or f"place-{next_id}"), taken_slugs),
        )
        next_id += 1
        known_osm.add(osm_id)
        records.append(rec)

    if records:
        gdf = gpd.GeoDataFrame(records, geometry="geometry", crs="EPSG:4326")
        gdf["last_checked"] = pd.to_datetime(gdf["last_checked"], errors="coerce")
        gdf["place_id"] = gdf["place_id"].astype("int32")
        gdf["osm_id"] = gdf["osm_id"].astype("int64")
        pyogrio.write_dataframe(gdf, GPKG_PATH, layer=LAYER, append=True)

    unresolved = fill_countries(GPKG_PATH)

    print(f"\nנכנסו {len(records)} מקומות לשכבה {LAYER}.")
    if unresolved:
        print(f"לא נקבעה מדינה ({len(unresolved)}), להשלים country ידנית: {', '.join(unresolved)}")
    if skipped_dupes:
        print(f"דולגו {len(skipped_dupes)} כפילויות (osm_id קיים): {', '.join(map(str, skipped_dupes))}")

    if broken:
        print(f"\nשורות שבורות ({len(broken)}), לא יובאו. מומלץ לייצא מחדש מ-QGIS עם מרכאות:")
        for line_no, row, n in broken:
            name = row[header.index("name")] if "name" in header and len(row) > header.index("name") else row[:4]
            print(f"  שורה {line_no}: {name} ({n} עמודות במקום {len(header)})")

    no_city = [r["name"] for r in records if not r["addr_city"]]
    if no_city:
        print(f"\nבלי addr_city ({len(no_city)}), להשלים ידנית ב-QGIS:")
        for n in no_city:
            print(f"  {n}")

    hours = {r["opening_hours"] for r in records if r["opening_hours"]}
    errors = check_hours(sorted(hours))
    if errors is None:
        print("\nבדיקת שעות לא הורצה (נדרשים node ו-npm i opening_hours). admin-check.html בודק אותן בדפדפן.")
    else:
        bad = {v: r["error"] for v, r in errors.items() if r["error"]}
        warned = [v for v, r in errors.items() if r["warnings"]]
        print(f"\nבדיקת שעות: {len(hours) - len(bad)} תקינים, {len(bad)} לא תקינים, {len(warned)} עם אזהרות")
        for v, e in bad.items():
            print(f"  שגיאה '{v}': {e}")
        for v in warned:
            print(f"  אזהרה '{v}' (פירוט ב-admin-check.html)")
    missing_hours = [r["name"] for r in records if not r["opening_hours"]]
    if missing_hours:
        print(f"בלי opening_hours ({len(missing_hours)}): {', '.join(missing_hours)}")

    print("\nתזכורת: OSM לא מסמן מי מגיש חומוס. כל מקום צריך אימות ידני, score ו-serves_hummus לפני פרסום.")


if __name__ == "__main__":
    main()
