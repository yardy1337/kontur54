/*
  3D-дом, который собирается по пяти этапам строительства.

  Устройство:
  - build*()  — создают объекты этапа и регистрируют их в timeline:
                { start, dur, mode } — когда и как объект появляется.
                Повторяющиеся детали (стойки, фальцы, ели) — InstancedMesh.
  - progress  — p ∈ [0..5] плавно идёт к target; apply(p) расставляет объекты.
  - камера    — орбита yaw/pitch/dist с инерцией, пресеты ракурсов для этапов.
  - рендер    — кадр рисуется только когда что-то меняется; тени
                пересчитываются только во время сборки; снег считает GPU.

  API: House3D.mount(sceneEl, { colors, onProgress(p), onState(s), onInteract() })
       → { goTo(k), toggle(), resetView() } или null, если WebGL недоступен.
*/
(function () {
  const STAGES = 5;
  const LOOK = { x: 0, y: 2.3, z: 0.4 };
  const HOME = { yaw: 0.62, pitch: 0.34, dist: 24 };
  // Лучший ракурс для каждого этапа: фундамент сверху, кровля с другой стороны и т. д.
  const VIEWS = [
    { yaw: 0.5, pitch: 0.72, dist: 25 },
    { yaw: 0.9, pitch: 0.5, dist: 22 },
    { yaw: 0.3, pitch: 0.3, dist: 22 },
    { yaw: -0.75, pitch: 0.5, dist: 25 },
    { yaw: 0.62, pitch: 0.28, dist: 22 }
  ];
  const LIM = { pitch: [0.08, 1.2], dist: [14, 40] };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const clamp01 = t => clamp(t, 0, 1);
  const ease = t => 1 - Math.pow(1 - t, 3);

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

    const lin = hex => new T.Color(hex).convertSRGBToLinear();
    const scene = new T.Scene();
    scene.fog = new T.Fog(0xdbe3e8, 30, 110);
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

    const hemi = new T.HemisphereLight(0xe6eef8, 0x8a7d6c, 0.5);
    scene.add(hemi);
    const sun = new T.DirectionalLight(0xfff0d8, 2);
    sun.position.set(15, 13, 9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
    Object.assign(sun.shadow.camera, { left: -13, right: 13, top: 13, bottom: -13, near: 1, far: 50 });
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    const windowLight = new T.PointLight(0xffb35c, 0, 11, 2);
    windowLight.position.set(-1.6, 2.2, 5.6);
    scene.add(windowLight);

    /* ---------- Материалы ---------- */
    const colors = Object.assign({ wall: "#3a454b", roof: "#252c31", trim: "#b4733a", door: "#6b4426" }, opts.colors || {});
    const M = (hex, o) => new T.MeshStandardMaterial(Object.assign({ color: lin(hex), roughness: 0.85, metalness: 0 }, o || {}));

    // Вертикальная доска (планкен): генерируется на canvas, без файлов.
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
    const boardTex = {};
    function boardsMat(hex, rx, ry) {
      const key = hex + rx.toFixed(3) + ry.toFixed(3);
      if (boardTex[key]) return boardTex[key];
      const t = new T.CanvasTexture(boards);
      t.encoding = T.sRGBEncoding;
      t.wrapS = t.wrapT = T.RepeatWrapping;
      t.repeat.set(rx, ry);
      t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const b = t.clone();
      b.encoding = T.LinearEncoding;
      b.needsUpdate = true;
      return (boardTex[key] = M(hex, { map: t, bumpMap: b, bumpScale: 0.015, roughness: 0.8 }));
    }
    const BOARD = 1.6; // ширина тайла текстуры в метрах (8 досок по 20 см)

    const mat = {
      eps: M("#b4c6d3", { roughness: 0.95 }),
      concrete: M("#8a9399", { roughness: 0.95 }),
      pine: M("#d9b07a", { roughness: 0.75 }),
      trimPlain: M(colors.trim, { roughness: 0.6 }),
      door: M(colors.door, { roughness: 0.6 }),
      roof: M(colors.roof, { roughness: 0.38, metalness: 0.55 }),
      glass: M("#1b2830", { roughness: 0.04, metalness: 0.9, envMapIntensity: 1.5, emissive: lin("#ffb35c"), emissiveIntensity: 0 }),
      snow: M("#f3f6f8", { roughness: 1 }),
      trunk: M("#5b4231"),
      needles: M("#2c4638", { roughness: 0.9, flatShading: true })
    };

    /* ---------- Timeline ---------- */
    const house = new T.Group();
    scene.add(house);
    const items = [];      // обычные меши
    const inst = [];       // экземпляры InstancedMesh
    const dummy = new T.Object3D();

    function shadowy(o) { o.castShadow = true; o.receiveShadow = true; return o; }
    function box(w, h, d, m, x, y, z) {
      const o = shadowy(new T.Mesh(new T.BoxGeometry(w, h, d), m));
      o.position.set(x, y, z);
      return o;
    }
    function add(o, start, dur, mode) {
      o.userData.baseY = o.position.y;
      items.push({ o, start, dur: dur || 0.4, mode: mode || "drop" });
      house.add(o);
      return o;
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
    const tiers = [[0.2, 1.6, 0.8, mat.trunk, "cyl"], [2.6, 2.4, 2.2], [2.0, 2.2, 3.5], [1.3, 2.0, 4.7], [0.7, 1.4, 5.7]];
    tiers.forEach(([r, h, y, m, kind]) => {
      const geo = kind === "cyl" ? new T.CylinderGeometry(r * 0.8, r, h, 8) : new T.ConeGeometry(r, h, 9);
      const im = shadowy(new T.InstancedMesh(geo, m || mat.needles, PINES.length));
      PINES.forEach(([x, z, s], i) => {
        dummy.position.set(x, y * s, z); dummy.rotation.set(0, i * 1.7, 0); dummy.scale.setScalar(s);
        dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix);
      });
      scene.add(im);
    });

    /* ---------- Этап 1. Фундамент ---------- */
    const y0 = 0.5, H = 2.8, W = 10, D = 8;
    add(box(W + 1.0, 0.3, D + 1.0, mat.eps, 0, 0.15, 0), 0, 0.5, "grow");
    add(box(W + 0.6, 0.22, D + 0.6, mat.concrete, 0, 0.39, 0), 0.35, 0.5, "grow");

    /* ---------- Этап 2. Каркас ---------- */
    const studPos = [];
    for (let x = -W / 2 + 0.05; x <= W / 2; x += 0.6) { studPos.push([x, D / 2 - 0.1, 0], [x, -D / 2 + 0.1, 0]); }
    for (let z = -D / 2 + 0.6; z < D / 2 - 0.2; z += 0.6) { studPos.push([W / 2 - 0.05, z, 1], [-W / 2 + 0.05, z, 1]); }
    const studs = shadowy(new T.InstancedMesh(new T.BoxGeometry(0.06, H, 0.18), mat.pine, studPos.length));
    studs.instanceMatrix.setUsage(T.DynamicDrawUsage);
    studPos.forEach(([x, z, rot], i) => inst.push({ im: studs, i, x, y: y0 + H / 2, z, ry: rot ? Math.PI / 2 : 0, start: 1.0 + 0.62 * (i / studPos.length), dur: 0.28 }));
    house.add(studs);
    [[W, D / 2 - 0.1, false], [W, -D / 2 + 0.1, false], [D, W / 2 - 0.05, true], [D, -W / 2 + 0.05, true]].forEach(([len, off, side], i) => {
      const top = side ? box(0.18, 0.08, len, mat.pine, off, y0 + H, 0) : box(len, 0.08, 0.18, mat.pine, 0, y0 + H, off);
      add(top, 1.62 + i * 0.07, 0.3);
    });

    /* ---------- Этап 3. Стены и окна ---------- */
    const wz = D / 2 + 0.11, wx = W / 2 + 0.11;
    const panelW = (W + 0.44) / 4;
    for (let i = 0; i < 4; i++) {
      const x = -W / 2 - 0.22 + panelW * i + panelW / 2;
      const m = boardsMat(colors.wall, panelW / BOARD, 1);
      add(box(panelW, H, 0.22, m, x, y0 + H / 2, wz), 2.0 + i * 0.1, 0.35);
      add(box(panelW, H, 0.22, m, x, y0 + H / 2, -wz), 2.05 + i * 0.1, 0.35);
    }
    for (let i = 0; i < 2; i++) {
      const z = -D / 2 + D / 4 + (D / 2) * i;
      const m = boardsMat(colors.wall, (D / 2) / BOARD, 1);
      add(box(0.22, H, D / 2, m, wx, y0 + H / 2, z), 2.3 + i * 0.1, 0.35);
      add(box(0.22, H, D / 2, m, -wx, y0 + H / 2, z), 2.35 + i * 0.1, 0.35);
    }
    function win(x, y, z, w, h, axis, st) {
      const fw = axis === "x" ? [w + 0.2, h + 0.2, 0.05] : [0.05, h + 0.2, w + 0.2];
      const gw = axis === "x" ? [w, h, 0.04] : [0.04, h, w];
      const n = axis === "x" ? [0, 0, Math.sign(z)] : [Math.sign(x), 0, 0];
      add(box(...fw, mat.trimPlain, x + n[0] * 0.13, y, z + n[2] * 0.13), st, 0.3);
      add(box(...gw, mat.glass, x + n[0] * 0.16, y, z + n[2] * 0.16), st + 0.05, 0.3);
    }
    win(-2.4, y0 + 1.45, wz, 3.4, 2.1, "x", 2.6);
    win(3.1, y0 + 1.6, wz + 0.04, 1.2, 1.4, "x", 2.65);
    win(-2.2, y0 + 1.6, -wz, 1.6, 1.3, "x", 2.7);
    win(2.6, y0 + 1.6, -wz, 1.6, 1.3, "x", 2.72);
    win(wx, y0 + 1.6, -1.5, 1.4, 1.4, "z", 2.75);
    win(-wx, y0 + 1.6, 1.4, 1.4, 1.4, "z", 2.78);

    /* ---------- Этап 4. Кровля ---------- */
    const rise = 2.4, half = D / 2;
    const th = Math.atan2(rise, half);
    const L = Math.hypot(half, rise) + 0.75;
    const ridgeY = y0 + H + rise + 0.09;
    const gable = new T.Shape();
    gable.moveTo(-half - 0.11, 0); gable.lineTo(half + 0.11, 0); gable.lineTo(0, rise + 0.07); gable.closePath();
    const gGeo = new T.ExtrudeGeometry(gable, { depth: 0.22, bevelEnabled: false });
    gGeo.translate(0, 0, -0.11); gGeo.rotateY(Math.PI / 2);
    const gMat = boardsMat(colors.wall, 1 / BOARD, 1 / H); // у ExtrudeGeometry UV в метрах
    [wx, -wx].forEach((x, i) => {
      const g = shadowy(new T.Mesh(gGeo, gMat));
      g.position.set(x, y0 + H, 0);
      add(g, 3.0 + i * 0.1, 0.35);
    });
    win(wx, y0 + H + 0.95, 0, 0.8, 0.8, "z", 3.25);
    const roofW = W + 1.2;
    const seamGeo = new T.BoxGeometry(0.035, 0.045, L);
    const seamCount = Math.floor(roofW / 0.5);
    [1, -1].forEach((s, i) => {
      const r = box(roofW, 0.14, L, mat.roof, 0, ridgeY - Math.sin(th) * L / 2, s * Math.cos(th) * L / 2);
      r.rotation.x = s * th;
      // фальцы — дочерние объекты ската, падают вместе с ним
      const seams = shadowy(new T.InstancedMesh(seamGeo, mat.roof, seamCount));
      for (let k = 0; k < seamCount; k++) {
        dummy.position.set(-roofW / 2 + 0.25 + k * 0.5, 0.09, 0); dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1);
        dummy.updateMatrix(); seams.setMatrixAt(k, dummy.matrix);
      }
      r.add(seams);
      add(r, 3.3 + i * 0.18, 0.4);
    });
    add(box(0.65, 2.3, 0.65, mat.concrete, -2.6, 5.55, -1.5), 3.75, 0.3);

    /* ---------- Этап 5. Под ключ ---------- */
    add(box(3.0, H - 0.1, 0.04, boardsMat(colors.trim, 3.0 / BOARD, 1), 3.1, y0 + H / 2, wz + 0.13), 4.0, 0.35);
    add(box(1.0, 2.2, 0.06, mat.door, 0.6, y0 + 1.1, wz + 0.14), 4.15, 0.3);
    add(box(6.0, 0.18, 2.6, boardsMat(colors.trim, 6.0 / BOARD, 1), -1.7, 0.36, D / 2 + 1.6), 4.25, 0.35, "grow");
    [-4.4, -1.7, 1.0].forEach((x, i) => add(box(0.14, 2.6, 0.14, mat.trimPlain, x, 1.75, D / 2 + 2.75), 4.4 + i * 0.05, 0.3));
    [1, -1].forEach((s, i) => {
      const r = box(roofW - 0.4, 0.1, L - 0.5, mat.snow, 0, 0, 0);
      r.position.set(0, ridgeY - Math.sin(th) * L / 2 + Math.cos(th) * 0.14, s * Math.cos(th) * L / 2 + s * Math.sin(th) * 0.14);
      r.rotation.x = s * th;
      add(r, 4.55 + i * 0.1, 0.4);
    });

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
    scene.add(snow);

    /* ---------- Тема (цвета берутся из CSS-переменных страницы) ---------- */
    let glowMul = 0.2, night = false;
    function readTheme() {
      const cs = getComputedStyle(document.documentElement);
      const v = (n, d) => cs.getPropertyValue(n).trim() || d;
      const sky = lin(v("--scene-sky", "#e9eff2")), fog = lin(v("--scene-fog", "#dbe3e8"));
      night = fog.r + fog.g + fog.b < 0.1;
      scene.fog.color.copy(fog);
      skyMat.uniforms.top.value.copy(sky);
      skyMat.uniforms.bottom.value.copy(fog);
      snowMat.uniforms.uColor.value.copy(lin(v("--scene-flake", "#8ea2ad")));
      glowMul = parseFloat(v("--scene-glow", "0.2"));
      hemi.intensity = parseFloat(v("--scene-hemi", "0.9")) * 0.6;
      sun.intensity = parseFloat(v("--scene-sun", "0.95")) * (night ? 1.1 : 2.3);
      sun.color.set(night ? 0x9fb6d8 : 0xfff0d8);
      buildEnv(sky, fog, night ? lin("#1a2228") : lin("#d9dfe3"));
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
      for (const it of items) {
        const t = clamp01((p - it.start) / it.dur), e = ease(t);
        it.o.visible = t > 0.001;
        if (it.mode === "grow") {
          it.o.scale.y = Math.max(0.001, e);
          it.o.position.y = it.o.userData.baseY * (0.5 + 0.5 * e);
        } else {
          it.o.position.y = it.o.userData.baseY + (1 - e) * 4;
        }
      }
      for (const s of inst) {
        const t = clamp01((p - s.start) / s.dur), e = ease(t);
        dummy.position.set(s.x, s.y + (1 - e) * 4, s.z);
        dummy.rotation.set(0, s.ry, 0);
        dummy.scale.setScalar(t > 0.001 ? 1 : 0);
        dummy.updateMatrix();
        s.im.setMatrixAt(s.i, dummy.matrix);
      }
      studs.instanceMatrix.needsUpdate = true;
      const glow = clamp01((p - 4.3) / 0.6);
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

      const d = cam.dist * distScale;
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
      resetView() { setGoal(HOME); }
    };

    apply();
    emitState();
    requestAnimationFrame(frame);
    return api;
  }

  window.House3D = { mount };
})();
