/*
  Движок демо-сайта: собирает страницу из window.SITE (config.js),
  подключает калькулятор, форму и 3D-дом (engine/house3d.js).
*/
(function () {
  const S = window.SITE;
  const app = document.getElementById("app");
  if (!S || !app) return;

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const phoneHref = p => "tel:" + p.replace(/[^\d+]/g, "");

  /* ---------- Фирменный цвет компании (необязательно) → CSS-токены ---------- */
  // theme: { light: {"--c-accent": "#…", …}, dark: {…} } — значения уже проверены на контраст генератором
  if (S.theme && S.theme.light) {
    const decl = o => Object.entries(o).map(([k, v]) => `${k}:${v}`).join(";");
    const st = document.createElement("style");
    st.textContent = `:root{${decl(S.theme.light)}}` +
      (S.theme.dark ? `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${decl(S.theme.dark)}}}:root[data-theme="dark"]{${decl(S.theme.dark)}}` : "");
    document.head.appendChild(st);
  }

  /* ---------- Цвета дома из конфига (необязательно) → CSS-токены ---------- */
  // Все цвета живут в engine/site.css. Конфиг может только переопределить отделку дома.
  if (S.house) {
    for (const [k, v] of Object.entries(S.house)) document.documentElement.style.setProperty("--house-" + k, v);
  }

  const ICONS = {
    house: '<path d="M10 130h220"/><path d="M40 130V70l60-40 60 40v60"/><path d="M160 130V82h50v48"/><path d="M155 82h60"/><path d="M60 80h30v30H60zM110 85h30v45h-30z"/><path d="M75 80v30M60 95h30"/><path d="M172 95h26v20h-26z"/>',
    bath: '<path d="M10 130h220"/><path d="M50 130V75l70-35 70 35v55"/><path d="M50 85h140M50 95h140M50 105h140M50 115h140"/><path d="M100 130V100h28v30"/><path d="M150 55v-22h14v29"/><path d="M190 130v-25h30v25"/>',
    warehouse: '<path d="M10 130h220"/><path d="M25 130V60q95-40 190 0v70"/><path d="M25 60h190"/><path d="M60 60v70M100 60v70M140 60v70M180 60v70"/><path d="M85 130V95h70v35"/><path d="M85 105h70M85 115h70"/>'
  };
  const I = {
    pause: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" rx="1"/><rect x="9.5" y="2" width="3.5" height="12" rx="1"/></svg>',
    play: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.5v11a.7.7 0 0 0 1.05.6l9-5.5a.7.7 0 0 0 0-1.2l-9-5.5A.7.7 0 0 0 4 2.5z"/></svg>',
    replay: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M2.5 8a5.5 5.5 0 1 0 1.7-4"/><path d="M2.5 2v3.5H6"/></svg>',
    view: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5 14 5v6l-6 3.5L2 11V5z"/><path d="M2 5l6 3.5L14 5M8 8.5v6"/></svg>'
  };

  // палитры конструктора: пустое значение — цвет шаблона
  const FACADES = [["", "Как в проекте"], ["#e9e6df", "Светлый"], ["#3a4247", "Графит"], ["#3f5b4c", "Хвойный"], ["#2f4a63", "Синий"], ["#7a3b32", "Кирпичный"]];
  const ROOFS = [["", "Как в проекте"], ["#2b2f33", "Графит"], ["#5a3a28", "Шоколад"], ["#2f4f3a", "Зелёный"], ["#7c2f2a", "Вишня"], ["#2b3f5c", "Синий"]];
  const TRIMS = [["", "Дерево"], ["#f2f0ea", "Белый"], ["#2d3236", "Графит"], ["#5b3a26", "Орех"]];
  const DEFAULT_PRESETS = [
    { name: "Одноэтажный дом", params: { type: "house", length: 10, width: 8, roof: "gable", floors: "one", walls: "frame", terrace: true } },
    { name: "Дом с мансардой", params: { type: "house", length: 9, width: 8, roof: "gable", floors: "mansard", walls: "frame", terrace: true } },
    { name: "Барнхаус", params: { type: "house", length: 10, width: 7, roof: "barn", floors: "one", walls: "frame", panoramic: true, roofColor: "#2b2f33", terrace: true } },
    { name: "Модульный дом", params: { type: "house", length: 8, width: 3.5, roof: "flat", floors: "one", walls: "frame", panoramic: true, terrace: true } }
  ];
  const CFG = S.configurator === false ? null : Object.assign({ title: "Конструктор дома", presets: DEFAULT_PRESETS }, S.configurator || {});
  const segRow = (name, label, items, forType) => `<fieldset class="cfg-row" data-for="${forType || ""}"><legend class="label">${label}</legend><div class="seg">${items.map(([v, n], i) => `<input type="radio" name="cfg-${name}" id="cfg-${name}-${v}" value="${v}"${i === 0 ? " checked" : ""}><label for="cfg-${name}-${v}">${n}</label>`).join("")}</div></fieldset>`;
  const swatchRow = (name, label, items, forType) => `<fieldset class="cfg-row" data-for="${forType || ""}"><legend class="label">${label}</legend><div class="swatches">${items.map(([v, n], i) => `<input type="radio" name="cfg-${name}" id="cfg-${name}-${i}" value="${v}"${i === 0 ? " checked" : ""}><label for="cfg-${name}-${i}" title="${n}" style="--sw:${v || "conic-gradient(var(--c-border-strong) 0 25%, var(--c-surface) 0 50%, var(--c-border-strong) 0 75%, var(--c-surface) 0)"}"><span class="sr-only">${n}</span></label>`).join("")}</div></fieldset>`;
  // Реальные фото: общий набор из 2ГИС и, если есть, отдельные наборы под тип постройки (photoSets[ключ пресета])
  let photoList = [], photoIdx = 0; // заполняется после чтения конфига
  function setPhoto(i) {
    const img = document.getElementById("rp-img");
    if (!img || !photoList.length) return;
    photoIdx = (i + photoList.length) % photoList.length;
    const url = photoList[photoIdx];
    img.classList.add("fading");
    setTimeout(() => {
      img.src = url;
      document.getElementById("rp-link").href = url;
      img.classList.remove("fading");
    }, 180);
    document.querySelectorAll("#rp-thumbs button").forEach((b, k) => b.setAttribute("aria-pressed", String(k === photoIdx)));
  }
  function showPhotos(key, label) {
    const fig = document.getElementById("real-photo");
    if (!fig) return;
    const set = (c.photoSets || {})[key];
    photoList = set && set.length ? set : P.slice();
    document.getElementById("rp-cap").textContent = set && set.length ? `${label} · фото компании` : (c.photoNote || "фото компании");
    document.getElementById("rp-thumbs").innerHTML = photoList.length > 1
      ? photoList.map((u, k) => `<button type="button" aria-label="Фото ${k + 1}" aria-pressed="${k === 0}" style="background-image:url('${esc(u)}')"></button>`).join("") : "";
    fig.hidden = false;
    setPhoto(0);
  }
  window.photoFail = img => {
    // битую ссылку убираем из набора; если фото не осталось — прячем карточку
    photoList = photoList.filter(u => u !== img.getAttribute("src"));
    if (photoList.length) setPhoto(0); else document.getElementById("real-photo").hidden = true;
  };
  // ссылка на сайт студии на всех демо
  const STUDIO_URL = "https://yardyproject.ru/";
  const STUDIO_LINK = `<a class="studio-link" href="${STUDIO_URL}" title="Сайт студии Yardy Project"><svg viewBox="0 0 64 64" aria-hidden="true"><rect x="2" y="2" width="60" height="60" rx="13" fill="#f2a33a"/> <path transform="translate(14.63 51.00) scale(0.0543 -0.0543)" fill="#0a1626" d="M236 0V210H151L13 700H192L277 355H363L448 700H627L489 210H404V0Z"/></svg><span>Сайт студии Yardy Project</span><span aria-hidden="true">→</span></a>`;
  const c = S.company, h = S.hero;
  const P = c.photos || []; // реальные фото компании (из 2ГИС), первое — главное
  photoList = P.slice();
  const touch = matchMedia("(pointer: coarse)").matches;
  const C0 = S.calc || null, GH = !!C0 && C0.kind === "greenhouse"; // калькулятор теплиц: цена по прайсу, а не за м²

  app.innerHTML = `
${c.demoNote ? `<div class="demo-bar"><div class="in"><span>${esc(c.demoNote)}</span>${STUDIO_LINK}</div></div>` : ""}
<header class="top">
  <div class="in">
    <a class="logo" href="#top" id="top">
      ${c.logo ? `<img class="logo-img" src="${esc(c.logo)}" alt="" referrerpolicy="no-referrer" onerror="this.nextElementSibling.removeAttribute('hidden');this.remove()">` : ""}
      <svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"${c.logo ? " hidden" : ""}><path d="M3 13 14 4l11 9"/><path d="M6 11v13h16V11"/><path d="M11 24v-7h6v7"/></svg>
      ${esc(c.name)}
    </a>
    <nav class="nav" aria-label="Разделы">
      <a href="#services">${esc(S.services.label)}</a>
      ${C0 ? `<a href="#calc">Калькулятор</a>` : ""}
      <a href="#works">${esc(S.works.label || "Объекты")}</a>
      <a href="#lead">Заявка</a>
    </nav>
    <a class="phone" href="${phoneHref(c.phone)}">${esc(c.phone)}</a>
  </div>
</header>

<section class="hero">
  <div class="in">
    <div class="hero-text">
      <span class="dim">${esc(c.tagline)}</span>
      <h1>${h.title}</h1>
      <p class="lead">${esc(h.lead)}</p>
      <div class="cta-row">
        <a class="btn primary" href="${esc(h.primary.href)}">${esc(h.primary.text)}</a>
        <a class="btn" href="${esc(h.secondary.href)}">${esc(h.secondary.text)}</a>
      </div>
      <div class="cities label">${c.cities.map(x => `<span>${esc(x)}</span>`).join("")}</div>
${S.no3d ? "" : `      ${P.length ? `
      <figure class="real-photo" id="real-photo">
        <a class="rp-frame" id="rp-link" href="${esc(P[0])}" target="_blank" rel="noopener">
          <img id="rp-img" src="${esc(P[0])}" alt="Реальный объект компании ${esc(c.name)}" referrerpolicy="no-referrer" onerror="photoFail(this)">
        </a>
        <figcaption><span class="dim">Реальный объект</span><span class="rp-cap" id="rp-cap">${esc(c.photoNote || "фото компании")}</span></figcaption>
        <div class="rp-thumbs" id="rp-thumbs"></div>
      </figure>` : ""}`}
    </div>

${S.no3d ? `<div class="hero-photo">      ${P.length ? `
      <figure class="real-photo" id="real-photo">
        <a class="rp-frame" id="rp-link" href="${esc(P[0])}" target="_blank" rel="noopener">
          <img id="rp-img" src="${esc(P[0])}" alt="Реальный объект компании ${esc(c.name)}" referrerpolicy="no-referrer" onerror="photoFail(this)">
        </a>
        <figcaption><span class="dim">Реальный объект</span><span class="rp-cap" id="rp-cap">${esc(c.photoNote || "фото компании")}</span></figcaption>
        <div class="rp-thumbs" id="rp-thumbs"></div>
      </figure>` : ""}</div>` : `    <div class="stage-wrap">
      <div class="scene" id="scene">
        <canvas id="c" tabindex="0" role="img" aria-label="3D-модель дома, который собирается по этапам строительства" aria-describedby="scene-keys"></canvas>
        <p class="sr-only" id="scene-keys">Стрелки поворачивают модель, плюс и минус приближают, цифры от 1 до 5 переключают этапы, пробел ставит сборку на паузу.</p>
        <span class="hint" id="hint">${touch ? "Проведите пальцем, чтобы повернуть. Двумя пальцами — приблизить" : "Перетащите, чтобы повернуть. Ctrl + колесо — приблизить, двойной клик — исходный вид"}</span>
        <div class="ctrl">
          <button class="icon-btn" type="button" id="view-btn" aria-label="Вернуть исходный вид" title="Исходный вид">${I.view}</button>
          <button class="icon-btn" type="button" id="play-btn" aria-label="Пауза">${I.pause}<span class="label-text">Пауза</span></button>
        </div>
        <div class="fallback">3D-модель не поддерживается этим браузером. Этапы стройки описаны ниже.</div>
      </div>
      ${CFG ? `
      <details class="config" id="config">
        <summary><span><b>${esc(CFG.title)}</b><span class="muted"> · выберите тип и настройте под себя</span></span><span class="cfg-area" id="cfg-area"></span></summary>
        <div class="cfg-body">
          <fieldset class="cfg-row cfg-types"${CFG.presets.length < 2 ? " hidden" : ""}><legend class="label">Тип</legend><div class="seg">
            ${CFG.presets.map((pr, i) => `<input type="radio" name="cfg-type" id="cfg-t${i}" value="${i}"${i === 0 ? " checked" : ""}><label for="cfg-t${i}">${esc(pr.name)}</label>`).join("")}</div></fieldset>
          <div class="cfg-row"><label class="label" for="cfg-len">Длина</label><input type="range" id="cfg-len" min="6" max="14" step="0.5" value="10"><output id="cfg-len-out"></output></div>
          <div class="cfg-row" data-for="house"><label class="label" for="cfg-wid">Ширина</label><input type="range" id="cfg-wid" min="3" max="10" step="0.5" value="8"><output id="cfg-wid-out"></output></div>
          ${segRow("gw", "Ширина", [["3", "3 м"], ["2.5", "2,5 м"]], "greenhouse")}
          ${segRow("arc", "Шаг дуг", [["0.65", "0,65 м"], ["1", "1 м"], ["0.5", "0,5 м"]], "greenhouse")}
          ${segRow("prof", "Профиль", [["20x20", "20×20"], ["20x30", "20×30, усиленный"]], "greenhouse")}
          ${segRow("roof", "Кровля", [["gable", "Двускатная"], ["shed", "Односкатная"], ["flat", "Плоская"], ["barn", "Барнхаус"]], "house")}
          ${segRow("floors", "Этажность", [["one", "1 этаж"], ["mansard", "С мансардой"]], "house")}
          ${segRow("walls", "Стены", [["frame", "Каркас"], ["timber", "Брус"], ["gas", "Газобетон"]], "house")}
          ${swatchRow("facade", "Цвет фасада", FACADES, "facade")}
          ${segRow("wood", "Древесина", [["natural", "Натуральная"], ["light", "Светлая"], ["dark", "Тёмная"]], "wood")}
          ${swatchRow("roofColor", "Кровля", ROOFS, "build")}
          ${swatchRow("trim", "Окна и отделка", TRIMS, "build")}
          <div class="cfg-row cfg-toggles">
            <label class="check" data-for="build"><input type="checkbox" id="cfg-terrace" checked> Терраса</label>
            <label class="check" data-for="build"><input type="checkbox" id="cfg-panoramic"> Панорамные окна</label>
            <button class="btn" type="button" id="cfg-cut" aria-pressed="false">Показать в разрезе</button>
          </div>
          <div class="cfg-row cfg-go"><span id="cfg-sum"></span><a class="btn primary" href="${esc(CFG.cta ? CFG.cta.href : "#calc")}" id="cfg-calc">${esc(CFG.cta ? CFG.cta.text : "Посчитать стоимость")}</a></div>
        </div>
      </details>` : ""}
      <div class="stages" role="group" aria-label="Этапы строительства">
        ${S.stages.map((s, i) => `<button class="stage-btn" type="button" data-stage="${i}" aria-pressed="${i === 0}"><span class="bar"><span class="fill"></span></span><span class="n">0${i + 1}</span><span class="t">${esc(s.name)}</span></button>`).join("")}
      </div>

      <div class="stage-info" aria-live="polite">
        <h3 id="st-title"></h3>
        <span class="term" id="st-term"></span>
        <p id="st-text"></p>
      </div>
    </div>`}
  </div>
</section>

<section class="facts" aria-label="Цифры">
  <div class="in">
    ${S.facts.map(f => `<div class="fact"><span class="dim" aria-hidden="true"></span><b>${esc(f.value)}</b><span>${esc(f.text)}</span></div>`).join("")}
  </div>
</section>



<section class="block" id="services">
  <div class="in">
    <div class="head">
      <span class="dim">${esc(S.services.label)}</span>
      <h2>${esc(S.services.title)}</h2>
      <p>${esc(S.services.lead)}</p>
    </div>
    <ul class="price-list">
      ${S.services.items.map(s => `<li><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p><span class="price">${esc(s.price)}</span></li>`).join("")}
    </ul>
  </div>
</section>

${C0 ? `<section class="block calc-band" id="calc">
  <div class="in">
    <div class="head">
      <span class="dim">Калькулятор</span>
      <h2>${esc(S.calc.title)}</h2>
      <p>${esc(S.calc.lead)}</p>
    </div>
${GH ? `    <div class="calc">
      <div class="controls">
        <fieldset>
          <legend class="label">Ширина</legend>
          <div class="seg">${(C0.widths || [3]).map((w, i) => `<input type="radio" name="gwc" id="gwc-${i}" value="${w}"${i === 0 ? " checked" : ""}><label for="gwc-${i}">${String(w).replace(".", ",")} м</label>`).join("")}</div>
        </fieldset>
        <fieldset>
          <div class="range-row"><label class="label" for="glen">Длина</label><output id="glen-out" for="glen"></output></div>
          <input type="range" id="glen" min="0" max="${(C0.lengths || [4]).length - 1}" step="1" value="${Math.max(0, (C0.lengths || []).indexOf(6))}">
        </fieldset>
        <fieldset>
          <legend class="label">Шаг дуг</legend>
          <div class="seg">${C0.variants.map((v, i) => `<input type="radio" name="garc" id="garc-${i}" value="${esc(v.id)}"${i === 0 ? " checked" : ""}><label for="garc-${i}">${esc(v.name)}</label>`).join("")}</div>
        </fieldset>
        <fieldset>
          <legend class="label">Профиль</legend>
          <div class="seg">${C0.profiles.map((v, i) => `<input type="radio" name="gprof" id="gprof-${i}" value="${esc(v.id)}"${i === 0 ? " checked" : ""}><label for="gprof-${i}">${esc(v.name)}</label>`).join("")}</div>
        </fieldset>
        ${C0.densities ? `<fieldset>
          <legend class="label">${esc(C0.densityLabel || "Поликарбонат")}</legend>
          <div class="seg">${C0.densities.map((v, i) => `<input type="radio" name="gden" id="gden-${i}" value="${i}"${i === 0 ? " checked" : ""}><label for="gden-${i}">${esc(v)}</label>`).join("")}</div>
        </fieldset>` : ""}
        <fieldset>
          <legend class="label">${esc(C0.kitLabel || "Установка")}</legend>
          <div class="seg">
            <input type="radio" name="kit" id="kit-shell" value="shell"><label for="kit-shell">${esc((C0.kits || [])[0] || "Без установки")}</label>
            <input type="radio" name="kit" id="kit-turn" value="turn" checked><label for="kit-turn">${esc((C0.kits || [])[1] || "С установкой")}</label>
          </div>
        </fieldset>
      </div>
` : `    <div class="calc">
      <div class="controls">
        <fieldset>
          <legend class="label">${esc(S.calc.typeLabel || "Технология")}</legend>
          <div class="seg">
            ${S.calc.materials.map((m, i) => `<input type="radio" name="mat" id="mat-${esc(m.id)}" value="${esc(m.id)}"${i === 0 ? " checked" : ""}><label for="mat-${esc(m.id)}">${esc(m.name)}</label>`).join("")}
          </div>
        </fieldset>
        <fieldset>
          <legend class="label">${esc(S.calc.kitLabel || "Комплектация")}</legend>
          <div class="seg">
            <input type="radio" name="kit" id="kit-shell" value="shell"><label for="kit-shell">${esc((S.calc.kits || [])[0] || "Тёплый контур")}</label>
            <input type="radio" name="kit" id="kit-turn" value="turn" checked><label for="kit-turn">${esc((S.calc.kits || [])[1] || "Под ключ")}</label>
          </div>
        </fieldset>
        <fieldset${S.calc.floors === false ? " hidden" : ""}>
          <legend class="label">Этажность</legend>
          <div class="seg">
            <input type="radio" name="fl" id="fl-1" value="1" checked><label for="fl-1">1 этаж</label>
            <input type="radio" name="fl" id="fl-2" value="2"><label for="fl-2">2 этажа</label>
          </div>
        </fieldset>
        <fieldset>
          <div class="range-row"><label class="label" for="area">${esc(S.calc.areaLabel || "Площадь дома")}</label><output id="area-out" for="area"></output></div>
          <input type="range" id="area" min="${S.calc.area.min}" max="${S.calc.area.max}" step="${S.calc.area.step}" value="${S.calc.area.value}">
        </fieldset>
      </div>
`}
      <div class="result" aria-live="polite">
        <span class="label">Примерная стоимость</span>
        <div class="sum" id="sum"></div>
        <dl>
          <dt>${GH ? esc((C0.kits || [])[0] || "Без установки") : "Цена за м²"}</dt><dd id="per-m"></dd>
          <dt>${GH ? esc((C0.kits || [])[1] || "С установкой") : esc(S.calc.termLabel || "Срок строительства")}</dt><dd id="weeks"></dd>
          ${GH && C0.term ? `<dt>${esc(C0.term[0])}</dt><dd>${esc(C0.term[1])}</dd>` : ""}
        </dl>
        <ul id="incl"></ul>
        <a class="btn primary" href="#lead">${esc(C0.cta || "Получить точную смету")}</a>
        ${S.calc.note ? `<p class="note">${esc(S.calc.note)}</p>` : ""}
      </div>
    </div>
  </div>
</section>` : ""}

<section class="block" id="works">
  <div class="in">
    <div class="head">
      <span class="dim">${esc(S.works.label || "Объекты")}</span>
      <h2>${esc(S.works.title)}</h2>
      <p>${esc(S.works.lead)}</p>
    </div>
    <div class="works">
      ${S.works.items.map((w, i) => `
      <article class="work${w.detail ? " has-detail" : ""}">
        ${w.detail ? `<button class="work-hit" type="button" data-work="${i}" aria-label="Подробнее: ${esc(w.title)}"></button>` : ""}
        <div class="pic">${w.tag ? `<span class="label">${esc(w.tag)}</span>` : ""}
          <svg viewBox="0 0 240 150" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICONS[w.icon] || ICONS.house}</svg>
          ${w.photo ? `<img src="${esc(w.photo)}" alt="${esc(w.title)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
        </div>
        <h3>${esc(w.title)}</h3>
        <dl>${w.specs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
        ${w.detail ? `<span class="work-more" aria-hidden="true">Подробнее →</span>` : ""}
      </article>`).join("")}
    </div>
  </div>
