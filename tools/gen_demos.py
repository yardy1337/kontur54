"""
Генератор демо-сайтов для компаний из трекера.

    python gen_demos.py <папка_с_записями_трекера_glob> <выгрузки_2гис...> --out <репозиторий>

Для каждой компании создаёт папку <slug>/ с index.html (оболочка шаблона)
и config.js (данные компании + тексты сегмента). Движок общий: engine/.
Реальные данные берутся из 2ГИС: название, город, телефон, мессенджеры,
рейтинг, отзывы, рубрики, рекламный слоган компании. Цены и сроки —
примерные по сегменту и городу, это прямо сказано на странице.
"""
import glob
import json
import re
import sys
from pathlib import Path

CITY_IN = {"Томск": "Томске", "Новосибирск": "Новосибирске", "Омск": "Омске", "Иркутск": "Иркутске",
           "Красноярск": "Красноярске", "Барнаул": "Барнауле", "Кемерово": "Кемерово", "Новокузнецк": "Новокузнецке"}
REGION = {"Томск": "Томской области", "Новосибирск": "Новосибирской области", "Омск": "Омской области",
          "Иркутск": "Иркутской области", "Красноярск": "Красноярском крае", "Барнаул": "Алтайском крае",
          "Кемерово": "Кемеровской области", "Новокузнецк": "Кемеровской области"}
REGION_NOM = {"Томск": "Томская область", "Новосибирск": "Новосибирская область", "Омск": "Омская область",
              "Иркутск": "Иркутская область", "Красноярск": "Красноярский край", "Барнаул": "Алтайский край",
              "Кемерово": "Кемеровская область", "Новокузнецк": "Кемеровская область"}
PRICE_K = {"Новосибирск": 1.08, "Иркутск": 1.08, "Красноярск": 1.08, "Томск": 1.0, "Омск": 0.95, "Барнаул": 0.95}

TR = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
              "a b v g d e e zh z i y k l m n o p r s t u f h ts ch sh sch - y - e yu ya".split()))


SLUGS = {"Новосибирская домостроительная компания": "ndk", "Томская производственная компания Профиль": "profil-tomsk",
         "Строительная компания брусовых бань": "brusovye-bani-omsk", "Компания Ю-Три Центр": "yutri-tsentr"}


def slugify(name):
    if name in SLUGS:
        return SLUGS[name]
    s = "".join(TR.get(c, c) for c in name.lower()).replace("-", "")
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s[:40] or "company"


def rub(n):
    return f"{int(round(n, -3 if n >= 100000 else -2)):,}".replace(",", " ")


def has(text, *words):
    return any(w in text for w in words)


def clean_slogan(t):
    """Рекламный слоган компании из 2ГИС; акции со сроками и промокоды не берём — устаревают."""
    if not t:
        return ""
    if re.search(r"(до \d{1,2}\.\d{1,2}|распродаж|промокод|скидк|подар|акци|сертификат|^продажа)", t, re.I):
        return ""
    t = t.replace("*", "").strip().rstrip("!").rstrip(".")
    return t[0].upper() + t[1:] + "."


# ---------- Фирменный цвет: подгоняем под контраст WCAG AA ----------
import colorsys


def _lum(rgb):
    c = [x / 255 for x in rgb]
    c = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def _cr(a, b):
    la, lb = _lum(a), _lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def _hex(rgb):
    return "#%02x%02x%02x" % tuple(int(round(max(0, min(255, v)))) for v in rgb)


def _rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _shift(rgb, dl):
    h, l, s_ = colorsys.rgb_to_hls(*[x / 255 for x in rgb])
    return tuple(v * 255 for v in colorsys.hls_to_rgb(h, max(0, min(1, l + dl)), s_))


def _until(rgb, bg, target, step):
    for _ in range(60):
        if _cr(rgb, bg) >= target:
            return rgb
        rgb = _shift(rgb, step)
    return rgb


