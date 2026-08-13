/* =====================================================================
   VANTA — центральная система частиц (Three.js)

   Облако из ~22 000 точек, которое перетекает между четырьмя формами,
   отсылающими к стеку: сфера-сетка (async), куб (контейнер), тор (очередь),
   двойная спираль (поток данных). Точки реагируют на курсор — отталкиваются
   и закручиваются вокруг него.

   Три принципиальных решения, чтобы это не сломало сайт:

   1. Холст лежит в fixed-контейнере с pointer-events:none, а координаты
      курсора читаются с document. Никаких OrbitControls: они вешают свои
      touch-обработчики на канвас и на телефоне съедают скролл страницы.
   2. Three подключается динамическим import() из обычного скрипта — не
      нужен importmap, который в связке с DC-рантаймом ведёт себя непредсказуемо.
   3. Всё опционально: нет WebGL, не загрузился CDN, включён prefers-reduced-
      motion, слабое устройство — страница просто остаётся статичной и целой.

   Связь с UI односторонняя и без React-ререндеров: скрипт сам пишет в
   #v-morph-name / #v-morph-counter / #v-morph-progress, подписи берёт из
   window.VANTA_LABELS (их выставляет компонент страницы, зная язык).
   ===================================================================== */

(function () {
  'use strict';

  var THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

  var container = null;
  var reduced = false;

  // --- подписи форм: язык задаёт страница -----------------------------
  var FALLBACK_LABELS = ['Async', 'Container', 'Queue', 'Stream'];
  function labels() {
    var l = window.VANTA_LABELS;
    return (Array.isArray(l) && l.length === 4) ? l : FALLBACK_LABELS;
  }

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  function hasWebGL() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext &&
        (c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) {
      return false;
    }
  }

  /* Бюджет частиц под устройство. На телефоне важнее ровные 60fps при
     скролле, чем плотность облака. */
  function particleBudget() {
    var w = window.innerWidth;
    var mem = navigator.deviceMemory || 4;
    if (w < 700 || mem <= 2) return 6500;
    if (w < 1100 || mem <= 4) return 13000;
    return 22000;
  }

  // ===================================================================
  //  ГЕНЕРАЦИЯ ФОРМ
  // ===================================================================

  /* Равномерная выборка точек по поверхности меша: треугольник выбирается
     с вероятностью, пропорциональной его площади, затем берётся случайная
     барицентрическая точка внутри него. Без взвешивания по площади мелкие
     грани получили бы столько же точек, сколько крупные, и форма выглядела
     бы комковатой. */
  function sampleSurface(THREE, geometry, count) {
    var geo = geometry.index ? geometry.toNonIndexed() : geometry;
    var pos = geo.attributes.position;
    var triCount = pos.count / 3;

    var areas = new Float32Array(triCount);
    var cumulative = new Float32Array(triCount);
    var total = 0;

    var a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    var ab = new THREE.Vector3(), ac = new THREE.Vector3(), cross = new THREE.Vector3();

    for (var t = 0; t < triCount; t++) {
      a.fromBufferAttribute(pos, t * 3);
      b.fromBufferAttribute(pos, t * 3 + 1);
      c.fromBufferAttribute(pos, t * 3 + 2);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      cross.crossVectors(ab, ac);
      areas[t] = cross.length() * 0.5;
      total += areas[t];
      cumulative[t] = total;
    }

    var out = new Float32Array(count * 3);
    for (var i = 0; i < count; i++) {
      var r = Math.random() * total;
      // бинарный поиск по накопленной площади — O(log n) вместо O(n)
      var lo = 0, hi = triCount - 1, idx = 0;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (cumulative[mid] < r) { lo = mid + 1; } else { idx = mid; hi = mid - 1; }
      }
      a.fromBufferAttribute(pos, idx * 3);
      b.fromBufferAttribute(pos, idx * 3 + 1);
      c.fromBufferAttribute(pos, idx * 3 + 2);

      var u = Math.random(), v = Math.random();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      var w = 1 - u - v;

      out[i * 3]     = a.x * w + b.x * u + c.x * v;
      out[i * 3 + 1] = a.y * w + b.y * u + c.y * v;
      out[i * 3 + 2] = a.z * w + b.z * u + c.z * v;
    }
    return out;
  }

  function jitter(arr, amount) {
    for (var i = 0; i < arr.length; i++) arr[i] += (Math.random() - 0.5) * amount;
    return arr;
  }

  // 0 — ASYNC: сфера из мелких граней, читается как «узел сети»
  function shapeAsync(THREE, n) {
    return jitter(sampleSurface(THREE, new THREE.IcosahedronGeometry(1.3, 4), n), 0.022);
  }

  // 1 — CONTAINER: куб; часть точек уплотняется на рёбрах, иначе куб из
  // равномерного шума читается как облако, а не как объём
  function shapeContainer(THREE, n) {
    var edgeCount = Math.floor(n * 0.28);
    var faceCount = n - edgeCount;
    var faces = sampleSurface(THREE, new THREE.BoxGeometry(1.95, 1.95, 1.95, 2, 2, 2), faceCount);

    var out = new Float32Array(n * 3);
    out.set(faces);

    var h = 0.975;
    var corners = [-h, h];
    for (var i = 0; i < edgeCount; i++) {
      var axis = i % 3;                       // вдоль какой оси идёт ребро
      var s = Math.random() * 2 * h - h;      // положение вдоль ребра
      var p1 = corners[Math.floor(Math.random() * 2)];
      var p2 = corners[Math.floor(Math.random() * 2)];
      var o = (faceCount + i) * 3;
      if (axis === 0)      { out[o] = s;  out[o + 1] = p1; out[o + 2] = p2; }
      else if (axis === 1) { out[o] = p1; out[o + 1] = s;  out[o + 2] = p2; }
      else                 { out[o] = p1; out[o + 1] = p2; out[o + 2] = s;  }
    }
    return jitter(out, 0.016);
  }

  // 2 — QUEUE: тор
  function shapeQueue(THREE, n) {
    var geo = new THREE.TorusGeometry(1.05, 0.36, 26, 90);
    geo.rotateX(Math.PI * 0.32);
    return jitter(sampleSurface(THREE, geo, n), 0.02);
  }

  // 3 — STREAM: двойная спираль с перемычками
  function shapeStream(_THREE, n) {
    var out = new Float32Array(n * 3);
    var perStrand = Math.floor(n / 2);
    var radius = 0.62;
    var turns = Math.PI * 6;

    for (var strand = 0; strand < 2; strand++) {
      var phase = strand * Math.PI;
      for (var i = 0; i < perStrand; i++) {
        var k = (strand * perStrand + i) * 3;
        var t = (i / perStrand) * turns - turns / 2;

        // каждая двадцатая точка уходит в перемычку между нитями
        var isRung = (i % 340) < 14;
        if (isRung && strand === 0) {
          var anchor = Math.floor(i / 340) * 340;
          var angle = (anchor / perStrand) * turns - turns / 2;
          var f = (i % 340) / 14;
          out[k]     = radius * Math.cos(angle) * (1 - f) + radius * Math.cos(angle + Math.PI) * f;
          out[k + 1] = angle * 0.26;
          out[k + 2] = radius * Math.sin(angle) * (1 - f) + radius * Math.sin(angle + Math.PI) * f;
        } else {
          out[k]     = radius * Math.cos(t + phase);
          out[k + 1] = t * 0.26;
          out[k + 2] = radius * Math.sin(t + phase);
        }
      }
    }
    return jitter(out, 0.03);
  }

  // ===================================================================
  //  ШЕЙДЕРЫ
  // ===================================================================

  var VERT = [
    'attribute float aSize;',
    'attribute float aRandom;',
    'varying vec3 vColor;',
    'varying float vAlpha;',
    'uniform float uTime;',
    'uniform float uPixelRatio;',
    'uniform float uMorph;',
    'uniform vec3  uMouse;',
    'uniform float uMouseActive;',
    'void main() {',
    '  vColor = color;',
    '  vec3 pos = position;',
    // дыхание: облако едва заметно пульсирует, чтобы не выглядеть мёртвым
    '  float breath = sin(uTime * 0.5 + aRandom * 6.2831) * 0.02;',
    '  pos += normalize(pos + vec3(0.0001)) * breath;',
    // на пике перехода точки разлетаются — переход читается как «распад и сборка»
    '  float scatter = sin(uMorph * 3.14159) * 0.34;',
    '  pos += normalize(pos + vec3(0.0001)) * scatter * aRandom;',
    // влияние курсора считается по XY, иначе глубина гасила бы эффект
    '  vec3 toPoint = pos - uMouse;',
    '  float influence = 1.0 - smoothstep(0.0, 1.45, length(toPoint.xy));',
    '  influence = influence * influence * uMouseActive;',
    '  if (influence > 0.001) {',
    '    vec3 pushDir = length(toPoint) > 0.001 ? normalize(toPoint) : vec3(0.0, 1.0, 0.0);',
    '    pos += pushDir * influence * 0.3;',
    '    float swirl = uTime * 2.0 + aRandom * 6.2831;',
    '    float angle = influence * 0.26 * (1.0 + sin(swirl) * 0.3);',
    '    vec2 radial = pos.xy - uMouse.xy;',
    '    float ca = cos(angle), sa = sin(angle);',
    '    pos.xy = uMouse.xy + vec2(radial.x * ca - radial.y * sa, radial.x * sa + radial.y * ca);',
    '    pos.z += sin(swirl * 0.7 + aRandom * 3.14159) * influence * 0.15;',
    '  }',
    '  vec4 mv = modelViewMatrix * vec4(pos, 1.0);',
    '  gl_PointSize = max(aSize * uPixelRatio * 480.0 / -mv.z, 1.2);',
    '  gl_Position = projectionMatrix * mv;',
    '  vAlpha = 0.82 + 0.18 * (1.0 - smoothstep(0.0, 10.0, -mv.z));',
    '}'
  ].join('\n');

  var FRAG = [
    'varying vec3 vColor;',
    'varying float vAlpha;',
    'void main() {',
    '  float d = length(gl_PointCoord - vec2(0.5));',
    '  if (d > 0.5) discard;',
    '  gl_FragColor = vec4(vColor * 2.05 + 0.12, smoothstep(0.5, 0.0, d) * vAlpha);',
    '}'
  ].join('\n');

  // ===================================================================
  //  ЗАПУСК
  // ===================================================================

  function updateShapeUI(index, total) {
    var nameEl = document.getElementById('v-morph-name');
    var counterEl = document.getElementById('v-morph-counter');
    if (nameEl) nameEl.textContent = labels()[index];
    if (counterEl) {
      counterEl.textContent = '0' + (index + 1) + ' / 0' + total;
    }
    var dots = document.querySelectorAll('[data-vdot]');
    for (var i = 0; i < dots.length; i++) {
      dots[i].setAttribute('data-active', String(Number(dots[i].getAttribute('data-vdot')) === index));
    }
    document.documentElement.setAttribute('data-vanta-shape', String(index));
  }

  function fallback() {
    if (container) container.setAttribute('data-fallback', '');
  }

  function boot(THREE) {
    var COUNT = particleBudget();

    var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.innerWidth < 700 ? 1.5 : 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 0, 5);

    var shapes = [
      shapeAsync(THREE, COUNT),
      shapeContainer(THREE, COUNT),
      shapeQueue(THREE, COUNT),
      shapeStream(THREE, COUNT)
    ];

    // --- атрибуты ---
    var positions = new Float32Array(shapes[0]);
    var colors = new Float32Array(COUNT * 3);
    var sizes = new Float32Array(COUNT);
    var randoms = new Float32Array(COUNT);

    var cream = new THREE.Color(0xf2e2c8);
    var gold  = new THREE.Color(0xc4a882);
    var cool  = new THREE.Color(0x7f93a8);   // холодная искра для глубины

    for (var i = 0; i < COUNT; i++) {
      var r = i / COUNT;
      var col = r < 0.55 ? cream.clone().lerp(gold, r / 0.55)
                         : gold.clone().lerp(cool, (r - 0.55) / 0.45 * 0.75);
      colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
      sizes[i] = 0.011 + Math.random() * 0.019;
      randoms[i] = Math.random();
    }

    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aRandom', new THREE.BufferAttribute(randoms, 1));

    var material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:        { value: 0 },
        uPixelRatio:  { value: renderer.getPixelRatio() },
        uMorph:       { value: 0 },
        uMouse:       { value: new THREE.Vector3(999, 999, 0) },
        uMouseActive: { value: 0 }
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true
    });

    var points = new THREE.Points(geometry, material);
    scene.add(points);

    // Смещаем облако вправо: слева на широком экране стоит текст.
    function layout() {
      var wide = window.innerWidth > 900;
      points.position.x = wide ? 0.62 : 0;
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.position.z = wide ? 5 : 6.2;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      material.uniforms.uPixelRatio.value = renderer.getPixelRatio();
    }
    layout();
    window.addEventListener('resize', layout);

    // --- курсор ---
    var mouseNDC = new THREE.Vector2(999, 999);
    var mouseOn = false;
    var mouseSmooth = 0;
    var raycaster = new THREE.Raycaster();
    var plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    var hit = new THREE.Vector3();
    var invMatrix = new THREE.Matrix4();
    var localMouse = new THREE.Vector3();

    document.addEventListener('mousemove', function (e) {
      mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
      mouseOn = true;
    }, { passive: true });

    document.addEventListener('mouseleave', function () {
      mouseNDC.set(999, 999);
      mouseOn = false;
    });

    // --- морфинг ---
    var MORPH_SEC = 2.4;
    var HOLD_SEC = 5.5;
    var current = 0, target = 0, morphing = false, morphStart = 0, uiSwapped = false;
    var clock = new THREE.Clock();
    var holdStart = 0;

    function startMorph(idx) {
      if (morphing || idx === current || reduced) return;
      target = idx;
      morphing = true;
      uiSwapped = false;
      morphStart = clock.getElapsedTime();
    }

    // Клик по точкам-переключателям: делегирование на document, чтобы
    // перерисовки DC-компонента не отрывали обработчики.
    document.addEventListener('click', function (e) {
      var dot = e.target && e.target.closest ? e.target.closest('[data-vdot]') : null;
      if (!dot) return;
      var idx = Number(dot.getAttribute('data-vdot'));
      if (!isNaN(idx)) { startMorph(idx); holdStart = clock.getElapsedTime(); }
    });

    updateShapeUI(0, shapes.length);

    // --- скролл: облако уходит в фон, но не исчезает совсем ---
    var scrollY = window.scrollY || 0;
    window.addEventListener('scroll', function () { scrollY = window.scrollY || 0; }, { passive: true });

    function easeInOutCubic(t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    var progressEl = document.getElementById('v-morph-progress');
    var lastOpacity = -1;

    container.setAttribute('data-ready', '');

    function frame() {
      requestAnimationFrame(frame);
      if (document.hidden) return;

      var vh = window.innerHeight || 1;
      var fade = Math.min(scrollY / (vh * 0.85), 1);
      var opacity = 1 - fade * 0.86;
      if (Math.abs(opacity - lastOpacity) > 0.004) {
        container.style.opacity = String(opacity);
        lastOpacity = opacity;
      }
      // Ушли далеко вниз — облако всё равно почти невидимо, незачем греть GPU.
      if (scrollY > vh * 2.2) return;

      var t = clock.getElapsedTime();
      material.uniforms.uTime.value = t;

      mouseSmooth += ((mouseOn ? 1 : 0) - mouseSmooth) * 0.08;
      material.uniforms.uMouseActive.value = mouseSmooth;

      if (mouseSmooth > 0.001) {
        raycaster.setFromCamera(mouseNDC, camera);
        raycaster.ray.intersectPlane(plane, hit);
        invMatrix.copy(points.matrixWorld).invert();
        localMouse.copy(hit).applyMatrix4(invMatrix);
        material.uniforms.uMouse.value.copy(localMouse);
      }

      if (morphing) {
        var raw = Math.min((t - morphStart) / MORPH_SEC, 1);
        var eased = easeInOutCubic(raw);
        material.uniforms.uMorph.value = eased;

        var src = shapes[current], dst = shapes[target];
        var arr = geometry.attributes.position.array;
        for (var i = 0, len = COUNT * 3; i < len; i++) {
          arr[i] = src[i] + (dst[i] - src[i]) * eased;
        }
        geometry.attributes.position.needsUpdate = true;

        // Подпись меняем в середине перехода, когда форма уже неузнаваема.
        if (!uiSwapped && raw > 0.45) { uiSwapped = true; updateShapeUI(target, shapes.length); }

        if (raw >= 1) {
          morphing = false;
          current = target;
          material.uniforms.uMorph.value = 0;
          holdStart = t;
        }
        if (progressEl) progressEl.style.width = '0%';
      } else {
        var held = t - holdStart;
        if (progressEl) progressEl.style.width = Math.min(held / HOLD_SEC, 1) * 100 + '%';
        if (!reduced && held > HOLD_SEC) startMorph((current + 1) % shapes.length);
      }

      if (!reduced) {
        points.rotation.y = t * 0.055;
        points.position.y = Math.sin(t * 0.3) * 0.05;
      }

      renderer.render(scene, camera);
    }

    renderer.domElement.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      fallback();
    });

    frame();
  }

  // ===================================================================

  ready(function () {
    container = document.getElementById('v-canvas');
    if (!container) return;

    reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (!hasWebGL()) { fallback(); return; }

    import(THREE_URL)
      .then(function (THREE) {
        try {
          boot(THREE);
        } catch (err) {
          console.error('[vanta] не удалось собрать сцену:', err);
          fallback();
        }
      })
      .catch(function (err) {
        console.warn('[vanta] three.js не загрузился, включаю запасной фон:', err);
        fallback();
      });
  });
})();
