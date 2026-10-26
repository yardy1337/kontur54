/*
  3D-дом: сборка «от чертежа к дому» в пять этапов.

  Сценарий:
  1. Фундамент — на снегу чертится план с осями и размерными линиями, весь дом
     виден призрачным контуром; плита вырастает из земли.
  2. Каркас — стойки поднимаются волной по периметру, сверху ложится обвязка.
  3. Стены — обшивка «заполняется» снизу вверх (плоскость отсечения), окна въезжают снаружи.
  4. Кровля — фронтоны заполняются, скаты закрываются как крышка, растёт труба.
  5. Под ключ — фасад, дверь, терраса, снег на кровле; контур растворяется, в окнах загорается тепло.

  Устройство:
  - timeline: { start, dur, update(e, t) } — каждый объект сам знает, как появляется.
  - p ∈ [0..5] плавно идёт к target; apply() прогоняет timeline.
  - цвета — только из CSS-токенов страницы (--scene-*, --house-*), см. engine/site.css.
  - рендер по требованию, тени пересчитываются только во время сборки, снег считает GPU.

  API: House3D.mount(sceneEl, { onProgress(p), onState(s), onInteract() })
       → { goTo(k), toggle(), resetView() } или null, если WebGL недоступен.
*/
(function () {
  const STAGES = 5;
  const LOOK = { x: 0, y: 2.3, z: 0.4 };
  const HOME = { yaw: 0.62, pitch: 0.36, dist: 24 };
  // Лучший ракурс для каждого этапа
  const VIEWS = [
    { yaw: 0.45, pitch: 0.78, dist: 26 },
    { yaw: 0.9, pitch: 0.5, dist: 22 },
    { yaw: 0.3, pitch: 0.3, dist: 22 },
    { yaw: -0.75, pitch: 0.5, dist: 25 },
    { yaw: 0.62, pitch: 0.28, dist: 22 }
  ];
  const LIM = { pitch: [0.08, 1.2], dist: [14, 40] };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const clamp01 = t => clamp(t, 0, 1);
  const ease = t => 1 - Math.pow(1 - t, 3);
  const span = (p, a, b) => clamp01((p - a) / (b - a));

  function mount(wrap, opts) {
    if (!window.THREE) return null;
    const T = THREE;
    const canvas = wrap.querySelector("canvas");
    let renderer;
    try { renderer = new T.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" }); }
    catch (e) { return null; }

    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const coarse = matchMedia("(pointer: coarse)").matches;
    let dpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2);
    renderer.setPixelRatio(dpr);
    renderer.outputEncoding = T.sRGBEncoding;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.localClippingEnabled = true;

    const lin = css => new T.Color(css).convertSRGBToLinear();
    const scene = new T.Scene();
    scene.fog = new T.Fog(0xffffff, 30, 110);
    const camera = new T.PerspectiveCamera(34, 1, 0.1, 400);

    /* ---------- Небо, окружение, свет ---------- */
    const TM = "\n#include <tonemapping_fragment>\n#include <encodings_fragment>\n";
    const skyMat = new T.ShaderMaterial({
      uniforms: { top: { value: new T.Color() }, bottom: { value: new T.Color() } },
      vertexShader: "varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: "uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = normalize(vP).y; gl_FragColor = vec4(mix(bottom, top, smoothstep(0.0, 0.45, h)), 1.0);" + TM + "}",
      side: T.BackSide, depthWrite: false, fog: false
    });
    scene.add(new T.Mesh(new T.SphereGeometry(200, 32, 16), skyMat));

    const pmrem = new T.PMREMGenerator(renderer);
    let envRT = null;
    function buildEnv(topC, horizonC, groundC) {
      const g = new T.SphereGeometry(10, 32, 16);
      const pos = g.attributes.position, cols = [];
      const c = new T.Color();
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i) / 10;
        if (y > 0) c.copy(horizonC).lerp(topC, Math.min(1, y * 2.2));
        else c.copy(horizonC).lerp(groundC, Math.min(1, -y * 4));
        cols.push(c.r, c.g, c.b);
      }
      g.setAttribute("color", new T.Float32BufferAttribute(cols, 3));
      const envScene = new T.Scene();
      envScene.add(new T.Mesh(g, new T.MeshBasicMaterial({ vertexColors: true, side: T.BackSide })));
      const rt = pmrem.fromScene(envScene, 0.02);
      if (envRT) envRT.dispose();
      envRT = rt;
      scene.environment = rt.texture;
      g.dispose();
    }

    const hemi = new T.HemisphereLight(0xffffff, 0x888888, 0.5);
    scene.add(hemi);
    const sun = new T.DirectionalLight(0xffffff, 2);
    sun.position.set(15, 13, 9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
    Object.assign(sun.shadow.camera, { left: -13, right: 13, top: 13, bottom: -13, near: 1, far: 50 });
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    const windowLight = new T.PointLight(0xffffff, 0, 11, 2);
    windowLight.position.set(-1.6, 2.2, 5.6);
    scene.add(windowLight);

    /* ---------- Материалы: цвет каждого берётся из CSS-токена ---------- */
    const tokenMats = []; // [material, имя токена, свойство]
    function M(token, o) {
      const m = new T.MeshStandardMaterial(Object.assign({ roughness: 0.85, metalness: 0 }, o || {}));
      tokenMats.push([m, token, "color"]);
      return m;
    }
    // Вертикальная доска (планкен): яркость генерируется на canvas, цвет даёт токен.
    const boards = (() => {
      const cv = document.createElement("canvas");
      cv.width = cv.height = 256;
      const g = cv.getContext("2d");
      for (let i = 0; i < 8; i++) {
        const v = 222 + Math.round((Math.random() - 0.5) * 26);
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.fillRect(i * 32, 0, 32, 256);
        g.fillStyle = "rgba(0,0,0,0.05)";
        for (let k = 0; k < 6; k++) g.fillRect(i * 32 + 3 + Math.random() * 26, 0, 1, 256);
        g.fillStyle = "rgb(70,70,70)";
        g.fillRect(i * 32, 0, 2, 256);
      }
      return cv;
    })();
    const BOARD = 1.6; // ширина тайла текстуры, м (8 досок по 20 см)
    function boardsMat(token, rx, ry, clip) {
      const t = new T.CanvasTexture(boards);
      t.encoding = T.sRGBEncoding;
      t.wrapS = t.wrapT = T.RepeatWrapping;
      t.repeat.set(rx, ry);
      t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const b = t.clone();
      b.encoding = T.LinearEncoding;
      b.needsUpdate = true;
      return M(token, { map: t, bumpMap: b, bumpScale: 0.015, roughness: 0.8, clippingPlanes: clip ? [clip] : null, clipShadows: !!clip });
    }
    const mat = {
      insulation: M("--house-insulation", { roughness: 0.95 }),
      slab: M("--house-slab", { roughness: 0.95 }),
      frame: M("--house-frame", { roughness: 0.75 }),
      trim: M("--house-trim", { roughness: 0.6 }),
      door: M("--house-door", { roughness: 0.5 }),
      roof: M("--house-roof", { roughness: 0.38, metalness: 0.55 }),
      glass: M("--house-glass", { roughness: 0.04, metalness: 0.9, envMapIntensity: 1.5, emissiveIntensity: 0 }),
      snow: M("--scene-snow", { roughness: 1 }),
      trunk: M("--house-trunk"),
      needles: M("--house-needles", { roughness: 0.9, flatShading: true })
    };
    tokenMats.push([mat.glass, "--house-glow", "emissive"]);
    const lineMat = (opacity) => {
      const m = new T.LineBasicMaterial({ transparent: true, opacity, depthWrite: false });
      tokenMats.push([m, "--scene-ghost", "color"]);
      return m;
    };

    /* ---------- Timeline ---------- */
    const house = new T.Group();
    scene.add(house);
    const timeline = [];
    const dummy = new T.Object3D();
    const shadowy = o => { o.castShadow = true; o.receiveShadow = true; return o; };
    // Коробка с точкой привязки: "center" | "bottom" (растёт вверх) | "back" (растёт по +z)
    function box(w, h, d, m, x, y, z, anchor) {
      const g = new T.BoxGeometry(w, h, d);
      if (anchor === "bottom") g.translate(0, h / 2, 0);
      if (anchor === "back") g.translate(0, 0, d / 2);
      const o = shadowy(new T.Mesh(g, m));
      o.position.set(x, y, z);
      return o;
    }
    function on(start, dur, update) { timeline.push({ start, dur, update }); }
    function show(o, t) { o.visible = t > 0.001; }
    // готовые сценарии появления
    function grow(o, axis, start, dur) {
      house.add(o);
      on(start, dur, (e, t) => { show(o, t); o.scale[axis] = Math.max(0.001, e); });
    }
    function drop(o, height, start, dur) {
      house.add(o);
      const y = o.position.y;
      on(start, dur, (e, t) => { show(o, t); o.position.y = y + (1 - e) * height; });
    }
    function slide(o, dx, dz, start, dur) {
      house.add(o);
      const { x, z } = o.position;
      on(start, dur, (e, t) => { show(o, t); o.position.x = x + (1 - e) * dx; o.position.z = z + (1 - e) * dz; });
    }

    /* ---------- Окружение: земля, сугробы, ели ---------- */
    const ground = new T.Mesh(new T.CircleGeometry(160, 64), mat.snow);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const DRIFTS = [[-9, 7, 2.6], [10, 6, 2.2], [-12, -3, 3], [8, -9, 2.4], [14, -1, 1.8], [-5, -11, 2.8], [3, 12, 2]];
    const drifts = shadowy(new T.InstancedMesh(new T.SphereGeometry(1, 18, 10), mat.snow, DRIFTS.length));
    DRIFTS.forEach(([x, z, s], i) => {
      dummy.position.set(x, 0, z); dummy.rotation.set(0, i, 0); dummy.scale.set(s, s * 0.22, s * 0.7);
      dummy.updateMatrix(); drifts.setMatrixAt(i, dummy.matrix);
    });
    scene.add(drifts);

    const PINES = [[-13, -9, 1.3], [-16, 2, 1.1], [-11, -15, 1.5], [12, -12, 1.4], [16, -3, 1.2], [9, -17, 1.6],
      [-18, -6, 1.0], [18, 7, 1.1], [-15, 11, 0.9], [3, -19, 1.3], [-6, -18, 1.2], [20, -10, 1.4]];
    [[0.2, 1.6, 0.8, mat.trunk, true], [2.6, 2.4, 2.2], [2.0, 2.2, 3.5], [1.3, 2.0, 4.7], [0.7, 1.4, 5.7]].forEach(([r, h, y, m, trunk]) => {
      const geo = trunk ? new T.CylinderGeometry(r * 0.8, r, h, 8) : new T.ConeGeometry(r, h, 9);
      const im = shadowy(new T.InstancedMesh(geo, m || mat.needles, PINES.length));
      PINES.forEach(([x, z, s], i) => {
        dummy.position.set(x, y * s, z); dummy.rotation.set(0, i * 1.7, 0); dummy.scale.setScalar(s);
        dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix);
      });
      scene.add(im);
    });

    /* ---------- Постройка собирается из параметров (конструктор) ---------- */
    // P.type: "house" | "barrel" (баня-бочка) | "greenhouse" (арочная теплица: P.arc — шаг дуг, м; P.profile: "20x20" | "20x30")
    // P.length, P.width (м); P.roof: "gable" | "shed" | "flat" | "barn"; P.floors: "one" | "mansard"
    // P.walls: "frame" | "timber" | "gas"; P.facade, P.roofColor, P.trim: css-цвет или "" (цвет шаблона)
    // P.wood: "natural" | "light" | "dark"; P.panoramic, P.terrace: bool
    const DEFAULTS = { type: "house", length: 10, width: 8, roof: "gable", floors: "one", walls: "frame",
      facade: "", roofColor: "", trim: "", wood: "natural", panoramic: false, terrace: true };
    const WOOD = { natural: "", light: "#d9b27c", dark: "#6b4529" };
    let P = Object.assign({}, DEFAULTS, opts.house || {});
    const baseTokenMats = tokenMats.length; // материалы постройки пересоздаются при каждой перестройке
    let plan = null, ghost = null, planGeo = null, planMat = null, ghostMat = null, planCount = 0;
    const cutPlane = new T.Plane(new T.Vector3(0, 0, -1), 1000); // разрез: включён, когда constant = 0
    mat.glass.clippingPlanes = [cutPlane];
    mat.door.clippingPlanes = [cutPlane];
    let dims = { W: 10, D: 8 };

    // какой параметр конструктора перекрашивает материал
    const tag = (m, key) => { m.userData.colorKey = key; return m; };
    function override(key) {
      if (key === "facade") return P.facade;
      if (key === "roof") return P.roofColor;
      if (key === "trim") return P.trim;
      if (key === "wood") return WOOD[P.wood] || "";
      return "";
    }
    function applyColors() {
      const cs = getComputedStyle(document.documentElement);
      for (const [m, token, prop] of tokenMats) {
        const v = (prop === "color" && m.userData.colorKey && override(m.userData.colorKey)) || cs.getPropertyValue(token).trim();
        if (v) m[prop].copy(lin(v));
      }
    }
    // горизонтальный брус: та же текстура досок, повёрнутая на 90°
    function timberMat(rx, ry, clips) {
      const m = boardsMat("--house-timber", rx, ry, null);
      [m.map, m.bumpMap].forEach(t => { t.center.set(0.5, 0.5); t.rotation = Math.PI / 2; t.repeat.set(ry * 2.2, rx); });
      m.clippingPlanes = clips; m.clipShadows = true;
      return tag(m, "wood");
    }
    function wallMat(len, h, clip) {
      const clips = [clip, cutPlane];
      if (P.walls === "timber") return timberMat(len / BOARD, h / 0.9, clips);
      if (P.walls === "gas") return tag(M("--house-gas", { roughness: 0.95, clippingPlanes: clips, clipShadows: true }), "facade");
      const m = boardsMat("--house-wall", len / BOARD, 1, clip);
      m.clippingPlanes = clips;
      return tag(m, "facade");
    }
    function disposeHouse() {
      const keep = new Set(Object.values(mat));
      house.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        (o.material ? [].concat(o.material) : []).forEach(m => {
          if (keep.has(m)) return;
          if (m.map) m.map.dispose();
          if (m.bumpMap) m.bumpMap.dispose();
          m.dispose();
        });
      });
      house.clear();
      [plan, ghost].forEach(o => { if (o) { scene.remove(o); o.geometry.dispose(); o.material.dispose(); } });
      timeline.length = 0;
      tokenMats.length = baseTokenMats;
    }
    function lines(segs, opacity) {
      const g = new T.BufferGeometry();
      g.setAttribute("position", new T.Float32BufferAttribute(segs, 3));
      const m = lineMat(opacity);
      const o = new T.LineSegments(g, m);
      scene.add(o);
      return [o, g, m];
    }
    // чертёж на снегу: контур, оси и размерные линии с засечками
    function drawPlan(W, D) {
      const seg = [], ln = (a, b) => seg.push(...a, ...b), gy = 0.03;
      const ox = W / 2 + 0.3, oz = D / 2 + 0.3;
      ln([-ox, gy, -oz], [ox, gy, -oz]); ln([ox, gy, -oz], [ox, gy, oz]); ln([ox, gy, oz], [-ox, gy, oz]); ln([-ox, gy, oz], [-ox, gy, -oz]);
      for (let x = -W / 2; x <= W / 2 + 0.01; x += W / 4) ln([x, gy, -oz - 1.2], [x, gy, oz + 1.2]);
      for (let z = -D / 2; z <= D / 2 + 0.01; z += D / 4) ln([-ox - 1.2, gy, z], [ox + 1.2, gy, z]);
      const dz = oz + 2.2, dx = ox + 2.2, tk = 0.25;
      ln([-ox, gy, dz], [ox, gy, dz]); ln([-ox - tk, gy, dz + tk], [-ox + tk, gy, dz - tk]); ln([ox - tk, gy, dz + tk], [ox + tk, gy, dz - tk]);
      ln([-ox, gy, oz], [-ox, gy, dz + 0.4]); ln([ox, gy, oz], [ox, gy, dz + 0.4]);
      ln([dx, gy, -oz], [dx, gy, oz]); ln([dx - tk, gy, -oz - tk], [dx + tk, gy, -oz + tk]); ln([dx - tk, gy, oz - tk], [dx + tk, gy, oz + tk]);
      ln([ox, gy, -oz], [dx + 0.4, gy, -oz]); ln([ox, gy, oz], [dx + 0.4, gy, oz]);
      [plan, planGeo, planMat] = lines(seg, 0.9);
      planCount = seg.length / 3;
    }

    function buildHouse() {
      disposeHouse();
      LOOK.y = P.type === "greenhouse" ? 1.1 : 2.3;
      if (P.type === "barrel") buildBarrel(); else if (P.type === "greenhouse") buildGreenhouse(); else buildFramed();
      applyColors();
    }

    /* ---------- Дом или баня с кровлей ---------- */
    function buildFramed() {
      const W = P.length, D = P.width, roof = P.roof;
      const mansard = P.floors === "mansard" && roof !== "flat";
      const y0 = 0.5, H = mansard ? 3.1 : 2.8, top = y0 + H, half = D / 2;
      const wz = D / 2 + 0.11, wx = W / 2 + 0.11;
      const single = roof === "shed" || roof === "flat";
      const rise = roof === "flat" ? 0.35 : roof === "shed" ? D * (mansard ? 0.45 : 0.28)
        : roof === "barn" ? D * 0.62 : D * (mansard ? 0.5 : 0.3);
      const ov = roof === "barn" ? 0.12 : 0.7;          // свес кровли
      const roofW = W + (roof === "barn" ? 0.14 : 1.2);
      dims = { W, D };

      const frameMat = M("--house-frame", { roughness: 0.75, clippingPlanes: [cutPlane], clipShadows: true });
      const woolMat = M("--house-wool", { roughness: 1, clipShadows: true });
      const roofMat = tag(M("--house-roof", { roughness: 0.38, metalness: 0.55, clippingPlanes: [cutPlane], clipShadows: true }), "roof");
      const trimMat = tag(M("--house-trim", { roughness: 0.6, clippingPlanes: [cutPlane] }), "trim");
      const capSnow = M("--scene-snow", { roughness: 1, clippingPlanes: [cutPlane] });

      // скаты: [центр y, центр z, наклон, длина]; высота кровли в точке z — для трубы и контура
      const planes = [];
      if (single) {
        const th = Math.atan2(rise, D);
        const b = [-half - 0.3 * Math.cos(th), top + rise + 0.09 + 0.3 * Math.sin(th)];
        const f = [half + ov * Math.cos(th), top + 0.09 - ov * Math.sin(th)];
        planes.push({ y: (b[1] + f[1]) / 2, z: (b[0] + f[0]) / 2, rx: th, L: Math.hypot(f[0] - b[0], f[1] - b[1]) });
      } else {
        const th = Math.atan2(rise, half), L = Math.hypot(half, rise) + ov, ridge = top + rise + 0.09;
        [1, -1].forEach(s => planes.push({ y: ridge - Math.sin(th) * L / 2, z: s * Math.cos(th) * L / 2, rx: s * th, L }));
      }
      const roofAt = z => single ? top + 0.09 + rise * (half - z) / D : top + rise + 0.09 - Math.abs(z) * rise / half;

      drawPlan(W, D);
      // призрачный контур: коробка стен и рёбра скатов
      const gs = [], gl = (a, b) => gs.push(...a, ...b);
      const bx = W / 2 + 0.22, bz = D / 2 + 0.22;
      [[-bx, -bz], [bx, -bz], [bx, bz], [-bx, bz]].forEach(([x, z], i, a) => {
        const [nx, nz] = a[(i + 1) % 4];
        gl([x, y0, z], [nx, y0, nz]); gl([x, top, z], [nx, top, nz]); gl([x, y0, z], [x, top, z]);
      });
      planes.forEach(pl => {
        const u = [0, -Math.sin(pl.rx) * pl.L / 2, Math.cos(pl.rx) * pl.L / 2];
        const c = [[-roofW / 2, -1], [roofW / 2, -1], [roofW / 2, 1], [-roofW / 2, 1]].map(([x, k]) => [x, pl.y + k * u[1], pl.z + k * u[2]]);
        c.forEach((p0, i) => gl(p0, c[(i + 1) % 4]));
      });
      [ghost, , ghostMat] = lines(gs, 0.35);

      /* Этап 1. Фундамент */
      grow(box(W + 1.0, 0.3, D + 1.0, mat.insulation, 0, 0, 0, "bottom"), "y", 0.3, 0.35);
      grow(box(W + 0.6, 0.22, D + 0.6, mat.slab, 0, 0.28, 0, "bottom"), "y", 0.55, 0.4);

      /* Этап 2. Каркас: обвязка, стойки волной по периметру, верхняя обвязка */
      [[W, 0, D / 2 - 0.1, "x"], [W, 0, -D / 2 + 0.1, "x"], [D, W / 2 - 0.05, 0, "z"], [D, -W / 2 + 0.05, 0, "z"]].forEach(([len, x, z, ax], i) => {
        grow(ax === "x" ? box(len, 0.08, 0.18, frameMat, x, y0 + 0.04, z) : box(0.18, 0.08, len, frameMat, x, y0 + 0.04, z), ax, 1.0 + i * 0.04, 0.2);
      });
      const studPos = [];
      for (let x = -W / 2 + 0.05; x <= W / 2; x += 0.6) studPos.push([x, D / 2 - 0.1, 0], [x, -D / 2 + 0.1, 0]);
      for (let z = -D / 2 + 0.6; z < D / 2 - 0.2; z += 0.6) studPos.push([W / 2 - 0.05, z, 1], [-W / 2 + 0.05, z, 1]);
      studPos.sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
      const studGeo = new T.BoxGeometry(0.06, H, 0.18);
      studGeo.translate(0, H / 2, 0);
      const studs = shadowy(new T.InstancedMesh(studGeo, frameMat, studPos.length));
      studs.instanceMatrix.setUsage(T.DynamicDrawUsage);
      house.add(studs);
      studPos.forEach(([x, z, rot], i) => {
        on(1.15 + 0.55 * (i / studPos.length), 0.22, (e, t) => {
          dummy.position.set(x, y0 + 0.08, z);
          dummy.rotation.set(0, rot ? Math.PI / 2 : 0, 0);
          if (t > 0.001) dummy.scale.set(1, Math.max(0.001, e), 1); else dummy.scale.setScalar(0);
          dummy.updateMatrix();
          studs.setMatrixAt(i, dummy.matrix);
          studs.instanceMatrix.needsUpdate = true;
        });
      });
      [[W, 0, D / 2 - 0.1, false], [W, 0, -D / 2 + 0.1, false], [D, W / 2 - 0.05, 0, true], [D, -W / 2 + 0.05, 0, true]].forEach(([len, x, z, side], i) => {
        drop(side ? box(0.18, 0.08, len, frameMat, x, top, z) : box(len, 0.08, 0.18, frameMat, x, top, z), 0.8, 1.72 + i * 0.05, 0.22);
      });

      /* Этап 3. Утеплитель между стойками, затем обшивка снизу вверх, окна въезжают снаружи */
      const woolClip = new T.Plane(new T.Vector3(0, -1, 0), y0);
      woolMat.clippingPlanes = [woolClip, cutPlane];
      const wool = [
        box(W - 0.1, H - 0.1, 0.12, woolMat, 0, y0 + H / 2, D / 2 - 0.1), box(W - 0.1, H - 0.1, 0.12, woolMat, 0, y0 + H / 2, -D / 2 + 0.1),
        box(0.12, H - 0.1, D - 0.4, woolMat, W / 2 - 0.05, y0 + H / 2, 0), box(0.12, H - 0.1, D - 0.4, woolMat, -W / 2 + 0.05, y0 + H / 2, 0)
      ];
      wool.forEach(o => house.add(o));
      on(1.95, 0.45, (e, t) => { wool.forEach(o => show(o, t)); woolClip.constant = y0 + H * e + 0.001; });

      const wallClip = new T.Plane(new T.Vector3(0, -1, 0), y0);
      const backH = single ? H + rise : H; // у односкатной кровли задняя стена выше
      const wallFront = wallMat(W + 0.44, H, wallClip), wallBack = wallMat(W + 0.44, backH, wallClip), wallSide = wallMat(D, H, wallClip);
      const walls = [
        box(W + 0.44, H, 0.22, wallFront, 0, y0 + H / 2, wz), box(W + 0.44, backH, 0.22, wallBack, 0, y0 + backH / 2, -wz),
        box(0.22, H, D, wallSide, wx, y0 + H / 2, 0), box(0.22, H, D, wallSide, -wx, y0 + H / 2, 0)
      ];
      walls.forEach(w => house.add(w));
      on(2.25, 0.6, (e, t) => { walls.forEach(w => show(w, t)); wallClip.constant = y0 + backH * e + 0.001; });

      function win(x, y, z, w, h, axis, st) {
        const g = new T.Group();
        const n = axis === "x" ? [0, Math.sign(z)] : [Math.sign(x), 0];
        g.add(box(...(axis === "x" ? [w + 0.2, h + 0.2, 0.05] : [0.05, h + 0.2, w + 0.2]), trimMat, n[0] * 0.13, 0, n[1] * 0.13));
        g.add(box(...(axis === "x" ? [w, h, 0.04] : [0.04, h, w]), mat.glass, n[0] * 0.16, 0, n[1] * 0.16));
        g.position.set(x, y, z);
        // встаёт в проём, когда обшивка уже дошла до верха стены
        slide(g, n[0] * 0.45, n[1] * 0.45, st + 0.3, 0.25);
      }
      const doorX = W * 0.06;
      if (P.panoramic) {
        // панорамное остекление на фасад: окна в пол по обе стороны от двери
        const left = (doorX - 0.7) - (-W / 2 + 0.6), right = (W / 2 - 0.6) - (doorX + 0.7);
        if (left > 1) win(-W / 2 + 0.6 + left / 2, y0 + 1.25, wz, left, 2.3, "x", 2.6);
        if (right > 1) win(doorX + 0.7 + right / 2, y0 + 1.25, wz, right, 2.3, "x", 2.64);
      } else {
        win(-W * 0.24, y0 + 1.45, wz, Math.min(3.4, W * 0.34), 2.1, "x", 2.6);
        if (W >= 7) win(W * 0.31, y0 + 1.6, wz + (P.walls === "frame" ? 0.04 : 0), 1.2, 1.4, "x", 2.66);
      }
      const backN = Math.max(1, Math.round(W / 4.5));
      for (let i = 0; i < backN; i++) win(-W / 2 + (W / backN) * (i + 0.5), y0 + 1.6, -wz, 1.4, 1.3, "x", 2.7 + i * 0.03);
      if (D >= 5) { win(wx, y0 + 1.6, -D * 0.19, 1.3, 1.4, "z", 2.78); win(-wx, y0 + 1.6, D * 0.18, 1.3, 1.4, "z", 2.82); }

      /* Этап 4. Фронтоны и кровля */
      const gableClip = new T.Plane(new T.Vector3(0, -1, 0), top);
      const gable = new T.Shape();
      // форма в координатах (z, y); после поворота x формы смотрит в −z, поэтому высокая сторона односкатной — справа
      if (single) { gable.moveTo(-half - 0.11, 0); gable.lineTo(half + 0.11, 0); gable.lineTo(half + 0.11, rise + 0.07); }
      else { gable.moveTo(-half - 0.11, 0); gable.lineTo(half + 0.11, 0); gable.lineTo(0, rise + 0.07); }
      gable.closePath();
      const gGeo = new T.ExtrudeGeometry(gable, { depth: 0.22, bevelEnabled: false });
      gGeo.translate(0, 0, -0.11); gGeo.rotateY(Math.PI / 2);
      const gMat = P.walls === "gas" ? tag(M("--house-gas", { roughness: 0.95, clippingPlanes: [gableClip, cutPlane] }), "facade")
        : P.walls === "timber" ? timberMat(1 / BOARD, 1 / 0.9, [gableClip, cutPlane])
        : (() => { const m = boardsMat("--house-wall", 1 / BOARD, 1 / H, gableClip); m.clippingPlanes = [gableClip, cutPlane]; return tag(m, "facade"); })();
      const gables = [wx, -wx].map(x => { const g = shadowy(new T.Mesh(gGeo, gMat)); g.position.set(x, top, 0); house.add(g); return g; });
      on(3.0, 0.35, (e, t) => { gables.forEach(g => show(g, t)); gableClip.constant = top + (rise + 0.1) * e + 0.001; });
      if (!single && rise > 1.6) win(wx, top + rise * 0.36, 0, P.panoramic || roof === "barn" ? 1.6 : 0.8, P.panoramic || roof === "barn" ? 1.4 : 0.8, "z", 3.3);
      if (!single && mansard) win(-wx, top + rise * 0.36, 0, 1.0, 1.0, "z", 3.32);

      const seamGeo = new T.BoxGeometry(0.035, 0.045, 1);
      const seamCount = Math.floor(roofW / 0.5);
      planes.forEach((pl, i) => {
        const r = box(roofW, 0.14, pl.L, roofMat, 0, pl.y, pl.z);
        const seams = shadowy(new T.InstancedMesh(seamGeo, roofMat, seamCount)); // фальцы
        for (let k = 0; k < seamCount; k++) {
          dummy.position.set(-roofW / 2 + 0.25 + k * 0.5, 0.09, 0); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, pl.L);
          dummy.updateMatrix(); seams.setMatrixAt(k, dummy.matrix);
        }
        r.add(seams);
        house.add(r);
        on(3.35 + i * 0.15, 0.45, (e, t) => {
          show(r, t);
          r.rotation.x = pl.rx * (0.15 + 0.85 * e); // из почти горизонтали в уклон
          r.position.y = pl.y + (1 - e) * 2.4;
          r.position.z = pl.z * (0.4 + 0.6 * e);
        });
        const n = [0, Math.cos(pl.rx), Math.sin(pl.rx)];
        const cap = box(roofW - 0.4, 0.1, pl.L - 0.5, capSnow, 0, pl.y + n[1] * 0.14, pl.z + n[2] * 0.14);
        cap.rotation.x = pl.rx;
        drop(cap, 1.0, 4.55 + i * 0.1, 0.35);
      });
      if (roof !== "flat") {
        const cx = -W * 0.26, cz = single ? -D * 0.1 : -D * 0.19, ra = roofAt(cz), topY = Math.max(ra + 0.9, single ? ra + 0.9 : top + rise + 0.9);
        grow(box(0.6, topY - ra + 0.3, 0.6, mat.slab, cx, ra - 0.3, cz, "bottom"), "y", 3.85, 0.2);
      }

      /* Этап 5. Под ключ */
      if (P.walls === "frame" && !P.panoramic && W >= 7)
        grow(box(Math.min(3.0, W * 0.3), H - 0.1, 0.04, tag(boardsMat("--house-trim", 3.0 / BOARD, 1), "trim"), W * 0.31, y0 + 0.05, wz + 0.13, "bottom"), "y", 4.0, 0.3);
      slide(box(1.0, 2.2, 0.06, mat.door, doorX, y0 + 1.1, wz + 0.14), 1.1, 0, 4.1, 0.25);
      if (P.terrace) {
        const tw = Math.min(6, W * 0.6), tx = -W / 2 + tw / 2 + 0.3;
        const deck = tag(boardsMat("--house-trim", tw / BOARD, 1), "wood");
        grow(box(tw, 0.18, 2.4, deck, tx, 0.36, D / 2 + 0.3, "back"), "z", 4.2, 0.3);
        const fz = D / 2 + 2.62, bz = D / 2 + 0.42, x0 = tx - tw / 2 + 0.07, x1 = tx + tw / 2 - 0.07, dy = 0.45, rh = 0.9;
        const gc = Math.min(x1 - 0.9, Math.max(x0 + 0.9, doorX)), g0 = gc - 0.6, g1 = gc + 0.6;
        const posts = [[x0, fz], [g0, fz], [g1, fz], [x1, fz], [x0, bz], [x1, bz], [x0, (fz + bz) / 2], [x1, (fz + bz) / 2]];
        if (g0 - x0 > 2.4) posts.push([(x0 + g0) / 2, fz]);
        if (x1 - g1 > 2.4) posts.push([(g1 + x1) / 2, fz]);
        posts.forEach(([x, z], i) => grow(box(0.09, rh, 0.09, trimMat, x, dy, z, "bottom"), "y", 4.35 + i * 0.02, 0.2));
        [rh, rh * 0.5].forEach((h, k) => {
          const y = dy + h - 0.03, st = 4.5 + k * 0.05;
          [[x0, g0], [g1, x1]].forEach(([a, b]) => { if (b - a > 0.2) grow(box(b - a, 0.06, 0.07, trimMat, (a + b) / 2, y, fz), "x", st, 0.2); });
          [x0, x1].forEach(x => grow(box(0.07, 0.06, fz - bz, trimMat, x, y, (fz + bz) / 2), "z", st, 0.2));
        });
        grow(box(1.2, 0.18, 0.42, deck, gc, 0.2, fz + 0.1, "back"), "z", 4.45, 0.2);
      }
    }

    /* ---------- Баня-бочка ---------- */
    function buildBarrel() {
      const Lb = P.length, R = 1.15, cy = 0.4 + R;
      dims = { W: Lb + 1, D: 2.4 };
      const woodMat = (rx, clip) => { const m = boardsMat("--house-timber", rx, 1, clip); m.side = T.DoubleSide; m.clippingPlanes = [clip, cutPlane].filter(Boolean); return tag(m, "wood"); };
      const hoopMat = tag(M("--house-roof", { roughness: 0.35, metalness: 0.6, clippingPlanes: [cutPlane] }), "roof");
      const trimMat = tag(M("--house-trim", { roughness: 0.6, clippingPlanes: [cutPlane] }), "trim");
      const frameMat = M("--house-frame", { roughness: 0.75, clippingPlanes: [cutPlane] });
      const capSnow = M("--scene-snow", { roughness: 1, clippingPlanes: [cutPlane] });

      drawPlan(Lb, 2.4);
      const gs = [], gl = (a, b) => gs.push(...a, ...b);
      [-Lb / 2, Lb / 2].forEach(x => { for (let i = 0; i < 32; i++) { const a = i / 32 * Math.PI * 2, b = (i + 1) / 32 * Math.PI * 2; gl([x, cy + Math.sin(a) * R, Math.cos(a) * R], [x, cy + Math.sin(b) * R, Math.cos(b) * R]); } });
      [0, Math.PI / 2, Math.PI, Math.PI * 1.5].forEach(a => gl([-Lb / 2, cy + Math.sin(a) * R, Math.cos(a) * R], [Lb / 2, cy + Math.sin(a) * R, Math.cos(a) * R]));
      [ghost, , ghostMat] = lines(gs, 0.35);

      /* Этап 1. Основание: щебёночная подушка и опоры-ложементы */
      grow(box(Lb + 1.2, 0.12, 3.0, mat.insulation, 0, 0, 0, "bottom"), "y", 0.3, 0.3);
      const cradles = Math.max(2, Math.round(Lb / 1.6));
      for (let i = 0; i < cradles; i++) grow(box(0.22, 0.42, 2.0, mat.slab, -Lb / 2 + 0.4 + (Lb - 0.8) * i / (cradles - 1), 0.1, 0, "bottom"), "y", 0.5 + i * 0.08, 0.3);

      /* Этап 2. Кольца-шпангоуты */
      const ringGeo = new T.TorusGeometry(R - 0.06, 0.05, 6, 40);
      ringGeo.rotateY(Math.PI / 2);
      const rings = Math.max(3, Math.round(Lb / 0.9));
      for (let i = 0; i < rings; i++) {
        const r = shadowy(new T.Mesh(ringGeo, frameMat));
        r.position.set(-Lb / 2 + 0.1 + (Lb - 0.2) * i / (rings - 1), cy, 0);
        house.add(r);
        on(1.1 + 0.6 * i / rings, 0.25, (e, t) => { show(r, t); r.scale.setScalar(Math.max(0.001, e)); });
      }
      const bench = box(Lb * 0.8, 0.08, 0.5, frameMat, 0, cy - 0.35, -0.45);
      grow(bench, "x", 1.8, 0.2);

      /* Этап 3. Обшивка ламелями снизу вверх */
      const wallClip = new T.Plane(new T.Vector3(0, -1, 0), 0.4);
      const shellGeo = new T.CylinderGeometry(R, R, Lb, 56, 1, true);
      shellGeo.rotateZ(Math.PI / 2);
      const shell = shadowy(new T.Mesh(shellGeo, woodMat(2 * Math.PI * R / 1.1, wallClip)));
      shell.position.y = cy;
      house.add(shell);
      on(2.0, 0.8, (e, t) => { show(shell, t); wallClip.constant = 0.4 + 2 * R * e + 0.001; });

      /* Этап 4. Торцы, дверь, окно, стяжные обручи, труба */
      const endGeo = new T.CylinderGeometry(R - 0.02, R - 0.02, 0.1, 56);
      endGeo.rotateZ(Math.PI / 2);
      const endMat = woodMat(2 * Math.PI * R / 1.6, null);
      [Lb / 2 - 0.05, -Lb / 2 + 0.05].forEach((x, i) => {
        const e = shadowy(new T.Mesh(endGeo, endMat));
        e.position.set(x, cy, 0);
        slide(e, i ? -1.2 : 1.2, 0, 3.0 + i * 0.1, 0.3);
      });
      const hoopGeo = new T.TorusGeometry(R + 0.02, 0.025, 6, 48);
      hoopGeo.rotateY(Math.PI / 2);
      [-Lb / 2 + 0.35, 0, Lb / 2 - 0.35].forEach((x, i) => {
        const h = shadowy(new T.Mesh(hoopGeo, hoopMat));
        h.position.set(x, cy, 0);
        drop(h, 1.5, 3.3 + i * 0.08, 0.3);
      });
      const winGeo = new T.CylinderGeometry(0.28, 0.28, 0.06, 28);
      winGeo.rotateZ(Math.PI / 2);
      const rw = new T.Mesh(winGeo, mat.glass);
      rw.position.set(-Lb / 2 - 0.02, cy + 0.15, 0);
      slide(rw, -0.4, 0, 3.4, 0.25);
      if (P.panoramic) { const pw = box(0.06, 1.5, 1.4, mat.glass, Lb / 2 + 0.02, cy - 0.05, -0.45); slide(pw, 0.4, 0, 3.45, 0.25); }
      const pipe = shadowy(new T.Mesh(new T.CylinderGeometry(0.09, 0.09, 1.3, 16), hoopMat));
      pipe.position.set(-Lb / 4, cy + R + 0.3, 0);
      drop(pipe, 1.5, 3.8, 0.2);

      /* Этап 5. Дверь, терраса, снег на крыше */
      slide(box(0.06, 1.7, 0.75, mat.door, Lb / 2 + 0.03, cy - 0.15, P.panoramic ? 0.45 : 0), 1.0, 0, 4.1, 0.25);
      if (P.terrace) {
        const deck = box(1.6, 0.12, 2.4, tag(boardsMat("--house-trim", 1.6 / BOARD, 1), "wood"), Lb / 2 + 0.85, 0.38, 0);
        grow(deck, "x", 4.2, 0.3);
      }
      const snowGeo = new T.CylinderGeometry(R + 0.06, R + 0.06, Lb * 0.92, 24, 1, true, Math.PI / 2 - 0.75, 1.5);
      snowGeo.rotateZ(Math.PI / 2);
      const snowCap = new T.Mesh(snowGeo, capSnow);
      snowCap.position.y = cy;
      drop(snowCap, 1.0, 4.55, 0.35);
    }

    /* ---------- Арочная теплица из поликарбоната ---------- */
    // Этапы: основание → дуги → связи и торцы → поликарбонат → двери, форточка, грядки
    class ArcCurve extends T.Curve {
      constructor(half, h, y0) { super(); this.half = half; this.h = h; this.y0 = y0; }
      getPoint(u, out = new T.Vector3()) { const t = Math.PI * u; return out.set(0, this.y0 + this.h * Math.sin(t), this.half * Math.cos(t)); }
    }
    function buildGreenhouse() {
      const L = P.length, W = P.width, step = +P.arc || 0.65, thick = P.profile === "20x30";
      const half = W / 2, H = W < 2.8 ? 2.0 : 2.1, y0 = 0.12, tubeR = thick ? 0.03 : 0.022;
      const arcY = z => y0 + H * Math.sqrt(Math.max(0, 1 - (z / half) * (z / half)));
      dims = { W: L * 0.6 + 1, D: 4.4 }; // камера ближе: теплица ниже и уже дома
      const steel = M("--house-steel", { roughness: 0.3, metalness: 0.75, clippingPlanes: [cutPlane] });
      const polyMat = () => M("--house-poly", { roughness: 0.1, metalness: 0, transparent: true, opacity: 0.42, side: T.DoubleSide, depthWrite: false, envMapIntensity: 1.6 });
      const poly = polyMat(); poly.clippingPlanes = [cutPlane];
      const soil = M("--house-soil", { roughness: 1, clippingPlanes: [cutPlane] });
      const leaf = M("--house-plant", { roughness: 0.8, flatShading: true, clippingPlanes: [cutPlane] });
      const fruit = M("--house-fruit", { roughness: 0.35, clippingPlanes: [cutPlane] });

      drawPlan(L, W);
      const gs = [], gl = (a, b) => gs.push(...a, ...b);
      [-L / 2, L / 2].forEach(x => { for (let i = 0; i < 24; i++) { const a = Math.PI * i / 24, b = Math.PI * (i + 1) / 24; gl([x, y0 + H * Math.sin(a), half * Math.cos(a)], [x, y0 + H * Math.sin(b), half * Math.cos(b)]); } });
      [0, Math.PI / 2, Math.PI].forEach(a => gl([-L / 2, y0 + H * Math.sin(a), half * Math.cos(a)], [L / 2, y0 + H * Math.sin(a), half * Math.cos(a)]));
      [ghost, , ghostMat] = lines(gs, 0.35);

      /* Этап 1. Подготовленная площадка и оцинкованное основание */
      grow(box(L + 1.0, 0.05, W + 1.0, soil, 0, 0, 0, "bottom"), "y", 0.3, 0.3);
      [[L, 0.1, 0.05, 0, half, "x"], [L, 0.1, 0.05, 0, -half, "x"], [0.05, 0.1, W, L / 2, 0, "z"], [0.05, 0.1, W, -L / 2, 0, "z"]].forEach(([w, h, d, x, z, ax], i) =>
        grow(box(w, h, d, steel, x, 0.05, z, "bottom"), ax, 0.55 + i * 0.06, 0.3));
      for (let x = -L / 2; x <= L / 2 + 0.01; x += 2) [half, -half].forEach((z, k) => grow(box(0.04, 0.35, 0.04, steel, x, -0.2, z, "bottom"), "y", 0.75 + k * 0.03, 0.2));

      /* Этап 2. Дуги встают одна за другой с выбранным шагом */
      const n = Math.max(1, Math.round(L / step));
      for (let i = 0; i <= n; i++) {
        const g = new T.TubeGeometry(new ArcCurve(half, H, y0), 40, tubeR, 4, false);
        const m = shadowy(new T.Mesh(g, steel));
        m.position.x = -L / 2 + L * i / n;
        house.add(m);
        const total = g.index.count;
        on(1.0 + 0.75 * i / (n + 1), 0.28, (e, t) => { show(m, t); g.setDrawRange(0, Math.ceil(total * e / 6) * 6); });
      }

      /* Этап 3. Продольные связи и каркас торцов: стойки, дверной проём, форточка */
      [0.32, 0.95, Math.PI / 2, Math.PI - 0.95, Math.PI - 0.32].forEach((a, k) => {
        const r = box(L, 0.024, 0.024, steel, 0, y0 + (H - tubeR) * Math.sin(a), (half - tubeR) * Math.cos(a));
        r.rotation.x = -a;
        grow(r, "x", 2.0 + k * 0.08, 0.3);
      });
      const dz = 0.42, doorTop = y0 + 1.65;
      [L / 2, -L / 2].forEach((x, e) => {
        [dz, -dz, half * 0.62, -half * 0.62].forEach((z, k) => {
          const h = arcY(z) - y0;
          grow(box(0.035, h, 0.035, steel, x, y0, z, "bottom"), "y", 2.3 + e * 0.1 + k * 0.03, 0.25);
        });
        [doorTop, doorTop + 0.07].forEach((y, k) => grow(box(0.035, 0.035, dz * 2, steel, x, y, 0), "z", 2.55 + e * 0.1 + k * 0.04, 0.2));
      });

      /* Этап 4. Поликарбонат: листы ложатся вдоль теплицы, затем закрываются торцы */
      const o = tubeR + 0.006, SEGS = 48;
      const pos = [], idx = [];
      for (let i = 0; i <= SEGS; i++) {
        const t = Math.PI * i / SEGS, z = (half + o) * Math.cos(t), y = y0 + (H + o) * Math.sin(t);
        pos.push(-L / 2, y, z, L / 2, y, z);
        if (i < SEGS) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
      const skinGeo = new T.BufferGeometry();
      skinGeo.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
      skinGeo.setIndex(idx);
      skinGeo.computeVertexNormals();
      const skinClip = new T.Plane(new T.Vector3(-1, 0, 0), -L / 2);
      const skinMat = polyMat(); skinMat.clippingPlanes = [skinClip, cutPlane];
      const skin = new T.Mesh(skinGeo, skinMat);
      skin.renderOrder = 2;
      house.add(skin);
      on(2.9, 0.8, (e, t) => { show(skin, t); skinClip.constant = -L / 2 + (L + 0.2) * e; });
      // торцы с проёмами под дверь и форточку
      const endShape = new T.Shape();
      endShape.moveTo(half + o, y0);
      for (let i = 1; i <= SEGS; i++) { const t = Math.PI * i / SEGS; endShape.lineTo((half + o) * Math.cos(t), y0 + (H + o) * Math.sin(t)); }
      endShape.closePath();
      const hole = (x0, x1, ya, yb) => { const hp = new T.Path(); hp.moveTo(x0, ya); hp.lineTo(x1, ya); hp.lineTo(x1, yb); hp.lineTo(x0, yb); hp.closePath(); return hp; };
      endShape.holes.push(hole(-dz, dz, y0 + 0.02, doorTop), hole(-dz, dz, doorTop + 0.09, arcY(dz) - 0.08));
      const endGeo = new T.ShapeGeometry(endShape, 2);
      endGeo.rotateY(Math.PI / 2);
      [L / 2 + 0.02, -L / 2 - 0.02].forEach((x, i) => {
        const m = new T.Mesh(endGeo, poly);
        m.position.x = x; m.renderOrder = 2;
        grow(m, "y", 3.55 + i * 0.12, 0.3);
      });

      /* Этап 5. Двери (передняя приоткрыта), форточки, грядки и рассада */
      [L / 2 + 0.03, -L / 2 - 0.03].forEach((x, i) => {
        const pivot = new T.Group();
        pivot.position.set(x, y0, -dz);
        const door = new T.Group();
        const dh = doorTop - y0 - 0.03;
        door.add(box(0.03, dh, dz * 2, poly, 0, dh / 2, dz));
        [[0.035, dh, 0.03, 0, dh / 2, 0.015], [0.035, dh, 0.03, 0, dh / 2, dz * 2 - 0.015], [0.035, 0.03, dz * 2, 0, 0.015, dz], [0.035, 0.03, dz * 2, 0, dh - 0.015, dz], [0.035, 0.03, dz * 2, 0, dh * 0.5, dz]]
          .forEach(([w, h, d, bx, by, bz]) => door.add(box(w, h, d, steel, bx, by, bz)));
        pivot.add(door);
        house.add(pivot);
        const out = i ? -1 : 1;
        on(4.0 + i * 0.08, 0.3, (e, t) => {
          show(pivot, t);
          pivot.position.x = x + out * (1 - e) * 0.5;
          pivot.rotation.y = i ? 0 : -out * 1.05 * span(e, 0.6, 1); // передняя дверь открывается наружу
        });
        const vent = box(0.03, arcY(dz) - doorTop - 0.17, dz * 2 - 0.04, poly, x, (doorTop + 0.09 + arcY(dz) - 0.08) / 2, 0);
        slide(vent, out * 0.4, 0, 4.12 + i * 0.08, 0.25);
      });
      const path = 0.6, bw = Math.max(0.45, (W - path) / 2 - 0.2), bl = L - 0.6, bh = 0.28;
      const bedWood = timberMat(bl / 1.2, bh / 0.9, [cutPlane]);
      const plants = [];
      [1, -1].forEach((sgn, k) => {
        const z = sgn * (path / 2 + bw / 2);
        const bed = new T.Group();
        bed.add(box(bl, bh, 0.04, bedWood, 0, bh / 2, bw / 2), box(bl, bh, 0.04, bedWood, 0, bh / 2, -bw / 2),
          box(0.04, bh, bw, bedWood, bl / 2, bh / 2, 0), box(0.04, bh, bw, bedWood, -bl / 2, bh / 2, 0),
          box(bl - 0.04, 0.04, bw - 0.04, soil, 0, bh - 0.05, 0));
        bed.position.set(0, y0, z);
        grow(bed, "x", 4.1 + k * 0.08, 0.3);
        for (let x = -bl / 2 + 0.35; x <= bl / 2 - 0.3; x += 0.5) plants.push([x, z]);
      });
      const leafGeo = new T.IcosahedronGeometry(0.17, 0);
      const fruitGeo = new T.SphereGeometry(0.045, 10, 8);
      const leaves = shadowy(new T.InstancedMesh(leafGeo, leaf, plants.length * 2));
      const fruits = new T.InstancedMesh(fruitGeo, fruit, plants.length * 2);
      house.add(leaves, fruits);
      on(4.35, 0.5, e => {
        plants.forEach(([x, z], i) => {
          const s = clamp01(e * 1.6 - (i % 7) * 0.08);
          [[0, 0.22, 1], [0.05, 0.48, 0.8]].forEach(([dx, dy, k], j) => {
            dummy.position.set(x + dx, y0 + bh + dy * s, z);
            dummy.rotation.set(0, i * 1.3 + j, 0);
            dummy.scale.set(s * k, s * k * 1.25, s * k);
            dummy.updateMatrix();
            leaves.setMatrixAt(i * 2 + j, dummy.matrix);
            const f = clamp01(s * 2 - 1);
            dummy.position.set(x + (j ? 0.12 : -0.1), y0 + bh + (j ? 0.38 : 0.2) * s, z + (j ? -0.1 : 0.11));
            dummy.scale.setScalar(Math.max(0.001, f));
            dummy.updateMatrix();
            fruits.setMatrixAt(i * 2 + j, dummy.matrix);
          });
        });
        leaves.instanceMatrix.needsUpdate = fruits.instanceMatrix.needsUpdate = true;
      });
    }
    buildHouse();

    /* ---------- Снег (считает GPU) ---------- */
    const FLAKES = coarse ? 600 : 1000;
    const fPos = new Float32Array(FLAKES * 3), fSpd = new Float32Array(FLAKES), fSeed = new Float32Array(FLAKES);
    for (let i = 0; i < FLAKES; i++) {
      fPos[i * 3] = (Math.random() - 0.5) * 50;
      fPos[i * 3 + 1] = Math.random() * 22;
      fPos[i * 3 + 2] = (Math.random() - 0.5) * 50;
      fSpd[i] = 0.6 + Math.random() * 0.9;
      fSeed[i] = Math.random() * 6.28;
    }
    const fGeo = new T.BufferGeometry();
    fGeo.setAttribute("position", new T.BufferAttribute(fPos, 3));
    fGeo.setAttribute("aSpeed", new T.BufferAttribute(fSpd, 1));
    fGeo.setAttribute("aSeed", new T.BufferAttribute(fSeed, 1));
    const snowMat = new T.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uScale: { value: 400 }, uMax: { value: 6 }, uColor: { value: new T.Color() } },
      vertexShader: `attribute float aSpeed; attribute float aSeed; uniform float uTime; uniform float uScale; uniform float uMax; varying float vA;
        void main(){ vec3 p = position; p.y = mod(p.y - uTime * aSpeed, 22.0);
          p.x += sin(uTime * 0.6 + aSeed) * 0.35; p.z += cos(uTime * 0.5 + aSeed * 1.3) * 0.25;
          vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = min(0.12 * uScale / -mv.z, uMax); // близкие снежинки не превращаются в пятна
          vA = (1.0 - smoothstep(30.0, 70.0, -mv.z)) * smoothstep(0.0, 1.5, p.y); }`,
      fragmentShader: "uniform vec3 uColor; varying float vA; void main(){ float a = smoothstep(0.5, 0.1, length(gl_PointCoord - 0.5)) * vA; if (a < 0.01) discard; gl_FragColor = vec4(uColor, a);" + TM + "}",
      transparent: true, depthWrite: false
    });
    const snow = new T.Points(fGeo, snowMat);
    snow.frustumCulled = false;
    snow.visible = !opts.summer; // летняя сцена (теплицы, сады) — без снегопада
    scene.add(snow);

    /* ---------- Тема: все цвета сцены — из CSS-токенов ---------- */
    let glowMul = 0.25, night = false;
    function readTheme() {
      const cs = getComputedStyle(document.documentElement);
      const tok = n => cs.getPropertyValue(n).trim();
      const col = n => lin(tok(n) || "#808080");
      const sky = col("--scene-sky"), fog = col("--scene-fog");
      night = fog.r + fog.g + fog.b < 0.1;
      scene.fog.color.copy(fog);
      skyMat.uniforms.top.value.copy(sky);
      skyMat.uniforms.bottom.value.copy(fog);
      snowMat.uniforms.uColor.value.copy(col("--scene-flake"));
      applyColors();
      const glowC = col("--house-glow");
      windowLight.color.copy(glowC);
      glowMul = parseFloat(tok("--scene-glow")) || 0.25;
      hemi.color.copy(sky); hemi.groundColor.copy(col("--scene-snow")).multiplyScalar(0.5);
      hemi.intensity = (parseFloat(tok("--scene-hemi")) || 0.9) * 0.6;
      sun.intensity = (parseFloat(tok("--scene-sun")) || 0.95) * (night ? 1.1 : 2.3);
      // солнце — тёплый оттенок свечения окон, луна — холодный оттенок неба
      sun.color.copy(night ? col("--scene-ghost") : glowC.clone().lerp(new T.Color(1, 1, 1), 0.85));
      buildEnv(sky, fog, col("--scene-snow").multiplyScalar(night ? 0.08 : 0.8));
      dirty = true;
    }

    /* ---------- Состояние ---------- */
    let p = reduce ? STAGES : 0, target = STAGES, paused = false, started = reduce;
    let dirty = true, shadowDirty = true, state = "";
    const cam = Object.assign({}, HOME), vel = { yaw: 0, pitch: 0 };
    let goal = null, idle = 0, distScale = 1;

    function emitState() {
      const s = paused || (p >= target && target < STAGES) ? "paused" : p >= STAGES ? "done" : "building";
      if (s !== state) { state = s; opts.onState && opts.onState(s); }
    }
    function setGoal(v) {
      const g = Object.assign({}, v);
      g.yaw += Math.PI * 2 * Math.round((cam.yaw - g.yaw) / (Math.PI * 2)); // кратчайший поворот
      goal = g; idle = 0; dirty = true;
    }
    let interacted = false;
    function interact() {
      idle = 0;
      if (!interacted) { interacted = true; opts.onInteract && opts.onInteract(); }
    }

    /* ---------- Управление ---------- */
    const pointers = new Map();
    let pinch = 0, lastT = 0;
    canvas.addEventListener("pointerdown", e => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      canvas.setPointerCapture(e.pointerId);
      goal = null; vel.yaw = vel.pitch = 0; lastT = performance.now();
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
      interact();
    });
    canvas.addEventListener("pointermove", e => {
      const pt = pointers.get(e.pointerId);
      if (!pt) return;
      const dx = e.clientX - pt.x, dy = e.clientY - pt.y;
      pt.x = e.clientX; pt.y = e.clientY;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0) cam.dist = clamp(cam.dist * pinch / d, LIM.dist[0], LIM.dist[1]);
        pinch = d;
      } else {
        const now = performance.now(), dt = Math.max(8, now - lastT) / 1000;
        lastT = now;
        const dYaw = -dx * 0.006;
        // на сенсорном экране вертикальный жест прокручивает страницу, наклон — только мышью
        const dPitch = pt.type === "touch" ? 0 : dy * 0.004;
        cam.yaw += dYaw;
        cam.pitch = clamp(cam.pitch + dPitch, LIM.pitch[0], LIM.pitch[1]);
        vel.yaw = vel.yaw * 0.5 + (dYaw / dt) * 0.5;
        vel.pitch = vel.pitch * 0.5 + (dPitch / dt) * 0.5;
      }
      idle = 0; dirty = true;
    });
    function release(e) {
      pointers.delete(e.pointerId);
      pinch = 0;
      if (performance.now() - lastT > 80) vel.yaw = vel.pitch = 0; // палец остановился — без инерции
    }
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener("wheel", e => {
      if (!e.ctrlKey && !e.metaKey) return; // обычное колесо прокручивает страницу
      e.preventDefault();
      cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.002), LIM.dist[0], LIM.dist[1]);
      goal = null; dirty = true; interact();
    }, { passive: false });
    canvas.addEventListener("dblclick", () => api.resetView());
    canvas.addEventListener("keydown", e => {
      const k = e.key;
      const step = (dy, dp, dd) => {
        setGoal({ yaw: cam.yaw + dy, pitch: clamp(cam.pitch + dp, LIM.pitch[0], LIM.pitch[1]), dist: clamp(cam.dist * dd, LIM.dist[0], LIM.dist[1]) });
      };
      if (k === "ArrowLeft") step(0.25, 0, 1);
      else if (k === "ArrowRight") step(-0.25, 0, 1);
      else if (k === "ArrowUp") step(0, 0.12, 1);
      else if (k === "ArrowDown") step(0, -0.12, 1);
      else if (k === "+" || k === "=") step(0, 0, 0.88);
      else if (k === "-" || k === "_") step(0, 0, 1.14);
      else if (k >= "1" && k <= "5") api.goTo(+k - 1);
      else if (k === " ") api.toggle();
      else if (k === "Home" || k === "0") api.resetView();
      else return;
      e.preventDefault();
      interact();
    });

    /* ---------- Размер и видимость ---------- */
    function resize() {
      const w = wrap.clientWidth, h = wrap.clientHeight;
      if (!w || !h) return;
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      distScale = camera.aspect < 0.95 ? 1.4 : camera.aspect < 1.3 ? 1.15 : 1;
      snowMat.uniforms.uScale.value = (h * dpr) / 2 / Math.tan((camera.fov * Math.PI) / 360);
      snowMat.uniforms.uMax.value = 5 * dpr;
      dirty = true;
    }
    new ResizeObserver(resize).observe(wrap);
    let onscreen = true;
    new IntersectionObserver(es => { onscreen = es[0].isIntersecting; }).observe(wrap);

    readTheme();
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", readTheme);
    new MutationObserver(readTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    resize();

    /* ---------- Расстановка объектов по прогрессу ---------- */
    function apply() {
      for (const it of timeline) {
        const t = clamp01((p - it.start) / it.dur);
        it.update(ease(t), t);
      }
      // чертёж: рисуется линия за линией, потом бледнеет; на финале чертёж и контур растворяются
      const fade = 1 - span(p, 4.0, 4.6);
      const drawn = Math.floor(span(p, 0, 0.45) * planCount / 2) * 2;
      planGeo.setDrawRange(0, Math.max(0, drawn));
      planMat.opacity = (0.9 - 0.5 * span(p, 0.9, 1.4)) * fade;
      ghostMat.opacity = 0.35 * span(p, 0.05, 0.35) * fade;
      plan.visible = planMat.opacity > 0.01;
      ghost.visible = ghostMat.opacity > 0.01;
      const glow = span(p, 4.3, 4.9);
      mat.glass.emissiveIntensity = glow * glowMul;
      windowLight.intensity = glow * (night ? 2.2 : 0.3);
      opts.onProgress && opts.onProgress(p);
      shadowDirty = true;
    }

    /* ---------- Цикл ---------- */
    let last = performance.now(), lastRender = 0, time = 0;
    const slow = []; // интервалы кадров для адаптивной чёткости
    setTimeout(() => { started = true; }, reduce ? 0 : 500);

    function frame(now) {
      requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!onscreen || document.hidden) return;

      let active = false; // кадр с осмысленным движением — рисуем на полной частоте
      if (started && !paused && p !== target) {
        p = p < target ? Math.min(target, p + dt * 0.95) : Math.max(target, p - dt * 2.4);
        apply();
        active = true;
      }
      emitState();

      if (goal) {
        const k = 1 - Math.exp(-dt * 4);
        cam.yaw += (goal.yaw - cam.yaw) * k;
        cam.pitch += (goal.pitch - cam.pitch) * k;
        cam.dist += (goal.dist - cam.dist) * k;
        if (Math.abs(goal.yaw - cam.yaw) + Math.abs(goal.pitch - cam.pitch) + Math.abs(goal.dist - cam.dist) < 0.002) goal = null;
        active = true;
      } else if (!pointers.size && (Math.abs(vel.yaw) > 0.002 || Math.abs(vel.pitch) > 0.002)) {
        cam.yaw += vel.yaw * dt;
        cam.pitch = clamp(cam.pitch + vel.pitch * dt, LIM.pitch[0], LIM.pitch[1]);
        const damp = Math.exp(-dt * 4);
        vel.yaw *= damp; vel.pitch *= damp;
        active = true;
      }
      if (pointers.size) active = true;

      idle += dt;
      const ambient = !reduce; // снег и медленный облёт
      if (ambient && !pointers.size && !goal && idle > 4) cam.yaw += dt * 0.05;
      if (ambient) { time += dt; snowMat.uniforms.uTime.value = time; }

      // в покое (только снег и облёт) достаточно 30 кадров в секунду
      if (!active && !dirty && !(ambient && now - lastRender >= 33)) return;

      const d = cam.dist * distScale * Math.min(1.5, Math.max(0.45, dims.W / 10, dims.D / 8)); // камера ближе к маленьким постройкам
      camera.position.set(
        LOOK.x + Math.sin(cam.yaw) * Math.cos(cam.pitch) * d,
        LOOK.y + Math.sin(cam.pitch) * d,
        LOOK.z + Math.cos(cam.yaw) * Math.cos(cam.pitch) * d
      );
      camera.lookAt(LOOK.x, LOOK.y, LOOK.z);
      if (shadowDirty) { renderer.shadowMap.needsUpdate = true; shadowDirty = false; }
      renderer.render(scene, camera);

      // адаптивная чёткость: если устройство не тянет, снижаем плотность пикселей
      if (active && lastRender) {
        slow.push(now - lastRender);
        if (slow.length > 45) {
          const avg = slow.reduce((a, b) => a + b, 0) / slow.length;
          slow.length = 0;
          if (avg > 26 && dpr > 1) { dpr = Math.max(1, dpr - 0.5); resize(); }
        }
      }
      lastRender = now;
      dirty = false;
    }

    const api = {
      goTo(k) {
        target = k + 1; paused = false; started = true;
        if (reduce) { p = target; apply(); }
        setGoal(VIEWS[k]);
        interact();
      },
      toggle() {
        if (state === "building") paused = true;
        else if (state === "paused") { paused = false; target = STAGES; }
        else { p = 0; target = STAGES; paused = false; setGoal(HOME); }
        if (reduce) { p = target; }
        apply();
        emitState();
      },
      resetView() { setGoal(HOME); },
      // конструктор: перестроить дом с новыми параметрами, сохранив текущий этап сборки
      configure(next) {
        P = Object.assign({}, P, next);
        buildHouse();
        apply();
        dirty = true;
        interact();
      },
      // разрез: срезаем переднюю половину дома, чтобы видеть каркас и утеплитель в стене
      setCut(on) {
        cutPlane.constant = on ? 0 : 1000;
        if (on && p < 3) { target = STAGES; paused = false; started = true; }
        if (on) setGoal({ yaw: 0.35, pitch: 0.42, dist: 21 });
        shadowDirty = true; dirty = true;
      },
      params() {
        const area = P.type === "barrel" ? P.length * 2.3 : P.type === "greenhouse" ? P.length * P.width : P.length * P.width * (P.floors === "mansard" && P.roof !== "flat" ? 1.6 : 1);
        return Object.assign({}, P, { area: Math.round(area) });
      }
    };

    apply();
    emitState();
    requestAnimationFrame(frame);
    return api;
  }

  window.House3D = { mount };
})();
