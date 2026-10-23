"""יוצר tests/fixture.gpkg: עותק של הנתונים עם ציונים, מנות, כשרות ותמונות, לבדיקות Playwright."""
import shutil
import sqlite3
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "fixture.gpkg"
shutil.copy(ROOT / "data" / "hummus_app.gpkg", OUT)

con = sqlite3.connect(OUT)
for fn in ("ST_IsEmpty", "ST_MinX", "ST_MaxX", "ST_MinY", "ST_MaxY"):
    con.create_function(fn, 1, lambda g: 0)
rows = {
    # slug: (score, hummus, ful, mushrooms, vegan, kosher, kashrut_type, kashrut_body, note, tagline, start_year, dishes_other, name_he)
    "kafka-hummus-cafe": (4.6, 1, 1, 1, "yes", None, None, None, "Silky, warm and generous with the tahini.", "just off the Old Town Square", 2019, "Shakshuka; Sabich", None),
    "mizlala": (4.2, 1, 0, 0, "only", "yes", "private", "Chabad Prague", "The best Israeli hummus in Prague.", None, None, None, "מזללה"),
    "falafelo": (3.8, 1, 1, 0, "only", None, None, None, None, None, None, None, None),
    "sayf": (3.1, 1, 0, 0, None, None, None, None, None, None, None, None, None),
    "fenix-lounge-restaurace": (2.9, 1, 0, 0, None, None, None, None, None, None, None, None, None),
    "dobra-cajovna": (4.0, 1, 1, 0, "yes", None, None, None, None, None, None, None, None),
    "el-emir": (3.5, 1, 0, 0, None, None, None, None, None, None, None, None, None),
}
for slug, (score, h, f, m, vegan, kosher, ktype, kbody, note, tagline, year, other, name_he) in rows.items():
    con.execute(
        """UPDATE hummus_places SET score=?, serves_hummus=?, serves_ful=?, serves_mushrooms=?, diet_vegan=?,
           diet_kosher=?, kashrut_type=?, kashrut_body=?, reviewer_note=?, tagline=?, start_year=?, dishes_other=?,
           name_he=?, addr_neighbourhood=CASE WHEN slug='kafka-hummus-cafe' THEN 'Staré Město' END WHERE slug=?""",
        (score, h, f, m, vegan, kosher, ktype, kbody, note, tagline, year, other, name_he, slug),
    )
# מקום עם שעות לא תקינות, ומקום סגור (status=closed, מוסתר מהאתר)
con.execute("UPDATE hummus_places SET opening_hours='sometimes', score=3.0, serves_hummus=1 WHERE slug='safir'")
con.execute("UPDATE hummus_places SET status='closed' WHERE slug='leyaly'")
con.execute("UPDATE hummus_places SET instagram='@kafkahummus', phone='+420 123 456 789', website='kafkahummus.cz', addr_city='Praha' WHERE slug='kafka-hummus-cafe'")
kafka_id = con.execute("SELECT place_id FROM hummus_places WHERE slug='kafka-hummus-cafe'").fetchone()[0]
con.executemany(
    "INSERT INTO place_photos (photo_id, place_id, url, is_main, sort_order, caption, credit) VALUES (?,?,?,?,?,?,?)",
    [(1, kafka_id, "test-kafka-1.jpg", 1, 1, "Hummus plate", "Test photo"), (2, kafka_id, "test-kafka-2.jpg", 0, 2, None, None)],
)
con.commit()
con.close()

photos = ROOT / "tests" / "photos"
photos.mkdir(exist_ok=True)
for i, color in ((1, (214, 170, 110)), (2, (190, 120, 70))):
    img = Image.new("RGB", (800, 560), color)
    ImageDraw.Draw(img).ellipse((200, 120, 600, 440), fill=(240, 220, 180))
    img.save(photos / f"test-kafka-{i}.jpg", quality=80)
print(f"fixture ready: {OUT}")

# עותק במצב WAL (כמו קובץ ש-QGIS שמר ולא סגר), לבדיקה שהאתר קורא גם אותו
wal = ROOT / "tests" / "fixture-wal.gpkg"
shutil.copy(OUT, wal)
with sqlite3.connect(wal) as c:
    c.execute("PRAGMA journal_mode=WAL")
assert wal.read_bytes()[18:20] == b"\x02\x02"
print(f"WAL fixture ready: {wal}")