def brand_theme(color):
    """Фирменный цвет из 2ГИС → токены светлой и тёмной темы. Серые/чёрные/белые не берём."""
    if not color or not re.match(r"^#[0-9a-fA-F]{6}$", color):
        return None
    rgb = _rgb(color)
    h, l, sat = colorsys.rgb_to_hls(*[x / 255 for x in rgb])
    if sat < 0.3 or l < 0.12 or l > 0.92:
        return None
    WHITE, INK = (255, 255, 255), (17, 17, 17)
    BG_L, BG_D, EL_D = _rgb("#f4f6f7"), _rgb("#0b1216"), _rgb("#19242b")
    # светлая тема: кнопка — фирменный цвет с белым или тёмным текстом
    if _cr(WHITE, rgb) >= 4.5:
        fill, on = rgb, WHITE
    elif _cr(INK, rgb) >= 4.5:
        fill, on = rgb, INK
    else:
        fill, on = _until(rgb, WHITE, 4.5, -0.02), WHITE
    dark_on = on == INK
    light = {"--c-accent": _hex(_until(rgb, BG_L, 4.6, -0.02)),
             "--c-accent-fill": _hex(fill),
             "--c-accent-hover": _hex(_shift(fill, 0.06 if dark_on else -0.06)),
             "--c-accent-active": _hex(_shift(fill, 0.12 if dark_on else -0.12)),
             "--c-on-accent": _hex(on),
             "--c-accent-tint": _hex(tuple(255 - (255 - v) * 0.1 for v in rgb))}
    # тёмная тема: светлее, тёмный текст на кнопке
    dfill = _until(rgb, BG_D, 4.5, 0.02)
    don = INK if _cr(INK, dfill) >= 4.5 else WHITE
    acc_d = _until(rgb, EL_D, 4.6, 0.02)
    dark = {"--c-accent": _hex(acc_d), "--c-accent-fill": _hex(dfill),
            "--c-accent-hover": _hex(_shift(dfill, 0.06)), "--c-accent-active": _hex(_shift(dfill, -0.06)),
            "--c-on-accent": _hex(don), "--c-accent-tint": _hex(tuple(v * 0.18 for v in rgb))}
    return {"light": light, "dark": dark}


# ---------- Сегменты ----------

def house_materials(text, k):
    m = []
    if has(text, "каркас"):
        m.append({"id": "frame", "name": "Каркас", "shell": 28000 * k, "turn": 50000 * k, "weeks": [8, 14]})
    if has(text, "брус", "бревн", "дерев", "сруб"):
        m.append({"id": "timber", "name": "Брус", "shell": 34000 * k, "turn": 58000 * k, "weeks": [10, 16]})
    if has(text, "газобетон", "пеноблок", "камн", "камен", "кирпич"):
        m.append({"id": "gas", "name": "Газобетон", "shell": 33000 * k, "turn": 56000 * k, "weeks": [12, 18]})
    if has(text, "модульн"):
        m.append({"id": "modul", "name": "Модульный", "shell": 30000 * k, "turn": 47000 * k, "weeks": [4, 8]})
    if not m:
        m = [{"id": "frame", "name": "Каркас", "shell": 28000 * k, "turn": 50000 * k, "weeks": [8, 14]},
             {"id": "gas", "name": "Газобетон", "shell": 33000 * k, "turn": 56000 * k, "weeks": [12, 18]}]
    for x in m:
        x["shell"], x["turn"] = round(x["shell"], -2), round(x["turn"], -2)
    return m


