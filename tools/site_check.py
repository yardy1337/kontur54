"""
Проверка сайтов стройкомпаний: находит тех, у кого слабый сайт.

Запуск (нужен только Python 3, без установки библиотек):
    python site_check.py companies.csv   (или companies.json)

companies.csv — выгрузка парсера. Скрипт сам находит колонки по названию:
название (name), сайт (site / url / website), телефон, город, рейтинг, отзывы.
Результат — report.csv рядом с файлом (открывается в Excel), отсортирован:
сверху самые перспективные компании.
"""
import csv
import json
import re
import ssl
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

TIMEOUT = 15
UA = ("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36")
YEAR = date.today().year

COLS = {
    "name": ["name", "название", "компания", "организация", "title"],
    "site": ["site", "сайт", "url", "website", "web", "веб-сайт", "сайты"],
    "phone": ["phone", "телефон", "телефоны", "тел"],
    "city": ["city", "город"],
    "rating": ["rating", "рейтинг", "оценка"],
    "reviews": ["reviews", "отзывы", "отзывов", "кол-во отзывов", "количество отзывов"],
}
SOCIAL = re.compile(r"(vk\.com|vkontakte|instagram|ok\.ru|avito\.ru|t\.me|wa\.me|2gis|yandex\.ru/maps|youtube)", re.I)
BUILDERS_OLD = re.compile(r"(ucoz|narod\.ru|jimdo|nethouse|umi\.ru|a5\.ru|1c-umi|setup\.ru)", re.I)


def find_col(header, key):
    low = [h.strip().lower() for h in header]
    for variant in COLS[key]:
        for i, h in enumerate(low):
            if h == variant or h.startswith(variant):
                return i
    return None


def flatten(obj, prefix=""):
    """{"contacts": {"site": ...}} → {"contacts.site": ...}; списки склеиваются через пробел."""
    out = {}
    for k, v in obj.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            out.update(flatten(v, key + "."))
        elif isinstance(v, list):
            out[key] = " ".join(str(x if not isinstance(x, dict) else " ".join(map(str, x.values()))) for x in v)
        else:
            out[key] = "" if v is None else str(v)
    return out


def from_2gis(x):
    """Запись 2ГИС: сайт и телефоны лежат в contact_groups, отзывы — в reviews."""
    c = {}
    for g in x.get("contact_groups") or []:
        for ct in g.get("contacts", []):
            c.setdefault(ct.get("type"), []).append(ct.get("url") or ct.get("value") or ct.get("text") or "")
    sites = [s for s in c.get("website", []) if s and not re.search(r"(jivo\.chat|max\.ru|t\.me|wa\.me|vk\.com)", s)]
    r = x.get("reviews") or {}
    city = next((a.get("name", "") for a in x.get("adm_div", []) if a.get("type") == "city"), "")
    return {"name": x.get("name", ""), "site": " ".join(sites), "phone": (c.get("phone") or [""])[0], "city": city,
            "rating": str(r.get("general_rating") or ""), "reviews": str(r.get("general_review_count") or "")}


def read_json(path):
    data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if isinstance(data, dict):  # {"items": [...]} или {"data": [...]}
        data = next((v for v in data.values() if isinstance(v, list)), [data])
    if data and isinstance(data[0], dict) and "contact_groups" in data[0]:
        return [from_2gis(x) for x in data if isinstance(x, dict)]
    flat = [flatten(x) for x in data if isinstance(x, dict)]
    keys = list(dict.fromkeys(k for f in flat for k in f))
    # колонку ищем по последней части ключа: "contacts.website" → "website"
    header = [k.split(".")[-1] for k in keys]
    idx = {k: find_col(header, k) for k in COLS}
    if idx["name"] is None:
        sys.exit("Не нашёл поле с названием компании (name / название).")
    return [{k: (f.get(keys[idx[k]], "").strip() if idx[k] is not None else "") for k in COLS} for f in flat]


