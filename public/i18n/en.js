/* Siyue English mode — runs ONLY when the sy_lang=en cookie is set (loaded by
 * the inline boot script in app/layout.tsx). Translates the rendered DOM
 * in place using /i18n/en.json and keeps it translated through React
 * re-renders via MutationObserver. The Chinese render path is untouched. */
(function () {
  "use strict";
  if (window.__syEn) return;
  window.__syEn = true;
  var H = document.documentElement;
  var CJK = /[　-〿㐀-鿿豈-﫿＀-￯]/;
  var CJK_RUN = /[㐀-鿿豈-﫿][　-〿㐀-鿿豈-﫿＀-￯\s]*[㐀-鿿豈-﫿]|[㐀-鿿豈-﫿]/g;
  var PUNCT = { "：": ": ", "，": ", ", "。": ". ", "、": ", ", "；": "; ", "（": " (", "）": ") ", "【": " [", "】": "] ", "「": " “", "」": "” ", "『": " “", "』": "” ", "！": "! ", "？": "? ", "—": " — ", "…": "…", "　": " " };
  var ATTRS = ["placeholder", "title", "aria-label", "alt", "data-tip", "data-tooltip"];
  var dict = null, cache = new Map(), last = new WeakMap();
  var revealed = false;

  function reveal() {
    if (revealed) return;
    revealed = true;
    H.classList.remove("sy-en-pending");
  }
  setTimeout(reveal, 3000); // never leave a US visitor staring at a blank page

  function norm(s) { return s.replace(/\s+/g, " ").trim(); }
  function lookup(s) {
    var v = dict[s];
    if (v != null) return v;
    // strip trailing/leading Chinese punctuation and retry
    var m = /^([\s:：,，。;；、(（\[【·•|/]*)(.*?)([\s:：,，。;；、)）\]】·•|/…]*)$/.exec(s);
    if (m && m[2] && m[2] !== s) {
      v = dict[m[2]];
      if (v != null) return punct(m[1]) + v + punct(m[3]);
    }
    return null;
  }
  function punct(p) {
    var o = "";
    for (var i = 0; i < p.length; i++) o += PUNCT[p[i]] != null ? PUNCT[p[i]] : p[i];
    return o;
  }
  function translateRun(run) {
    var v = lookup(run);
    if (v != null) return v;
    // split on Chinese punctuation and translate the pieces
    var parts = run.split(/([：，。、；（）【】「」『』！？…　])/);
    if (parts.length > 1) {
      var out = "", hit = false;
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (!p) continue;
        if (PUNCT[p] != null) { out += PUNCT[p]; continue; }
        var t = norm(p) ? lookup(norm(p)) : null;
        if (t != null) { hit = true; out += t; } else out += p;
      }
      if (hit) return out.replace(/\s{2,}/g, " ");
    }
    return null;
  }
  var RULES = [
    [/(\d{4})年(\d{1,2})月(\d{1,2})日/g, "$1-$2-$3"],
    [/(\d{4})年(\d{1,2})月/g, "$1-$2"],
    [/(\d{1,2})月(\d{1,2})日/g, "$1/$2"],
    [/(\d{1,2})月(?![\d])/g, "$1/"],
    [/(\d{4})年/g, "$1"],
    [/周一|星期一/g, "Mon"], [/周二|星期二/g, "Tue"], [/周三|星期三/g, "Wed"], [/周四|星期四/g, "Thu"], [/周五|星期五/g, "Fri"], [/周六|星期六/g, "Sat"], [/周日|周天|星期日|星期天/g, "Sun"],
    [/(\d+)\s*件/g, "$1 pcs"], [/(\d+)\s*条/g, "$1 rows"], [/(\d+)\s*天/g, "$1 days"], [/(\d+)\s*张/g, "$1"], [/(\d+)\s*个/g, "$1"], [/(\d+)\s*台/g, "$1 machines"], [/(\d+)\s*人/g, "$1 people"], [/(\d+)\s*行/g, "$1 rows"], [/(\d+)\s*页/g, "$1 pages"], [/(\d+)\s*次/g, "$1×"], [/(\d+)\s*秒/g, "$1s"], [/(\d+)\s*分钟/g, "$1 min"], [/(\d+)\s*小时/g, "$1 h"],
    [/(\d+)\s*号机/g, "Machine $1"], [/第\s*(\d+)\s*道/g, "Step $1"], [/第\s*(\d+)\s*步/g, "Step $1"], [/第\s*(\d+)\s*页/g, "Page $1"], [/第\s*(\d+)\s*行/g, "Row $1"],
    [/(\d+(?:\.\d+)?)\s*元/g, "¥$1"],
  ];
  function translate(s) {
    if (!s || !CJK.test(s)) return null;
    var key = norm(s), ckey = key;
    if (!key) return null;
    if (cache.has(ckey)) return cache.get(ckey);
    var res = lookup(key);
    if (res == null) {
      var r2 = key;
      for (var ri = 0; ri < RULES.length; ri++) r2 = r2.replace(RULES[ri][0], RULES[ri][1]);
      if (r2 !== key) { var t2 = CJK.test(r2) ? null : r2; if (t2 == null) { var sub = lookup(norm(r2)); t2 = sub != null ? sub : null; } if (t2 == null) key = r2; else res = t2; }
    }
    if (res == null) {
      // piecewise: translate each CJK run, keep numbers/ASCII in place
      var hit = false;
      res = key.replace(CJK_RUN, function (run) {
        var t = translateRun(run.trim());
        if (t == null) return run;
        hit = true;
        return " " + t + " ";
      });
      if (hit) {
        res = punct(res).replace(/\s{2,}/g, " ").replace(/\s+([,.;:)\]!?])/g, "$1").replace(/([(\[])\s+/g, "$1").trim();
      } else res = key !== ckey ? key : null;
    }
    // keep the original's leading/trailing whitespace (React text nodes like " 条")
    if (res != null) {
      var lead = /^\s*/.exec(s)[0], trail = /\s*$/.exec(s)[0];
      res = lead + res + trail;
    }
    cache.set(ckey, res);
    return res;
  }

  function skip(el) {
    for (var e = el; e && e.nodeType === 1; e = e.parentNode) {
      var tag = e.nodeName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEXTAREA" || tag === "CODE" || tag === "PRE") return true;
      if (e.isContentEditable || e.hasAttribute("data-no-i18n")) return true;
    }
    return false;
  }
  function setText(node, v) {
    last.set(node, v);
    node.nodeValue = v;
  }
  function doText(node) {
    var s = node.nodeValue;
    if (!s || !CJK.test(s)) return;
    if (last.get(node) === s) return;
    if (skip(node.parentNode)) return;
    var t = translate(s);
    if (t != null && t !== s) setText(node, t);
  }
  function doAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i], v = el.getAttribute(a);
      if (v && CJK.test(v)) { var t = translate(v); if (t != null && t !== v) el.setAttribute(a, t); }
    }
    if (el.nodeName === "INPUT" && (el.type === "button" || el.type === "submit" || el.type === "reset") && CJK.test(el.value)) {
      var tv = translate(el.value); if (tv != null) el.value = tv;
    }
  }
  function walk(root) {
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      if (skip(root)) return;
      doAttrs(root);
    }
    var w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = w.nextNode())) {
      if (n.nodeType === 3) doText(n);
      else if (!skip(n)) doAttrs(n);
    }
  }

  function observe() {
    var pending = false, queue = [];
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === "characterData") queue.push(m.target);
        else if (m.type === "attributes") queue.push(m.target);
        else for (var j = 0; j < m.addedNodes.length; j++) queue.push(m.addedNodes[j]);
      }
      if (pending) return;
      pending = true;
      Promise.resolve().then(function () {
        pending = false;
        var q = queue; queue = [];
        for (var k = 0; k < q.length; k++) {
          var n = q[k];
          if (!n.isConnected) continue;
          if (n.nodeType === 3) doText(n);
          else if (n.nodeType === 1) walk(n);
        }
      });
    });
    mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  function wrapDialogs() {
    ["alert", "confirm", "prompt"].forEach(function (fn) {
      var orig = window[fn];
      if (typeof orig !== "function") return;
      window[fn] = function (msg) {
        try { if (typeof msg === "string") { var t = translate(msg); if (t != null) msg = t; } } catch (e) {}
        var args = Array.prototype.slice.call(arguments); args[0] = msg;
        return orig.apply(window, args);
      };
    });
  }

  function pill() {
    if (document.getElementById("sy-lang-pill")) return;
    var a = document.createElement("a");
    a.id = "sy-lang-pill";
    a.setAttribute("data-no-i18n", "1");
    a.href = "?lang=zh";
    a.textContent = "中文";
    a.title = "切换回中文 / Switch back to Chinese";
    a.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:2147483000;font:12px/1 -apple-system,system-ui,sans-serif;padding:5px 8px;border-radius:4px;background:rgba(30,30,32,.82);color:#fff;text-decoration:none;opacity:.55;letter-spacing:.02em";
    a.onmouseenter = function () { a.style.opacity = "1"; };
    a.onmouseleave = function () { a.style.opacity = ".55"; };
    a.onclick = function (ev) {
      ev.preventDefault();
      var u = new URL(location.href); u.searchParams.set("lang", "zh"); location.href = u.toString();
    };
    (document.body || H).appendChild(a);
  }

  function start() {
    try {
      H.setAttribute("lang", "en");
      walk(document.documentElement);
      observe();
      wrapDialogs();
      pill();
      // hot-swap late: a second pass once everything settled
      setTimeout(function () { walk(document.documentElement); }, 600);
    } catch (e) { if (window.console) console.warn("[sy-en]", e); }
    reveal();
  }

  function whenHydrated(cb) {
    // Start only after BOTH (a) app/layout.tsx's <EnBoot/> effect fired
    // (React's initial hydration commit) and (b) the document finished
    // streaming (window load — Suspense/loading.tsx segments arrive late and
    // hydrate after the root layout), then wait for an idle slot so any
    // progressive hydration of those segments has run. Touching text before
    // React hydrates it would make React regenerate that tree on the client.
    var done = false, hyd = !!window.__syHydrated, loaded = document.readyState === "complete";
    function go() { if (done) return; done = true; cb(); }
    function check() {
      if (!(hyd && loaded)) return;
      if (window.requestIdleCallback) requestIdleCallback(function () { setTimeout(go, 50); }, { timeout: 1500 });
      else setTimeout(go, 250);
    }
    window.addEventListener("sy:hydrated", function () { hyd = true; check(); }, { once: true });
    window.addEventListener("load", function () { loaded = true; check(); }, { once: true });
    setTimeout(go, 6000);
    check();
  }

  var cs = document.currentScript;
  var v = (cs && cs.getAttribute("data-v")) || "1";
  var dictUrl = (cs && cs.src ? cs.src.replace(/en\.js(\?.*)?$/, "en.json") : "/i18n/en.json") + "?v=" + v;
  fetch(dictUrl, { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (d) { dict = d; whenHydrated(start); })
    .catch(function (e) { if (window.console) console.warn("[sy-en] dictionary failed", e); reveal(); });
})();