def seg_houses(c, text, k):
    ipoteka = has(text, "ипотек")
    modul = has(text, "модульн")
    timber = has(text, "брус", "бревн")
    wood = has(text, "деревян")
    dacha = has(text, "бытовк", "хоз.блок", "хозблок")
    if dacha:
        title = f"Дачные домики, бани и хозблоки в {c['in']}"
    elif modul:
        title = f"Модульные дома и бани в {c['in']} <em>под ключ</em>"
    elif timber:
        title = f"Дома и бани из бруса в {c['in']} <em>под ключ</em>"
    elif wood:
        title = f"Деревянные дома и бани в {c['in']} <em>под ключ</em>"
    else:
        title = f"Строим дома в {c['in']} <em>{'в ипотеку' if ipoteka else 'под ключ'}</em>"
    mats = house_materials(text, k)
    frame_text = {"frame": "Каркас из сухой доски камерной сушки, шаг стоек 600 мм.",
                  "timber": "Профилированный брус заводской сушки: стены не ведёт, щелей не остаётся.",
                  "gas": "Коробка из газобетона: тёплая, долговечная и без усадки.",
                  "modul": "Модули собираем на производстве, на участке ставим за один-два дня."}[mats[0]["id"]]
    return dict(
        kind="Дома под ключ", title=title, label="Что строим",
        lead_tail=f"Строим в {c['in']} и {REGION[c['city']]}" + (", в том числе по ипотеке." if ipoteka else ". Считаем смету бесплатно."),
        stages=[
            ("Фундамент", "Фундамент под ваш участок", "1–2 недели", "Тип фундамента подбираем после осмотра участка и грунта: плита, лента или сваи."),
            ("Каркас", "Стены и несущая конструкция", "3–4 недели", frame_text),
            ("Стены", "Утепление, обшивка и окна", "2–3 недели", "Утепление под сибирские морозы, ветро- и пароизоляция, энергосберегающие окна."),
            ("Кровля", "Кровля", "1–2 недели", "Кровля с утеплением и водостоком, снеговая нагрузка рассчитана для Сибири."),
            ("Под ключ", "Под ключ", "6–8 недель", "Фасад, отопление, вода, электрика и отделка. Сдаём дом, в который можно заезжать."),
        ],
        calc=dict(title="Сколько стоит ваш дом", lead="Примерная цена для типового проекта. Точную смету посчитаем после осмотра участка.",
                  area={"min": 40, "max": 300, "step": 5, "value": 120}, materials=mats, twoFloorDiscount=0.06,
                  include={"shell": ["Фундамент", "Стены с утеплением", "Кровля", "Окна и входная дверь"],
                           "turn": ["Всё из «тёплого контура»", "Фасад и внутренняя отделка", "Отопление, вода, канализация", "Электрика"]}),
        works=[("Дом под ключ", "house"), ("Баня", "bath"), ("Хозпостройка", "warehouse")],
        lead=dict(title="Посчитаем ваш дом бесплатно", types=["Дом под ключ"] + (["Дом в ипотеку"] if ipoteka else []) + ["Баня", "Фундамент или кровля", "Другое"],
                  placeholder=f"Участок под {c['city']}ом, хотим дом около 120 м²" if c["city"] in ("Омск", "Томск", "Иркутск") else "Участок за городом, хотим дом около 120 м²",
                  bullets=["Осмотр участка", "Подбор проекта под бюджет", "Смета с фиксированной ценой"] + (["Помощь с ипотекой"] if ipoteka else [])),
        house={"wall": "#7a5232", "roof": "#2a2522", "trim": "#c48a4a"} if timber else None,
    )


def seg_baths(c, text, k):
    cedar = has(text, "кедр")
    barrel = has(text, "бочк")
    modul = has(text, "модульн")
    title = (f"Кедровые бани в {c['in']} <em>под ключ</em>" if cedar else
             f"Модульные бани в {c['in']} <em>под ключ</em>" if modul else
             f"Бани в {c['in']} <em>для сибирской зимы</em>")
    mats = []
    if has(text, "брус", "бревн", "сруб") or not (cedar or modul or has(text, "каркас")):
        mats.append({"id": "timber", "name": "Брус", "shell": 30000 * k, "turn": 55000 * k, "weeks": [2, 4]})
    if has(text, "каркас"):
        mats.append({"id": "frame", "name": "Каркас", "shell": 26000 * k, "turn": 48000 * k, "weeks": [2, 4]})
    if cedar or barrel:
        mats.append({"id": "cedar", "name": "Кедр", "shell": 25000 * k, "turn": 45000 * k, "weeks": [1, 2]})
    if modul and not cedar:
        mats.append({"id": "modul", "name": "Модульная", "shell": 35000 * k, "turn": 60000 * k, "weeks": [1, 2]})
    for x in mats:
        x["shell"], x["turn"] = round(x["shell"], -2), round(x["turn"], -2)
    return dict(
        kind="Бани под ключ", title=title, label="Что строим",
        lead_tail=f"Строим в {c['in']} и {REGION[c['city']]}. Парная, мойка и комната отдыха — по вашему проекту.",
        stages=[
            ("Фундамент", "Фундамент", "3–5 дней", "Чаще всего ставим баню на винтовые сваи: быстро и надёжно на любом грунте."),
            ("Стены", "Сруб или каркас", "1–2 недели", "Брус заводской сушки или каркас с утеплением — под ваш бюджет."),
            ("Утепление", "Утепление и окна", "3–5 дней", "Утепляем парную с фольгированной пароизоляцией, чтобы баня грелась быстро и держала жар."),
            ("Кровля", "Кровля", "3–5 дней", "Кровля с утеплением и водостоком, снеговая нагрузка рассчитана для Сибири."),
            ("Под ключ", "Печь и отделка", "1–2 недели", "Печь, дымоход, полки из липы или осины, электрика и отделка комнаты отдыха."),
        ],
        calc=dict(title="Сколько стоит ваша баня", lead="Примерная цена для типовой бани. Точную смету посчитаем после осмотра участка.",
                  area={"min": 8, "max": 72, "step": 2, "value": 20 if (cedar or barrel or modul) else 30}, materials=mats, floors=False, areaLabel="Площадь бани",
                  kits=["Коробка", "Под ключ"], weeksDiv=[20, 12], termLabel="Срок",
                  include={"shell": ["Фундамент", "Стены", "Кровля", "Окна и двери"],
                           "turn": ["Всё из «коробки»", "Печь и дымоход", "Полки и отделка парной", "Электрика"]}),
        works=[("Баня", "bath"), ("Баня с террасой", "bath"), ("Гостевой дом", "house")],
        lead=dict(title="Посчитаем вашу баню бесплатно", types=["Баня под ключ", "Баня-коробка", "Гостевой дом", "Беседка или хозпостройка"],
                  placeholder="Баня 6×4 с парной и комнатой отдыха на даче", bullets=["Выезд на участок", "Проект под ваш бюджет", "Смета с фиксированной ценой"]),
        house={"wall": "#9a6a3e", "roof": "#2a2522", "trim": "#d0a066"},
    )


