// tvpipe website: theme switch, page navigation without reloads, the
// manual's contents button and the CRT figure.
(() => {
  const root = document.documentElement;

  // ---------- theme ----------
  function pressTheme() {
    document.querySelectorAll(".theme button").forEach(b =>
      b.setAttribute("aria-pressed", String(b.dataset.t === (root.dataset.theme || "auto"))));
  }
  function setTheme(t) {
    root.dataset.theme = t;
    try { localStorage.setItem("tvpipe-theme", t); } catch (e) {}
    pressTheme();
  }

  // ---------- navigation ----------
  // Links to other pages of the site load the page with fetch and swap the
  // header and #page in place, like htmx's hx-boost. The fonts, the
  // stylesheet and this script stay loaded, so nothing flashes. Anything
  // unusual (another site, a new tab, a failed fetch) is a normal load.
  const pages = new Map();
  function boostable(a, e) {
    if (e && (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.defaultPrevented)) return false;
    if (a.target || a.hasAttribute("download") || a.hasAttribute("data-noboost") || a.origin !== location.origin) return false;
    if (a.pathname === location.pathname && a.hash) return false;   // a jump within the page
    return /(\.html|\/)$/.test(a.pathname);
  }
  function fetchPage(url) {
    const key = url.split("#")[0];
    if (!pages.has(key)) {
      pages.set(key, fetch(key).then(r => {
        if (!r.ok) throw new Error(r.status);
        return r.text();
      }).catch(e => { pages.delete(key); throw e; }));
    }
    return pages.get(key);
  }
  async function go(url, push) {
    let doc;
    try { doc = new DOMParser().parseFromString(await fetchPage(url), "text/html"); }
    catch (e) { location.href = url; return; }
    const top = doc.querySelector("header.top"), page = doc.getElementById("page");
    if (!top || !page) { location.href = url; return; }
    if (push) {
      history.replaceState({ scroll: scrollY }, "");
      history.pushState({ scroll: 0 }, "", url);   // before the swap: relative URLs resolve against it
    }
    stopCrts();
    document.title = doc.title;
    document.body.className = doc.body.className;
    document.querySelector("header.top").replaceWith(document.adoptNode(top));
    document.getElementById("page").replaceWith(document.adoptNode(page));
    pressTheme();
    const hash = decodeURIComponent(new URL(url).hash.slice(1));
    const target = hash && document.getElementById(hash);
    if (target) target.scrollIntoView();
    else scrollTo(0, push ? 0 : (history.state && history.state.scroll) || 0);
    init();
  }
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  history.replaceState({ scroll: scrollY }, "");
  addEventListener("popstate", () => go(location.href, false));

  document.addEventListener("click", e => {
    const theme = e.target.closest(".theme button");
    if (theme) { setTheme(theme.dataset.t); return; }
    if (e.target.closest("#navbtn")) {
      const nav = document.getElementById("nav"), btn = document.getElementById("navbtn");
      if (nav) btn.setAttribute("aria-expanded", String(nav.classList.toggle("open")));
      return;
    }
    const tab = e.target.closest(".install .tabs button");
    if (tab) { showOs(tab.closest(".install"), tab.dataset.os); return; }
    const copy = e.target.closest(".install .copy");
    if (copy) {
      const code = copy.parentElement.querySelector("code").cloneNode(true);
      code.querySelectorAll(".p").forEach(p => p.remove());
      navigator.clipboard.writeText(code.textContent.trim()).then(() => {
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy"; }, 1500);
      }).catch(() => {});
      return;
    }
    const a = e.target.closest("a[href]");
    if (a && boostable(a, e)) { e.preventDefault(); go(a.href, true); }
  });
  // Fetch a page as soon as the pointer or focus is on its link.
  const warm = e => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (a && boostable(a)) fetchPage(a.href).catch(() => {});
  };
  document.addEventListener("pointerover", warm);
  document.addEventListener("focusin", warm);

  // ---------- CRT: a screenshot shown through a gentle shader ----------
  // Scanlines, slight curvature and colour fringing, a faint rolling bar and
  // grain, and a power-on line the first time it comes into view. One frame
  // with prefers-reduced-motion; the plain image without WebGL.
  const VS = "attribute vec2 a; varying vec2 v; void main(){ v = a * .5 + .5; v.y = 1. - v.y; gl_Position = vec4(a, 0., 1.); }";
  const FS = `precision mediump float;
    varying vec2 v; uniform sampler2D t; uniform float time, power, motion; uniform vec2 res;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 c = v - .5;
      vec2 uv = .5 + c * (.985 + .06 * dot(c, c));
      float sy = mix(.003, 1., smoothstep(.25, 1., power));
      float sx = clamp(power / .25, .002, 1.);
      vec2 p = vec2(.5 + (uv.x - .5) / sx, .5 + (uv.y - .5) / sy);
      vec3 col = vec3(.02, .03, .05);
      if (p.x > 0. && p.x < 1. && p.y > 0. && p.y < 1.) {
        vec2 off = vec2(c.x * .0035, 0.);
        col = vec3(texture2D(t, p + off).r, texture2D(t, p).g, texture2D(t, p - off).b);
        vec3 b = texture2D(t, p + vec2(.004, 0.)).rgb + texture2D(t, p - vec2(.004, 0.)).rgb
               + texture2D(t, p + vec2(0., .007)).rgb + texture2D(t, p - vec2(0., .007)).rgb;
        col = col * .92 + b * .03;
        col += (1. - sy) * 1.2;
      }
      col *= .86 + .14 * (.5 + .5 * sin(v.y * res.y / 3. * 6.2832));
      col *= 1. + .025 * motion * exp(-pow((fract(time * .05) * 1.4 - .2 - v.y) * 6., 2.));
      col += (hash(floor(v * res) + fract(time * 7.) * 91.) - .5) * .035 * motion;
      col *= 1. - .5 * pow(length(c * vec2(1., 1.1)) * 1.25, 3.);
      gl_FragColor = vec4(col, 1.);
    }`;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let crts = [];

  function stopCrts() {
    crts.forEach(stop => stop());
    crts = [];
  }

  function crt(box) {
    const canvas = box.querySelector("canvas"), img = box.querySelector("img");
    const gl = canvas.getContext("webgl", { antialias: false });
    if (!gl) return null;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) { console.error(e); return null; }
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const U = n => gl.getUniformLocation(prog, n);
    const uT = U("time"), uP = U("power"), uM = U("motion"), uR = U("res");

    let ready = false, visible = false, stopped = false, start = null, raf = 0, last = 0;
    function frame(now) {
      raf = 0;
      if (stopped || !ready || !visible || document.hidden) return;
      if (now - last < 33) { raf = requestAnimationFrame(frame); return; }   // ~30 fps
      last = now;
      if (start === null) start = now;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      gl.uniform1f(uT, now / 1000);
      gl.uniform1f(uP, reduced ? 1 : Math.min(1, (now - start) / 800));
      gl.uniform1f(uM, reduced ? 0 : 1);
      gl.uniform2f(uR, w, h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (!reduced) raf = requestAnimationFrame(frame);
    }
    function kick() { if (!raf) raf = requestAnimationFrame(frame); }
    function load() {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      ready = true; box.classList.add("on"); kick();
    }
    if (img.complete && img.naturalWidth) load(); else img.addEventListener("load", load);
    const io = new IntersectionObserver(es => { visible = es[0].isIntersecting; kick(); });
    io.observe(box);
    const resize = () => { last = 0; kick(); };
    document.addEventListener("visibilitychange", kick);
    addEventListener("resize", resize);
    return () => {
      stopped = true;
      io.disconnect();
      document.removeEventListener("visibilitychange", kick);
      removeEventListener("resize", resize);
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
    };
  }

  // ---------- install commands ----------
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent;
  const visitorOs = /win/i.test(platform) ? "windows" : "unix";
  function showOs(box, os) {
    box.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.os === os)));
    box.querySelectorAll("pre[data-os]").forEach(p => { p.hidden = p.dataset.os !== os; });
  }

  function init() {
    document.querySelectorAll("[data-install]").forEach(box => showOs(box, visitorOs));
    document.querySelectorAll("[data-crt]").forEach(box => {
      const stop = crt(box);
      if (stop) crts.push(stop);
    });
  }

  pressTheme();
  init();
})();
