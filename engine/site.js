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

  /* ---------- Цвет акцента из конфига ---------- */
  if (S.theme) {
    const st = document.createElement("style");
    const { accent, accentDark } = S.theme;
    st.textContent =
      `:root{--accent:${accent}}` +
      `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--accent:${accentDark || accent}}}` +
      `:root[data-theme="dark"]{--accent:${accentDark || accent}}`;
    document.head.appendChild(st);
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

  const c = S.company, h = S.hero;
  const touch = matchMedia("(pointer: coarse)").matches;

  app.innerHTML = `
${c.demoNote ? `<div class="demo-bar"><div class="in">${esc(c.demoNote)}</div></div>` : ""}
<header class="top">
  <div class="in">
    <a class="logo" href="#top" id="top">
      <svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M3 13 14 4l11 9"/><path d="M6 11v13h16V11"/><path d="M11 24v-7h6v7"/></svg>
      ${esc(c.name)}
    </a>
    <nav class="nav" aria-label="Разделы">
      <a href="#services">${esc(S.services.label)}</a>
      <a href="#calc">Калькулятор</a>
      <a href="#works">Объекты</a>
      <a href="#lead">Заявка</a>
    </nav>
    <a class="phone" href="${phoneHref(c.phone)}">${esc(c.phone)}</a>
  </div>
</header>

<section class="hero">
  <div class="in">
    <div class="hero-text">
      <span class="label">${esc(c.tagline)}</span>
      <h1>${h.title}</h1>
      <p class="lead">${esc(h.lead)}</p>
      <div class="cta-row">
        <a class="btn primary" href="${esc(h.primary.href)}">${esc(h.primary.text)}</a>
        <a class="btn" href="${esc(h.secondary.href)}">${esc(h.secondary.text)}</a>
      </div>
      <div class="cities label">${c.cities.map(x => `<span>${esc(x)}</span>`).join("")}</div>
    </div>

    <div class="stage-wrap">
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
      <div class="stages" role="group" aria-label="Этапы строительства">
        ${S.stages.map((s, i) => `<button class="stage-btn" type="button" data-stage="${i}" aria-pressed="${i === 0}"><span class="bar"><span class="fill"></span></span><span class="n">0${i + 1}</span><span class="t">${esc(s.name)}</span></button>`).join("")}
      </div>
      <div class="stage-info" aria-live="polite">
        <h3 id="st-title"></h3>
        <span class="term" id="st-term"></span>
        <p id="st-text"></p>
      </div>
    </div>
  </div>
</section>

<section class="facts" aria-label="Цифры">
  <div class="in">
    ${S.facts.map(f => `<div class="fact"><b>${esc(f.value)}</b><span>${esc(f.text)}</span></div>`).join("")}
  </div>
</section>

<section class="block" id="services">
  <div class="in">
    <div class="head">
      <span class="label">${esc(S.services.label)}</span>
      <h2>${esc(S.services.title)}</h2>
      <p>${esc(S.services.lead)}</p>
    </div>
    <div class="services">
      ${S.services.items.map(s => `<article class="svc"><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p><span class="price">${esc(s.price)}</span></article>`).join("")}
    </div>
  </div>
</section>

<section class="block calc-band" id="calc">
  <div class="in">
    <div class="head">
      <span class="label">Калькулятор</span>
      <h2>${esc(S.calc.title)}</h2>
      <p>${esc(S.calc.lead)}</p>
    </div>
    <div class="calc">
      <div class="controls">
        <fieldset>
          <legend class="label">Технология</legend>
          <div class="seg">
            ${S.calc.materials.map((m, i) => `<input type="radio" name="mat" id="mat-${esc(m.id)}" value="${esc(m.id)}"${i === 0 ? " checked" : ""}><label for="mat-${esc(m.id)}">${esc(m.name)}</label>`).join("")}
          </div>
        </fieldset>
        <fieldset>
          <legend class="label">Комплектация</legend>
          <div class="seg">
            <input type="radio" name="kit" id="kit-shell" value="shell"><label for="kit-shell">Тёплый контур</label>
            <input type="radio" name="kit" id="kit-turn" value="turn" checked><label for="kit-turn">Под ключ</label>
          </div>
        </fieldset>
        <fieldset>
          <legend class="label">Этажность</legend>
          <div class="seg">
            <input type="radio" name="fl" id="fl-1" value="1" checked><label for="fl-1">1 этаж</label>
            <input type="radio" name="fl" id="fl-2" value="2"><label for="fl-2">2 этажа</label>
          </div>
        </fieldset>
        <fieldset>
          <div class="range-row"><label class="label" for="area">Площадь дома</label><output id="area-out" for="area"></output></div>
          <input type="range" id="area" min="${S.calc.area.min}" max="${S.calc.area.max}" step="${S.calc.area.step}" value="${S.calc.area.value}">
        </fieldset>
      </div>
      <div class="result" aria-live="polite">
        <span class="label">Примерная стоимость</span>
        <div class="sum" id="sum"></div>
        <dl>
          <dt>Цена за м²</dt><dd id="per-m"></dd>
          <dt>Срок строительства</dt><dd id="weeks"></dd>
        </dl>
        <ul id="incl"></ul>
        <a class="btn primary" href="#lead">Получить точную смету</a>
        ${S.calc.note ? `<p class="note">${esc(S.calc.note)}</p>` : ""}
      </div>
    </div>
  </div>
</section>

<section class="block" id="works">
  <div class="in">
    <div class="head">
      <span class="label">Объекты</span>
      <h2>${esc(S.works.title)}</h2>
      <p>${esc(S.works.lead)}</p>
    </div>
    <div class="works">
      ${S.works.items.map(w => `
      <article class="work">
        <div class="pic">${w.tag ? `<span class="label">${esc(w.tag)}</span>` : ""}
          ${w.photo ? `<img src="${esc(w.photo)}" alt="${esc(w.title)}" loading="lazy">` : `<svg viewBox="0 0 240 150" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICONS[w.icon] || ICONS.house}</svg>`}
        </div>
        <h3>${esc(w.title)}</h3>
        <dl>${w.specs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      </article>`).join("")}
    </div>
  </div>
</section>

<section class="block lead-band" id="lead">
  <div class="in lead-grid">
    <div class="head">
      <span class="label">Заявка</span>
      <h2>${esc(S.lead.title)}</h2>
      <p>${esc(S.lead.lead)}</p>
      <ul>${S.lead.bullets.map(b => `<li>${esc(b)}</li>`).join("")}</ul>
    </div>
    <form id="lead-form" novalidate>
      <div class="field"><label for="f-name">Имя</label><input id="f-name" name="name" autocomplete="name" placeholder="Андрей"></div>
      <div class="field"><label for="f-phone">Телефон</label><input id="f-phone" name="phone" type="tel" autocomplete="tel" placeholder="+7 900 000-00-00"></div>
      <div class="field wide"><label for="f-type">Что строим</label>
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
    ${c.demoNote ? "<span>Демо-шаблон. Данные вымышлены.</span>" : ""}
  </div>
</footer>`;

  /* ---------- Этапы и 3D ---------- */
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
    colors: S.house,
    onProgress(p) {
      fills.forEach((f, i) => { f.style.width = (Math.max(0, Math.min(1, p - i)) * 100).toFixed(1) + "%"; });
      showStage(Math.min(4, Math.floor(Math.max(0, p - 0.001))));
    },
    onState: setPlayState,
    onInteract() { hint.classList.add("gone"); }
  });

  if (house) {
    btns.forEach((b, i) => b.addEventListener("click", () => house.goTo(i)));
    playBtn.addEventListener("click", () => house.toggle());
    document.getElementById("view-btn").addEventListener("click", () => house.resetView());
  } else {
    document.getElementById("scene").classList.add("no3d");
    fills.forEach(f => { f.style.width = "100%"; });
    btns.forEach((b, i) => b.addEventListener("click", () => showStage(i)));
  }

  /* ---------- Калькулятор ---------- */
  const C = S.calc;
  const fmt = n => new Intl.NumberFormat("ru-RU").format(n) + " ₽";
  const weeksWord = n => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? "неделя" : a >= 2 && a <= 4 && (b < 12 || b > 14) ? "недели" : "недель"; };
  const area = document.getElementById("area");
  const picked = name => app.querySelector(`input[name="${name}"]:checked`).value;
  function calc() {
    const a = +area.value, m = C.materials.find(x => x.id === picked("mat")), k = picked("kit"), two = picked("fl") === "2";
    const per = Math.round(m[k] * (two ? 1 - C.twoFloorDiscount : 1) / 100) * 100;
    const total = Math.round(per * a / 10000) * 10000;
    const w = Math.round(m.weeks[k === "turn" ? 1 : 0] + a / (k === "turn" ? 20 : 30));
    document.getElementById("area-out").textContent = a + " м²";
    document.getElementById("sum").textContent = fmt(total);
    document.getElementById("per-m").textContent = fmt(per);
    document.getElementById("weeks").textContent = w + " " + weeksWord(w);
    document.getElementById("incl").innerHTML = C.include[k].map(s => "<li>" + esc(s) + "</li>").join("");
  }
  app.querySelectorAll(".controls input").forEach(i => i.addEventListener("input", calc));
  calc();

  /* ---------- Заявка ---------- */
  document.getElementById("lead-form").addEventListener("submit", e => {
    e.preventDefault();
    const phone = document.getElementById("f-phone");
    const st = document.getElementById("f-status");
    if (phone.value.replace(/\D/g, "").length < 10) {
      st.className = "form-status err";
      st.textContent = "Укажите телефон полностью, например +7 900 000-00-00.";
      phone.focus();
      return;
    }
    st.className = "form-status ok";
    st.textContent = S.lead.success;
    e.target.reset();
  });
})();