def seg_repair(c, text, k):
    design = has(text, "дизайн")
    commercial = has(text, "административ", "павильон", "торгов")
    title = (f"Строительство и ремонт помещений в {c['in']}" if commercial else f"Ремонт квартир в {c['in']} <em>под ключ</em>")
    return dict(
        kind="Ремонт под ключ", title=title, label="Услуги",
        lead_tail=f"Ремонтируем квартиры и дома в {c['in']}" + (" по дизайн-проекту." if design else ". Смету фиксируем в договоре."),
        stages=[
            ("Проект", "Замер и проект", "3–5 дней", "Замеряем помещение, составляем план и смету" + (", делаем дизайн-проект." if design else ".")),
            ("Черновые", "Черновые работы", "1–2 недели", "Демонтаж, перегородки, выравнивание стен и стяжка пола."),
            ("Инженерия", "Электрика и сантехника", "1–2 недели", "Разводка электрики, воды и канализации с гарантией."),
            ("Потолки", "Потолки и полы", "1 неделя", "Потолки, напольные покрытия, плитка в санузле."),
            ("Чистовые", "Чистовая отделка и сдача", "1–2 недели", "Покраска или обои, двери, свет и уборка. Сдаём квартиру, в которую можно заезжать."),
        ],
        calc=dict(title="Сколько стоит ваш ремонт", lead="Примерная цена за работы. Точную смету составим после замера.",
                  area={"min": 20, "max": 200, "step": 2, "value": 60}, floors=False, areaLabel="Площадь квартиры",
                  typeLabel="Вид ремонта", kitLabel="Что входит", kits=["Только работы", "Работы и материалы"], weeksDiv=[25, 15], termLabel="Срок",
                  materials=[{"id": "cosm", "name": "Косметический", "shell": round(4500 * k, -2), "turn": round(8000 * k, -2), "weeks": [1, 2]},
                             {"id": "cap", "name": "Капитальный", "shell": round(9000 * k, -2), "turn": round(16000 * k, -2), "weeks": [3, 4]},
                             {"id": "design", "name": "Дизайнерский", "shell": round(14000 * k, -2), "turn": round(25000 * k, -2), "weeks": [4, 6]}],
                  include={"shell": ["Демонтаж и черновые работы", "Электрика и сантехника", "Чистовая отделка", "Уборка после ремонта"],
                           "turn": ["Все работы", "Черновые и чистовые материалы", "Закупка и доставка", "Контроль сроков"]}),
        works=[("Квартира под ключ", "house"), ("Санузел", "house"), ("Коммерческое помещение", "warehouse")],
        lead=dict(title="Замер и смета бесплатно", types=["Ремонт квартиры", "Ремонт санузла", "Дизайн-проект", "Ремонт дома", "Коммерческое помещение"],
                  placeholder="Двухкомнатная квартира 54 м² в новостройке", bullets=["Бесплатный замер", "Смета за 1–2 дня", "Цена фиксируется в договоре"]),
        house=None,
    )