</section>

<section class="block lead-band" id="lead">
  <div class="in lead-grid">
    <div class="head">
      <span class="dim">Заявка</span>
      <h2>${esc(S.lead.title)}</h2>
      <p>${esc(S.lead.lead)}</p>
      <ul>${S.lead.bullets.map(b => `<li>${esc(b)}</li>`).join("")}</ul>
    </div>
    <form id="lead-form" novalidate>
      <div class="field"><label for="f-name">Имя</label><input id="f-name" name="name" autocomplete="name" placeholder="Андрей"></div>
      <div class="field"><label for="f-phone">Телефон</label><input id="f-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 (900) 000-00-00" aria-describedby="f-phone-err"><span class="err" id="f-phone-err"></span></div>
      <div class="field wide"><label for="f-type">${esc(S.lead.typeLabel || "Что строим")}</label>
        <select id="f-type" name="type">${S.lead.types.map(t => `<option>${esc(t)}</option>`).join("")}</select>
      </div>
      <div class="field wide"><label for="f-msg">Комментарий</label><textarea id="f-msg" name="msg" placeholder="${esc(S.lead.placeholder)}"></textarea></div>
      <button class="btn primary" type="submit">Отправить заявку</button>
      <p class="form-status" id="f-status" role="status"></p>
    </form>
  </div>