def read_rows(path):
    if str(path).lower().endswith(".json"):
        return read_json(path)
    raw = Path(path).read_bytes()
    for enc in ("utf-8-sig", "cp1251"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    dialect = csv.Sniffer().sniff(text[:5000], delimiters=",;\t")
    rows = list(csv.reader(text.splitlines(), dialect))
    header, body = rows[0], [r for r in rows[1:] if any(c.strip() for c in r)]
    idx = {k: find_col(header, k) for k in COLS}
    if idx["name"] is None:
        sys.exit("Не нашёл колонку с названием компании. Назовите её «Название».")
    get = lambda r, k: (r[idx[k]].strip() if idx[k] is not None and idx[k] < len(r) else "")
    return [{k: get(r, k) for k in COLS} for r in body]


def first_site(value):
    """Из ячейки с несколькими ссылками берём первую, которая не соцсеть."""
    for part in re.split(r"[\s,;|]+", value):
        part = part.strip()
        if part and "." in part and not SOCIAL.search(part):
            return part if part.startswith("http") else "http://" + part
    return ""


def fetch(url):
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ru"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as r:
            body = r.read(3_000_000)
            ctype = r.headers.get("Content-Type", "")
            final = r.geturl()
    except ssl.SSLError:
        # битый сертификат — тоже сигнал; пробуем без проверки, только чтобы прочитать страницу
        ctx = ssl._create_unverified_context()
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as r:
            body = r.read(3_000_000)
            ctype = r.headers.get("Content-Type", "")
            final = r.geturl()
        ctype += ";badcert"
    secs = time.time() - t0
    m = re.search(r"charset=([\w-]+)", ctype) or re.search(rb'charset=["\']?([\w-]+)', body[:3000])
    enc = (m.group(1).decode() if isinstance(m.group(1), bytes) else m.group(1)) if m else "utf-8"
    try:
        html = body.decode(enc, errors="replace")
    except LookupError:
        html = body.decode("utf-8", errors="replace")
    return html, final, secs, len(body), enc.lower(), "badcert" in ctype


def check(row):
    res = dict(row)
    url = first_site(row["site"])
    flags = []
    if not url:
        res.update(status="нет сайта", score=6, flags="нет своего сайта", final_url="")
        return res
    try:
        html, final, secs, size, enc, badcert = fetch(url)
    except Exception as e:
        res.update(status="не открывается", score=6, flags=f"сайт не открывается ({type(e).__name__})", final_url=url)
        return res
    low = html.lower()
    score = 0
    if not final.startswith("https://") or badcert:
        score += 1; flags.append("нет https или битый сертификат")
    if 'name="viewport"' not in low and "name='viewport'" not in low and "name=viewport" not in low:
        score += 2; flags.append("нет мобильной версии")
    years = [int(y) for y in re.findall(r"(?:©|&copy;|copyright)\D{0,15}(?:20\d\d\s*[-–—]\s*)?(20\d\d)", low)]
    if years and max(years) <= YEAR - 3:
        score += 2; flags.append(f"копирайт {max(years)} — сайт заброшен")
    if BUILDERS_OLD.search(low) or BUILDERS_OLD.search(final):
        score += 2; flags.append("старый конструктор (uCoz/Narod и т. п.)")
    if enc in ("windows-1251", "cp1251"):
        score += 1; flags.append("кодировка windows-1251 — старая вёрстка")
    if low.count("<table") >= 5 or "<marquee" in low or ".swf" in low or "<font" in low:
        score += 1; flags.append("вёрстка таблицами/устаревшие теги")
    if not re.search(r"(₽|руб\.|руб\b|рублей|р\./м)", low):
        score += 1; flags.append("нет цен")
    if not re.search(r"(калькулятор|рассчитать стоимость|расчёт стоимости|расчет стоимости|квиз)", low):
        score += 1; flags.append("нет калькулятора")
    if not re.search(r"(wa\.me|whatsapp|t\.me/|telegram)", low):
        score += 1; flags.append("нет WhatsApp/Telegram")
    if "<form" not in low:
        score += 1; flags.append("нет формы заявки")
    if not re.search(r"(портфолио|наши объекты|наши работы|реализованные|построенные|галерея)", low):
        score += 1; flags.append("нет раздела с объектами")
    if secs > 4:
        score += 1; flags.append(f"грузится {secs:.1f} с")
    if size < 6000:
        score += 1; flags.append("почти пустая страница")
    res.update(status="ok", score=score, flags="; ".join(flags), final_url=final)
    return res


def money(row):
    """Признаки, что у компании есть деньги: отзывы и рейтинг из выгрузки."""
    n = re.sub(r"\D", "", row.get("reviews", "") or "")
    reviews = int(n) if n else 0
    pts = 2 if reviews >= 50 else 1 if reviews >= 20 else 0
    try:
        if float((row.get("rating") or "0").replace(",", ".")) >= 4.5:
            pts += 1
    except ValueError:
        pass
    return pts


def main():
    if len(sys.argv) < 2:
        sys.exit("Укажите файл: python site_check.py companies.csv")
    src = Path(sys.argv[1])
    rows = read_rows(src)
    print(f"Компаний в файле: {len(rows)}. Проверяю сайты…")
    done = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for i, r in enumerate(pool.map(check, rows), 1):
            r["money"] = money(r)
            r["total"] = r["score"] + r["money"]
            done.append(r)
            print(f"[{i}/{len(rows)}] {r['name'][:40]:40} балл {r['total']:>2}  {r['status']}")
    done.sort(key=lambda r: r["total"], reverse=True)
    out = src.with_name("report.csv")
    cols = ["total", "score", "money", "name", "city", "phone", "site", "final_url", "rating", "reviews", "status", "flags"]
    with out.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=cols, delimiter=";", extrasaction="ignore")
        w.writeheader()
        w.writerows(done)
    hot = sum(1 for r in done if r["total"] >= 8)
    print(f"\nГотово: {out}\nГорячих (8+ баллов): {hot}. Пришлите report.csv в чат.")


if __name__ == "__main__":
    main()