def seg_roof(c, text, k):
    found = has(text, "фундамент", "свай", "монолит")
    if found:
        title = f"Фундаменты в {c['in']} <em>на любом грунте</em>"
        mats = [{"id": "piles", "name": "Сваи", "shell": round(2500 * k, -2), "turn": round(4000 * k, -2), "weeks": [1, 1]},
                {"id": "strip", "name": "Лента", "shell": round(5000 * k, -2), "turn": round(8500 * k, -2), "weeks": [2, 3]},
                {"id": "slab", "name": "Плита", "shell": round(6000 * k, -2), "turn": round(9500 * k, -2), "weeks": [2, 3]}]
        calc = dict(title="Сколько стоит фундамент", lead="Примерная цена по площади дома. Точную посчитаем после осмотра участка.",
                    area={"min": 20, "max": 300, "step": 5, "value": 100}, floors=False, areaLabel="Площадь дома",
                    typeLabel="Тип фундамента", kitLabel="Что входит", kits=["Только работы", "Работы и материалы"], weeksDiv=[200, 150], termLabel="Срок",
                    materials=mats, include={"shell": ["Разметка и земляные работы", "Монтаж", "Контроль уровня"], "turn": ["Все работы", "Материалы", "Доставка", "Гарантия"]})
        types = ["Фундамент под дом", "Фундамент под баню", "Сваи под забор или веранду", "Другое"]
        stages_text = "Свайный, ленточный или плита — подбираем после осмотра грунта."
    else:
        title = f"Кровля и фасады в {c['in']} <em>под ключ</em>"
        mats = [{"id": "metal", "name": "Металлочерепица", "shell": round(1500 * k, -2), "turn": round(2800 * k, -2), "weeks": [1, 1]},
                {"id": "prof", "name": "Профнастил", "shell": round(1200 * k, -2), "turn": round(2400 * k, -2), "weeks": [1, 1]},
                {"id": "fold", "name": "Фальц", "shell": round(2200 * k, -2), "turn": round(3800 * k, -2), "weeks": [1, 2]}]
        calc = dict(title="Сколько стоит кровля", lead="Примерная цена за квадратный метр кровли. Точную посчитаем после замера.",
                    area={"min": 40, "max": 400, "step": 10, "value": 150}, floors=False, areaLabel="Площадь кровли",
                    typeLabel="Покрытие", kitLabel="Что входит", kits=["Монтаж", "Монтаж и материал"], weeksDiv=[150, 100], termLabel="Срок",
                    materials=mats, include={"shell": ["Демонтаж старой кровли", "Обрешётка", "Монтаж покрытия"], "turn": ["Все работы", "Покрытие и доборные элементы", "Водосток", "Доставка"]})
        types = ["Новая кровля", "Замена кровли", "Фасад", "Другое"]
        stages_text = "Подбираем фундамент после осмотра грунта."
    return dict(
        kind="Фундаменты и кровля", title=title, label="Услуги",
        lead_tail=f"Работаем в {c['in']} и {REGION[c['city']]}. Выезд на замер бесплатно.",
        stages=[("Фундамент", "Фундамент", "1–3 недели", stages_text),
                ("Каркас", "Несущая конструкция", "2–4 недели", "Стены и перекрытия по проекту."),
                ("Стены", "Утепление и обшивка", "2–3 недели", "Утепление, ветро- и пароизоляция, фасад."),
                ("Кровля", "Кровля", "1–2 недели", "Кровля с утеплением и водостоком, снеговая нагрузка рассчитана для Сибири."),
                ("Под ключ", "Сдача объекта", "по проекту", "Сдаём работу с гарантией и фотоотчётом.")],
        calc=calc, works=[("Объект", "house"), ("Объект", "warehouse"), ("Объект", "bath")],
        lead=dict(title="Замер и смета бесплатно", types=types, placeholder="Дом 10×10, нужна новая кровля" if not found else "Участок под дом 10×12, грунт глинистый",
                  bullets=["Бесплатный выезд", "Смета за 1–2 дня", "Гарантия на работы"]),
        house=None,
    )


def seg_paint(c, text, k):
    d = seg_roof(c, "кровля", k)
    d.update(kind="Покраска домов", title=f"Покраска домов и бань в {c['in']} <em>под ключ</em>",
             lead_tail=f"Шлифуем и красим деревянные дома, бани и фасады в {c['in']} и {REGION[c['city']]}.")
    d["calc"].update(title="Сколько стоит покраска", lead="Примерная цена за квадратный метр поверхности. Точную посчитаем после осмотра.",
                     areaLabel="Площадь поверхности", typeLabel="Работы", kits=["Только работы", "Работы и материалы"],
                     materials=[{"id": "paint", "name": "Покраска", "shell": round(400 * k, -2) or 400, "turn": round(700 * k, -2), "weeks": [1, 1]},
                                {"id": "sand", "name": "Шлифовка и покраска", "shell": round(900 * k, -2), "turn": round(1500 * k, -2), "weeks": [1, 2]}],
                     include={"shell": ["Подготовка поверхности", "Нанесение покрытия", "Уборка"], "turn": ["Все работы", "Краска и антисептик", "Доставка материалов"]})
    d["lead"].update(types=["Покраска дома", "Покраска бани", "Шлифовка", "Другое"], placeholder="Дом из бруса 9×9, нужна шлифовка и покраска")
    return d