</section>

<footer>
  <div class="in">
    <span>${esc(c.name)} · ${c.cities.map(esc).join(", ")}</span>
    ${c.demoNote ? `<a class="studio-foot" href="${STUDIO_URL}"><svg viewBox="0 0 64 64" aria-hidden="true"><rect x="2" y="2" width="60" height="60" rx="13" fill="#f2a33a"/> <path transform="translate(14.63 51.00) scale(0.0543 -0.0543)" fill="#0a1626" d="M236 0V210H151L13 700H192L277 355H363L448 700H627L489 210H404V0Z"/></svg>${esc(c.footerNote || "Демо-шаблон от Yardy Project")}</a>` : ""}
  </div>
</footer>
<dialog class="wd" id="wd" aria-labelledby="wd-title"><div class="wd-body" id="wd-body"></div></dialog>
<div class="mbar">
  <a class="btn primary" href="${esc(h.primary.href)}">${esc(h.primary.short || h.primary.text)}</a>
  <a class="btn" href="${phoneHref(c.phone)}">Позвонить</a>
</div>`;

  /* ---------- Этапы и 3D ---------- */
  if (!S.no3d) {
  const btns = [...app.querySelectorAll(".stage-btn")];
  const fills = btns.map(b => b.querySelector(".fill"));
  const stTitle = document.getElementById("st-title");
  const stTerm = document.getElementById("st-term");
  const stText = document.getElementById("st-text");
  const playBtn = document.getElementById("play-btn");
  const hint = document.getElementById("hint");
  let shown = -1;
  function showStage(k) {
    if (k === shown) return;
    shown = k;
    btns.forEach((b, i) => b.setAttribute("aria-pressed", String(i === k)));
    stTitle.textContent = S.stages[k].title;
    stTerm.textContent = S.stages[k].term;
    stText.textContent = S.stages[k].text;
  }
  showStage(0);

  const PLAY_STATES = {
    building: [I.pause, "Пауза"],
    paused: [I.play, "Продолжить"],
    done: [I.replay, "Собрать заново"]
  };
  function setPlayState(state) {
    const [icon, text] = PLAY_STATES[state];
    playBtn.innerHTML = icon + `<span class="label-text">${text}</span>`;
    playBtn.setAttribute("aria-label", text);
  }

  const house = window.House3D && window.House3D.mount(document.getElementById("scene"), {
    summer: S.season === "summer",
    onProgress(p) {
      fills.forEach((f, i) => { f.style.width = (Math.max(0, Math.min(1, p - i)) * 100).toFixed(1) + "%"; });
      showStage(Math.min(4, Math.floor(Math.max(0, p - 0.001))));
    },
    onState: setPlayState,
    onInteract() { hint.classList.add("gone"); }
  });

  if (house) {
    btns.forEach((b, i) => b.addEventListener("click", () => house.goTo(i)));
    const thumbs = document.getElementById("rp-thumbs");
    if (thumbs) thumbs.addEventListener("click", e => {
      const b = e.target.closest("button");
      if (b) setPhoto([...thumbs.children].indexOf(b));
    });
    /* ---------- Конструктор ---------- */
    const cfg = document.getElementById("config");
    if (cfg) {
      const val = n => (cfg.querySelector(`input[name="cfg-${n}"]:checked`) || {}).value;
      const setVal = (n, v) => { const el = cfg.querySelector(`input[name="cfg-${n}"][value="${v}"]`); if (el) el.checked = true; };
      const len = document.getElementById("cfg-len"), wid = document.getElementById("cfg-wid");
      const WALLS = { frame: "каркас", timber: "брус", gas: "газобетон" };
      const RANGE = { house: [3, 14], barrel: [3, 6], greenhouse: [4, 18] }; // от маленькой бани 3×4 до большого дома
      const GH_LEN = [4, 5, 6, 7, 8, 10, 12, 14, 16, 18]; // длины теплиц: модули по 1 и 2 м
      const snapLen = v => GH_LEN.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a);
      let raf = 0, type = "house";
      function applyPreset(i) {
        const pr = Object.assign({ type: "house", roof: "gable", floors: "one", walls: "frame", facade: "", roofColor: "", trim: "", wood: "natural", panoramic: false, terrace: true, arc: "0.65", profile: "20x20" }, CFG.presets[i].params);
        type = pr.type;
        showPhotos(CFG.presets[i].key, CFG.presets[i].name);
        const [mn, mx] = RANGE[type] || RANGE.house;
        len.min = mn; len.max = mx; len.step = type === "greenhouse" ? 1 : 0.5; len.value = pr.length;
        wid.value = pr.width || 8;
        ["roof", "floors", "walls", "wood", "facade", "roofColor", "trim"].forEach(k => setVal(k, pr[k]));
        setVal("gw", String(pr.width || 3)); setVal("arc", String(pr.arc)); setVal("prof", pr.profile);
        document.getElementById("cfg-terrace").checked = !!pr.terrace;
        document.getElementById("cfg-panoramic").checked = !!pr.panoramic;
        sync();
      }
      function sync() {
        const gh = type === "greenhouse";
        if (gh) len.value = snapLen(+len.value);
        const p = { type, length: +len.value, width: gh ? +val("gw") : +wid.value, roof: val("roof"), floors: val("floors"), walls: val("walls"),
          wood: val("wood"), facade: val("facade") || "", roofColor: val("roofColor") || "", trim: val("trim") || "",
          terrace: document.getElementById("cfg-terrace").checked, panoramic: document.getElementById("cfg-panoramic").checked,
          arc: val("arc"), profile: val("prof") };
        // показываем только те настройки, что имеют смысл для выбранного типа
        const woody = type === "barrel" || p.walls === "timber";
        cfg.querySelectorAll("[data-for]").forEach(el => {
          const f = el.dataset.for;
          el.hidden = (f === "house" && type !== "house") || (f === "facade" && (type !== "house" || p.walls === "timber")) || (f === "wood" && !woody) ||
            (f === "greenhouse" && !gh) || (f === "build" && gh);
        });
        document.getElementById("cfg-len-out").textContent = String(p.length).replace(".", ",") + " м";
        document.getElementById("cfg-wid-out").textContent = String(p.width).replace(".", ",") + " м";
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          house.configure(p);
          const pr = house.params();
          const num = v => String(v).replace(".", ",");
          const what = type === "barrel" ? "баня-бочка" : WALLS[pr.walls] + (pr.floors === "mansard" && pr.roof !== "flat" ? ", с мансардой" : "");
          const text = gh ? `${num(pr.width)} × ${pr.length} м · шаг ${num(pr.arc)} м · ${pr.profile.replace("x", "×")}` : `≈ ${pr.area} м² · ${what}`;
          document.getElementById("cfg-area").textContent = text;
          document.getElementById("cfg-sum").textContent = (gh ? "Теплица " : "Площадь ") + text;
        });
      }
      cfg.addEventListener("input", e => { if (e.target.name === "cfg-type") applyPreset(+e.target.value); else sync(); });
      const cut = document.getElementById("cfg-cut");
      cut.addEventListener("click", () => {
        const on = cut.getAttribute("aria-pressed") !== "true";
        cut.setAttribute("aria-pressed", String(on));
        cut.textContent = on ? "Скрыть разрез" : "Показать в разрезе";
        house.setCut(on);
      });
      // «Посчитать стоимость»: площадь и материал из конструктора переходят в калькулятор
      document.getElementById("cfg-calc").addEventListener("click", () => {
        const pr = house.params();
        if (!C0) { const msg = document.getElementById("f-msg"); if (msg) msg.value = document.getElementById("cfg-sum").textContent; return; }
        if (pr.type === "greenhouse" && GH) { ghFrom(pr); return; }
        const ar = document.getElementById("area");
        ar.value = Math.max(+ar.min, Math.min(+ar.max, pr.area));
        const m = document.getElementById("mat-" + (pr.type === "barrel" ? "cedar" : pr.walls)) || document.getElementById("mat-timber");
        if (m) m.checked = true;
        ar.dispatchEvent(new Event("input", { bubbles: true }));
      });
      if (matchMedia("(min-width: 901px)").matches) cfg.open = true;
      applyPreset(0);
    }
    playBtn.addEventListener("click", () => house.toggle());
    document.getElementById("view-btn").addEventListener("click", () => house.resetView());
  } else {
    document.getElementById("scene").classList.add("no3d");
    fills.forEach(f => { f.style.width = "100%"; });
    btns.forEach((b, i) => b.addEventListener("click", () => showStage(i)));
  }

  } else if (document.getElementById("real-photo")) {
    // без 3D: фото компании с миниатюрами во второй колонке героя
    showPhotos("", "");
    document.getElementById("rp-thumbs").addEventListener("click", e => {
      const b = e.target.closest("button");
      if (b) setPhoto([...b.parentNode.children].indexOf(b));
    });
  }

  /* ---------- Калькулятор ---------- */
  const C = S.calc;
  const fmt = n => new Intl.NumberFormat("ru-RU").format(n) + " ₽";
  const weeksWord = n => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? "неделя" : a >= 2 && a <= 4 && (b < 12 || b > 14) ? "недели" : "недель"; };
  const area = document.getElementById("area");
  const picked = name => app.querySelector(`input[name="${name}"]:checked`).value;
  // Теплицы: цена из прайса по длине (линейно между известными размерами, дальше — по последнему шагу).
  // prices[ключ][длина] = [цена для каждой плотности поликарбоната]; install[ключ][длина] = надбавка за установку.
  // Ключ — шаг дуг или особый профиль (у некоторых производителей усиленный профиль идёт только с одним шагом).
  function ghKey(arc, prof) { return prof !== C0.profiles[0].id && C0.prices[prof] ? prof : arc; }
  function ghPrice(key, len, width, di, install) {
    const at = tab => {
      const rows = Object.keys(tab).map(Number).sort((x, y) => x - y).map(l => [l, [].concat(tab[l])]);
      let i = rows.findIndex(r => r[0] >= len);
      if (i < 0) i = rows.length - 1; else if (i === 0) i = 1;
      const [l0, a] = rows[i - 1], [l1, b] = rows[i];
      const k = Math.min(di, a.length - 1);
      return a[k] + (b[k] - a[k]) * (len - l0) / (l1 - l0);
    };
    let v = at(C0.prices[key]) + (install ? at(C0.install[key]) : 0);
    if (width < (C0.widths || [3])[0]) v *= C0.narrowK || 0.9;
    return Math.round(v / 500) * 500;
  }
  function ghFrom(pr) {
    const set = (n, v) => { const el = app.querySelector(`input[name="${n}"][value="${v}"]`); if (el) el.checked = true; };
    set("gwc", pr.width); set("garc", pr.arc); set("gprof", pr.profile);
    const g = document.getElementById("glen"), i = C0.lengths.indexOf(pr.length);
    if (i >= 0) g.value = i;
    g.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function calcGh() {
    const prof = picked("gprof"), fixed = (C0.profileArc || {})[prof];
    // профиль, который делают только с одним шагом дуг: шаг выставляется сам, остальные недоступны
    app.querySelectorAll('input[name="garc"]').forEach(r => { r.disabled = !!fixed && r.value !== fixed; if (fixed && r.value === fixed) r.checked = true; });
    const len = C0.lengths[+document.getElementById("glen").value], w = +picked("gwc"), arc = picked("garc"), k = picked("kit");
    const di = C0.densities ? +picked("gden") : 0, key = ghKey(arc, prof);
    const no = ghPrice(key, len, w, di, false), yes = ghPrice(key, len, w, di, true);
    document.getElementById("glen-out").textContent = len + " м";
    document.getElementById("sum").textContent = "от " + fmt(k === "turn" ? yes : no);
    document.getElementById("per-m").textContent = "от " + fmt(no);
    document.getElementById("weeks").textContent = "от " + fmt(yes);
    document.getElementById("incl").innerHTML = C0.include[k].map(s => "<li>" + esc(s) + "</li>").join("");
  }
  function calc() {
    if (GH) return calcGh();
    const a = +area.value, m = C.materials.find(x => x.id === picked("mat")), k = picked("kit"), two = picked("fl") === "2";
    const per = Math.round(m[k] * (two ? 1 - C.twoFloorDiscount : 1) / 100) * 100;
    const total = Math.round(per * a / 10000) * 10000;
    const div = C.weeksDiv || [30, 20]; // сколько м² в неделю: [контур, под ключ]
    const w = Math.max(1, Math.round(m.weeks[k === "turn" ? 1 : 0] + a / div[k === "turn" ? 1 : 0]));
    document.getElementById("area-out").textContent = a + " м²";
    document.getElementById("sum").textContent = fmt(total);
    document.getElementById("per-m").textContent = fmt(per);
    document.getElementById("weeks").textContent = w + " " + weeksWord(w);
    document.getElementById("incl").innerHTML = C.include[k].map(s => "<li>" + esc(s) + "</li>").join("");
  }
  if (C0) {
    app.querySelectorAll(".controls input").forEach(i => i.addEventListener("input", calc));
    calc();
  }

  /* ---------- Карточка товара: фото, описание, цены, быстрый заказ ---------- */
  const wd = document.getElementById("wd"), wdBody = document.getElementById("wd-body");
  function openWork(i) {
    const w = S.works.items[i], d = w.detail;
    const photos = [w.photo].concat(d.photos || []).filter(Boolean);
    wdBody.innerHTML = `
      <button class="wd-close" type="button" aria-label="Закрыть">×</button>
      <div class="wd-media">
        <img id="wd-img" src="${esc(photos[0] || "")}" alt="${esc(w.title)}">
        ${photos.length > 1 ? `<div class="wd-thumbs">${photos.map((u, k) => `<button type="button" aria-label="Фото ${k + 1}" aria-pressed="${k === 0}" style="background-image:url('${esc(u)}')" data-src="${esc(u)}"></button>`).join("")}</div>` : ""}
      </div>
      <div class="wd-info">
        ${w.tag ? `<span class="dim">${esc(w.tag)}</span>` : ""}
        <h2 id="wd-title">${esc(w.title)}</h2>
        ${d.price ? `<p class="wd-price">${esc(d.price)}</p>` : ""}
        ${(d.text || []).map(t => `<p>${esc(t)}</p>`).join("")}
        ${d.list && d.list.length ? `<h3 class="wd-sub">${esc(d.listTitle || "Краткое описание")}</h3><ul class="wd-list">${d.list.map(t => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
        ${d.table ? `<table class="wd-table"><thead><tr>${d.table.head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead>
          <tbody>${d.table.rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : ""}
        ${d.note ? `<p class="note">${esc(d.note)}</p>` : ""}
        <form class="wd-order" novalidate>
          <label class="sr-only" for="wd-phone">Телефон</label>
          <input id="wd-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 (900) 000-00-00">
          <button class="btn primary" type="submit">${esc(d.cta || "Заказать")}</button>
          <p class="form-status" role="status"></p>
        </form>
      </div>`;
    wd.showModal();
    try { history.replaceState(null, "", "#t" + (i + 1)); } catch (e) {}
  }
  if (wd) {
    app.addEventListener("click", e => { const b = e.target.closest("[data-work]"); if (b) openWork(+b.dataset.work); });
    wd.addEventListener("click", e => {
      if (e.target === wd || e.target.closest(".wd-close")) { wd.close(); return; }
      const t = e.target.closest(".wd-thumbs button");
      if (t) { document.getElementById("wd-img").src = t.dataset.src; wd.querySelectorAll(".wd-thumbs button").forEach(b => b.setAttribute("aria-pressed", String(b === t))); }
    });
    wd.addEventListener("close", () => { try { history.replaceState(null, "", location.pathname); } catch (e) {} });
    wd.addEventListener("input", e => { if (e.target.id === "wd-phone") e.target.value = formatPhone(e.target.value); });
    wd.addEventListener("submit", e => {
      e.preventDefault();
      const ph = document.getElementById("wd-phone"), st = wd.querySelector(".form-status");
      if (ph.value.replace(/\D/g, "").length !== 11) { st.className = "form-status"; st.textContent = "Укажите номер полностью: +7 (900) 000-00-00"; ph.focus(); return; }
      st.className = "form-status ok"; st.textContent = S.lead.success;
    });
    const m = /^#t(\d+)$/.exec(location.hash);
    if (m && S.works.items[+m[1] - 1] && S.works.items[+m[1] - 1].detail) openWork(+m[1] - 1);
  }

  /* ---------- Заявка ---------- */
  const form = document.getElementById("lead-form");
  const phone = document.getElementById("f-phone");
  const phoneErr = document.getElementById("f-phone-err");
  const status = document.getElementById("f-status");
  // Маска: +7 (913) 866-19-13
  function formatPhone(v) {
    let d = v.replace(/\D/g, "");
    if (d[0] === "8") d = "7" + d.slice(1);
    if (d && d[0] !== "7") d = "7" + d;
    d = d.slice(0, 11);
    const p = [d.slice(1, 4), d.slice(4, 7), d.slice(7, 9), d.slice(9, 11)];
    let out = d ? "+7" : "";
    if (p[0]) out += " (" + p[0] + (p[0].length === 3 ? ")" : "");
    if (p[1]) out += " " + p[1];
    if (p[2]) out += "-" + p[2];
    if (p[3]) out += "-" + p[3];
    return out;
  }
  const phoneOk = () => phone.value.replace(/\D/g, "").length === 11;
  function showPhoneError(on) {
    phone.setAttribute("aria-invalid", String(on));
    phoneErr.textContent = on ? "Укажите номер полностью: +7 (900) 000-00-00" : "";
  }
  phone.addEventListener("input", () => {
    phone.value = formatPhone(phone.value);
    if (phone.getAttribute("aria-invalid") === "true" && phoneOk()) showPhoneError(false);
  });
  phone.addEventListener("blur", () => { if (phone.value) showPhoneError(!phoneOk()); });
  form.addEventListener("submit", e => {
    e.preventDefault();
    if (!phoneOk()) { showPhoneError(true); phone.focus(); return; }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Отправляем…";
    status.className = "form-status";
    status.textContent = "";
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = "Отправить заявку";
      status.className = "form-status ok";
      status.textContent = S.lead.success;
      form.reset();
    }, 700);
  });
})();