SEGMENTS = {"Дома под ключ": seg_houses, "Бани": seg_baths, "Ремонт квартир": seg_repair,
            "Фундаменты и кровля": seg_roof, "Другое": seg_paint}

# Рубрики 2ГИС → строки услуг (название, описание, цена «от», единица)
SERVICES = [
    ("Строительство дач и коттеджей", "Дома под ключ", "Частные дома и коттеджи по индивидуальному проекту.", 45000, "₽/м²"),
    ("Строительство бань и саун", "Бани и сауны", "Бани под ключ с парной, мойкой и комнатой отдыха.", 600000, "₽"),
    ("Быстровозводимые здания", "Быстровозводимые здания", "Гаражи, мастерские, хозблоки и модульные постройки.", 12000, "₽/м²"),
    ("Кровельные работы", "Кровельные работы", "Новая кровля и замена старой.", 1500, "₽/м²"),
    ("Строительство фундамента", "Фундаменты", "Плита, лента или сваи — по результатам осмотра грунта.", 2500, "₽/м²"),
    ("Свайные работы", "Свайные фундаменты", "Винтовые и железобетонные сваи под дом, баню и забор.", 2500, "₽/м²"),
    ("Ремонт помещений", "Ремонт квартир", "Косметический и капитальный ремонт под ключ.", 4500, "₽/м²"),
    ("Ремонт зданий", "Ремонт домов и помещений", "Ремонт частных домов и коммерческих помещений.", 5000, "₽/м²"),
    ("Дизайн интерьеров", "Дизайн-проект", "Планировка, визуализация и подбор материалов.", 1500, "₽/м²"),
    ("Фасадные работы", "Фасадные работы", "Утепление и отделка фасадов.", 2500, "₽/м²"),
    ("Архитектурное проектирование", "Проектирование", "Архитектурный проект дома под ваш участок.", 800, "₽/м²"),
    ("Строительство гаражей", "Гаражи", "Гаражи и хозяйственные постройки.", 15000, "₽/м²"),
    ("Электромонтажные работы", "Электромонтаж", "Электрика в доме и квартире с гарантией.", 900, "₽/точка"),
    ("Внутренние системы отопления, водоснабжения, канализации", "Отопление и водоснабжение", "Котельная, тёплые полы, водоснабжение и канализация.", 120000, "₽"),
    ("Строительство бассейнов и аквапарков", "Бассейны", "Бассейны и купели для дома и бани.", 350000, "₽"),
    ("Печи и камины для помещений", "Печи и камины", "Подбор и монтаж печей для бани и дома.", 40000, "₽"),
    ("Лаки и краски", "Покраска домов", "Шлифовка и покраска деревянных домов и бань.", 400, "₽/м²"),
]


def services_for(rubrics, k, seg):
    out = []
    for key, title, text, price, unit in SERVICES:
        if key in rubrics:
            p = price * (k if unit != "₽/точка" else 1)
            out.append({"title": title, "text": text, "price": f"от {rub(p)} {unit}"})
    if len(out) < 3:  # дополняем сегментными строками, чтобы прайс не выглядел пустым
        extra = {"Бани": [("Беседки и хозпостройки", "Беседки, дровяники и хозблоки на участке.", 150000, "₽")],
                 "Ремонт квартир": [("Ремонт санузла", "Плитка, сантехника и инсталляции под ключ.", 120000, "₽")],
                 "Дома под ключ": [("Бани", "Бани на участке в одном стиле с домом.", 600000, "₽")]}.get(seg, [])
        extra += [("Выезд и смета", "Осмотр участка или объекта и подробная смета.", 0, "")]
        for t, tx, p, u in extra:
            if len(out) >= 4:
                break
            out.append({"title": t, "text": tx, "price": "бесплатно" if not p else f"от {rub(p * k)} {u}"})
    return out[:6]


def build(seed, raw):
    city = seed["city"]
    c = {"city": city, "in": CITY_IN.get(city, city)}
    rubrics = [r["name"] for r in raw.get("rubrics", [])]
    slogan_raw = (raw.get("ads") or {}).get("text") or ""
    text = " ".join([seed["name"], slogan_raw, " ".join(rubrics), seed.get("note", "")]).lower()
    k = PRICE_K.get(city, 1.0)
    seg = seed["segment"] if seed["segment"] in SEGMENTS else "Дома под ключ"
    d = SEGMENTS[seg](c, text, k)

    contacts = {}
    for g in raw.get("contact_groups") or []:
        for ct in g.get("contacts", []):
            contacts.setdefault(ct.get("type"), []).append(ct)
    phone_raw = (contacts.get("phone") or [{}])[0].get("value", "") or seed.get("contact", "")
    digits = re.sub(r"\D", "", phone_raw)
    phone = (f"+7 {digits[1:4]} {digits[4:7]}-{digits[7:9]}-{digits[9:11]}" if len(digits) == 11 else phone_raw) or "+7"
    wa = f"https://wa.me/{digits}" if "whatsapp" in contacts and len(digits) == 11 and digits[1] == "9" else ""
    rating, reviews = (raw.get("reviews") or {}).get("general_rating"), (raw.get("reviews") or {}).get("general_review_count") or 0

    facts = []
    if rating and reviews >= 3:
        facts.append({"value": f"{str(rating).replace('.', ',')} ★", "text": f"рейтинг в 2ГИС по {reviews} отзывам клиентов"})
    facts.append({"value": city, "text": f"работаем в городе и {REGION[city]}"})
    facts.append({"value": "Смета", "text": "считаем бесплатно, цену фиксируем в договоре"})
    facts.append({"value": "Под ключ", "text": "одна команда ведёт объект от проекта до сдачи"})
    if wa:
        facts.append({"value": "WhatsApp", "text": "отвечаем на вопросы в мессенджере"})
    facts = facts[:4]

    slogan = clean_slogan(slogan_raw)
    if slogan:  # слоган компании первым; хвост сегмента — только то, чего в слогане ещё нет
        tail = re.sub(r",? ?в том числе по ипотеке", "", d["lead_tail"]) if "ипотек" in slogan.lower() else d["lead_tail"]
        if "смет" in slogan.lower():
            tail = tail.replace(" Считаем смету бесплатно.", "")
        if city.lower()[:5] in slogan.lower():
            tail = re.sub(r"^(Строим|Работаем|Ремонтируем[^.]*?) в [^.,]*? и [^.,]*?(области|крае)[.,]?\s*", "", tail)
        lead = (slogan + " " + tail).strip()
    else:
        lead = d["lead_tail"]
    name = seed["name"]
    tg = next((ct.get("url") for g in raw.get("contact_groups") or [] for ct in g.get("contacts", [])
               if (ct.get("url") or "").startswith("http://t.me") or (ct.get("url") or "").startswith("https://t.me")), "")
    secondary = ({"text": "Написать в WhatsApp", "href": wa} if wa else
                 {"text": "Написать в Telegram", "href": tg.replace("http://", "https://")} if tg else
                 {"text": "Позвонить", "href": "tel:+" + digits} if digits else {"text": "Оставить заявку", "href": "#lead"})

    cfg = {
        "company": {"name": name, "tagline": f"{d['kind']} · {city} и область", "phone": phone,
                    "cities": [city, REGION_NOM[city]],
                    "footerNote": "Концепт сайта от Yardy Project · yardyproject.ru",
                    "demoNote": f"Концепт сайта для «{name}» от студии Yardy Project. Цены и тексты примерные, финальные согласуем с вами."},
        "hero": {"title": d["title"], "lead": lead,
                 "primary": {"text": "Рассчитать стоимость", "short": "Рассчитать", "href": "#calc"}, "secondary": secondary},
        "stages": [{"name": n, "title": t, "term": tm, "text": tx} for n, t, tm, tx in d["stages"]],
        "facts": facts,
        "services": {"label": d["label"], "title": f"{d['label']} в {c['in']}",
                     "lead": "Работаем по договору, отправляем фотоотчёты по каждому этапу.",
                     "items": services_for(rubrics, k, seg)},
        "calc": dict(d["calc"], note="Цены в концепте примерные. На вашем сайте здесь будут ваши расценки."),
        "works": {"title": "Наши работы", "lead": "Здесь будут фото ваших объектов — из 2ГИС, соцсетей или со стройки.",
                  "items": [{"title": t, "icon": i, "tag": "Ваше фото", "specs": [["Город", city], ["Срок", "—"], ["Площадь", "—"]]} for t, i in d["works"]]},
        "lead": dict(d["lead"], lead="Оставьте телефон — перезвоним и ответим на вопросы.",
                     success="Заявка принята. Это концепт, поэтому заявка никуда не отправлена. На вашем сайте она придёт в WhatsApp или Telegram."),
    }
    opts = (raw.get("ads") or {}).get("options") or {}
    logo = (opts.get("logo") or {}).get("img_url")
    if logo:
        cfg["company"]["logo"] = logo
    theme = brand_theme(opts.get("color"))
    if theme:
        cfg["theme"] = theme
    album = next((e for e in raw.get("external_content") or [] if e.get("type") == "photo_album" and e.get("main_photo_url")), None)
    if album:  # реальное фото компании из 2ГИС — первой карточкой в «Наших работах»
        cfg["works"]["items"][0] = {"title": "Фото из карточки 2ГИС", "icon": d["works"][0][1], "tag": "Фото компании",
                                    "photo": album["main_photo_url"],
                                    "specs": [["Город", city], ["Фото в 2ГИС", str(album.get("count") or "—")], ["Рейтинг", f"{rating or '—'} ★"]]}
        cfg["works"]["lead"] = "Первое фото — из вашей карточки в 2ГИС. Остальные места — под ваши объекты."
    a, = [album["main_photo_url"] if album else ""]
    cfg["_og_image"] = a
    if d.get("house"):
        cfg["house"] = d["house"]
    page_title = f"{name} — {re.sub('<[^>]+>', '', d['title'])}"
    return cfg, page_title, cfg["hero"]["lead"]


def main():
    args = sys.argv[1:]
    out = Path(args[args.index("--out") + 1])
    seeds_glob, raws = args[0], [a for a in args[1:args.index("--out")]]
    raw = {}
    for f in raws:
        for x in json.load(open(f, encoding="utf-8-sig")):
            raw[x["id"].split("_")[0]] = x
    template = (out / "kontur54" / "index.html").read_text(encoding="utf-8")
    used, index = set(), []
    for f in sorted(glob.glob(seeds_glob)):
        seed = json.load(open(f, encoding="utf-8"))
        cfg, title, desc = build(seed, raw[seed["gisId"]])
        slug = slugify(seed["name"])
        while slug in used or slug in ("kontur54", "engine", "assets"):
            slug += "-" + seed["city"][:3].lower().translate(str.maketrans(dict(zip("томскнвиркуь", "tomsknvirku-"))))
        used.add(slug)
        d = out / slug
        d.mkdir(exist_ok=True)
        html = template
        html = re.sub(r"<title>.*?</title>", f"<title>{title}</title>", html)
        html = re.sub(r'<meta name="description" content="[^"]*">', f'<meta name="description" content="{desc.replace(chr(34), "")}">', html)
        html = re.sub(r'<meta property="og:title" content="[^"]*">', f'<meta property="og:title" content="{title.replace(chr(34), "")}">', html)
        og = cfg.pop("_og_image", "")
        if og:
            html = re.sub(r'<meta property="og:image" content="[^"]*">', f'<meta property="og:image" content="{og}">', html)
        html = re.sub(r'<meta property="og:description" content="[^"]*">', '<meta property="og:description" content="Концепт сайта от Yardy Project: 3D-сборка, калькулятор стоимости, заявки в мессенджер.">', html)
        # концепты не должны попадать в поиск по названию чужой компании
        html = html.replace("<title>", '<meta name="robots" content="noindex, nofollow">\n<title>', 1)
        (d / "index.html").write_text(html, encoding="utf-8")
        (d / "config.js").write_text(
            f"// Концепт для «{seed['name']}» ({seed['city']}). Сгенерирован tools/gen_demos.py из карточки 2ГИС.\n"
            f"// Цены и сроки — примерные. Правьте этот файл, движок общий: ../engine/\n"
            f"window.SITE = {json.dumps(cfg, ensure_ascii=False, indent=2)};\n", encoding="utf-8")
        index.append({"doc": Path(f).stem, "slug": slug, "name": seed["name"], "city": seed["city"], "segment": seed["segment"]})
    (Path(__file__).with_name("demos_index.json")).write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Создано демо: {len(index)}")


if __name__ == "__main__":
    main()
