// Reroute front end: station autocomplete, saved home/work, the loading gauge, the board clock.
// Plain JS on purpose — htmx does the requests; this only adds what htmx can't.
(() => {
  const form = document.getElementById("plan");
  const saved = document.getElementById("saved");
  const loaderEl = document.getElementById("checking");

  // ---- station index ---------------------------------------------------------------

  let LINES = {};
  let STATIONS = [];
  const byId = new Map();

  const norm = (s) =>
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[.'’()-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  async function loadStations(attempt = 0) {
    try {
      const res = await fetch("/stations.json");
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      LINES = data.lines;
      STATIONS = data.stations.map((s) => {
        const key = norm(s.name);
        return { ...s, key, words: key.split(" ") };
      });
      for (const s of STATIONS) byId.set(s.id, s);
      renderSaved();
    } catch {
      // The index builds at server boot; retry briefly rather than leave typing dead.
      if (attempt < 10) setTimeout(() => loadStations(attempt + 1), 1000);
    }
  }

  // Ranks: whole-name prefix, then every query word prefixes some name word, then substring.
  // Interchanges (more lines) float up within a rank — they're what people usually mean.
  function search(q) {
    const nq = norm(q);
    if (!nq) return [];
    const qWords = nq.split(" ");
    const hits = [];
    for (const s of STATIONS) {
      let rank;
      if (s.key.startsWith(nq)) rank = 0;
      else if (qWords.every((w) => s.words.some((sw) => sw.startsWith(w)))) rank = 1;
      else if (s.key.includes(nq)) rank = 2;
      else continue;
      hits.push({ s, rank });
    }
    hits.sort((a, b) => a.rank - b.rank || b.s.lines.length - a.s.lines.length || a.s.name.length - b.s.name.length);
    return hits.slice(0, 8).map((h) => h.s);
  }

  // ---- small DOM helpers -----------------------------------------------------------

  function pill(lineId) {
    const l = LINES[lineId];
    const el = document.createElement("span");
    el.className = "pill";
    el.textContent = l ? l.name : lineId;
    if (l) el.style.cssText = `--c:${l.colour};--ink:${l.ink}`;
    return el;
  }

  function highlighted(name, q) {
    const frag = document.createDocumentFragment();
    const i = name.toLowerCase().indexOf(q.trim().toLowerCase());
    if (i < 0 || !q.trim()) {
      frag.append(name);
      return frag;
    }
    const mark = document.createElement("mark");
    mark.textContent = name.slice(i, i + q.trim().length);
    frag.append(name.slice(0, i), mark, name.slice(i + q.trim().length));
    return frag;
  }

  const crowdCache = new Map();
  async function crowdingHtml(id) {
    const hit = crowdCache.get(id);
    if (hit && Date.now() - hit.at < 30_000) return hit.html;
    const html = await fetch(`/crowding/${encodeURIComponent(id)}`).then((r) => r.text()).catch(() => "");
    crowdCache.set(id, { html, at: Date.now() });
    return html;
  }

  // ---- combobox --------------------------------------------------------------------

  const combos = {};

  function setupCombo(root) {
    const fieldName = root.dataset.field;
    const input = root.querySelector('input[role="combobox"]');
    const hidden = root.querySelector(`input[name="${fieldName}Id"]`);
    const list = root.querySelector(".suggestions");
    const picked = root.querySelector(".picked");
    let results = [];
    let active = -1;
    let crowdTimer;

    function close() {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      active = -1;
    }

    function setActive(i) {
      const items = list.children;
      if (items[active]) items[active].setAttribute("aria-selected", "false");
      active = i;
      const el = items[active];
      if (!el) return;
      el.setAttribute("aria-selected", "true");
      input.setAttribute("aria-activedescendant", el.id);
      el.scrollIntoView({ block: "nearest" });
      // Live crowding for whichever suggestion is highlighted, debounced so arrowing
      // through the list doesn't fire a request per keypress.
      clearTimeout(crowdTimer);
      const s = results[active];
      crowdTimer = setTimeout(async () => {
        if (!s.id.startsWith("940G")) return;
        const html = await crowdingHtml(s.id);
        const slot = document.getElementById(`${fieldName}-opt-${i}`)?.querySelector(".opt-crowd");
        if (slot && results[i] === s) slot.innerHTML = html;
      }, 120);
    }

    function render() {
      results = search(input.value);
      list.replaceChildren(
        ...results.map((s, i) => {
          const li = document.createElement("li");
          li.id = `${fieldName}-opt-${i}`;
          li.setAttribute("role", "option");
          li.setAttribute("aria-selected", "false");
          const name = document.createElement("span");
          name.className = "opt-name";
          name.append(highlighted(s.name, input.value));
          const lines = document.createElement("span");
          lines.className = "opt-lines";
          lines.append(...s.lines.map(pill));
          const crowd = document.createElement("span");
          crowd.className = "opt-crowd";
          li.append(name, crowd, lines);
          li.addEventListener("mousedown", (e) => {
            e.preventDefault(); // keep focus in the input
            choose(s);
          });
          li.addEventListener("mousemove", () => active !== i && setActive(i));
          return li;
        }),
      );
      const open = results.length > 0;
      list.hidden = !open;
      input.setAttribute("aria-expanded", String(open));
      if (open) setActive(0);
    }

    function choose(s) {
      input.value = s.name;
      hidden.value = s.id;
      close();
      showPicked(s);
    }

    async function showPicked(s) {
      picked.replaceChildren();
      if (!s) return;
      const lines = document.createElement("span");
      lines.className = "opt-lines";
      lines.append(...s.lines.map(pill));
      const crowd = document.createElement("span");
      const saveHome = saveButton("home", s);
      const saveWork = saveButton("work", s);
      picked.append(lines, crowd, saveHome, saveWork);
      if (s.id.startsWith("940G")) crowd.innerHTML = await crowdingHtml(s.id);
    }

    input.addEventListener("input", () => {
      hidden.value = ""; // typed text no longer matches a picked station
      picked.replaceChildren();
      render();
    });
    input.addEventListener("focus", () => input.value && !hidden.value && render());
    input.addEventListener("blur", () => setTimeout(close, 100));
    input.addEventListener("keydown", (e) => {
      if (list.hidden) {
        if (e.key === "ArrowDown") render();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((active + 1) % results.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((active - 1 + results.length) % results.length);
      } else if (e.key === "Enter" && results[active]) {
        e.preventDefault();
        choose(results[active]);
      } else if (e.key === "Escape") {
        close();
      }
    });

    combos[fieldName] = {
      get: () => (hidden.value ? { id: hidden.value, name: input.value } : null),
      set: (s) => {
        input.value = s?.name ?? "";
        hidden.value = s?.id ?? "";
        showPicked(s ? byId.get(s.id) ?? (s.lines ? s : null) : null);
      },
    };
  }

  // ---- saved home / work (this browser only) ----------------------------------------

  const store = {
    get: (k) => {
      try {
        return JSON.parse(localStorage.getItem(`reroute.${k}`) || "null");
      } catch {
        return null;
      }
    },
    set: (k, v) => (v ? localStorage.setItem(`reroute.${k}`, JSON.stringify(v)) : localStorage.removeItem(`reroute.${k}`)),
  };

  function saveButton(kind, s) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "save outline";
    const current = store.get(kind);
    b.textContent = current?.id === s.id ? `✓ ${kind === "home" ? "Home" : "Work"}` : `Set as ${kind}`;
    b.addEventListener("click", () => {
      store.set(kind, { id: s.id, name: s.name, lines: s.lines });
      b.textContent = `✓ ${kind === "home" ? "Home" : "Work"}`;
      renderSaved();
    });
    return b;
  }

  function quick(label, from, to, primary) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = primary ? "quick" : "quick secondary";
    b.innerHTML = `<small>${label}</small>`;
    const route = document.createElement("span");
    route.textContent = `${from.name} → ${to.name}`;
    b.append(route);
    b.addEventListener("click", () => {
      combos.from.set(from);
      combos.to.set(to);
      form.requestSubmit();
    });
    return b;
  }

  function renderSaved() {
    const home = store.get("home");
    const work = store.get("work");
    saved.replaceChildren();
    if (home && work) {
      // Mornings lead with the commute in; afternoons with the commute home.
      const morning = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hourCycle: "h23" }).format()) < 13;
      const toWork = quick("Check now · to work", home, work, morning);
      const toHome = quick("Check now · to home", work, home, !morning);
      saved.append(...(morning ? [toWork, toHome] : [toHome, toWork]));
    }
    const hint = document.createElement("p");
    hint.className = "saved-hint";
    const describe = (k, v) => (v ? `${k}: ${v.name}` : `${k}: not set`);
    hint.textContent = home || work
      ? `${describe("Home", home)} · ${describe("Work", work)}`
      : "Tip: pick a station, then “Set as home” / “Set as work” for one-tap checks.";
    if (home || work) {
      const clear = document.createElement("a");
      clear.href = "#";
      clear.textContent = "clear";
      clear.addEventListener("click", (e) => {
        e.preventDefault();
        store.set("home", null);
        store.set("work", null);
        renderSaved();
      });
      hint.append(" · ", clear);
    }
    saved.append(hint);
  }

  // ---- loading gauge ---------------------------------------------------------------

  const QUIPS = [
    ["Looking up stations…", "Mind the gap…", "Checking the map, not the other way round…"],
    ["Asking the Journey Planner…", "Please stand clear of the closing doors…", "Plotting a course under London…"],
    ["Checking the signals…", "Radioing the line controllers…", "Reading the status board…"],
    ["Reading the service notices…", "Squinting at the ticket-hall whiteboard…", "Finding out why…"],
    ["Writing your verdict…", "Next stop: your answer…", "This train terminates at: certainty…"],
  ];

  let gauge = null;

  function startGauge(rid) {
    stopGauge();
    const stops = [...loaderEl.querySelectorAll(".stops li")];
    const track = loaderEl.querySelector(".track");
    const quipEl = loaderEl.querySelector(".quip");
    const nextEl = loaderEl.querySelector(".next-stop");
    const pctEl = loaderEl.querySelector(".gauge-pct");
    const elapsedEl = loaderEl.querySelector(".elapsed");
    const last = stops.length - 1;
    const g = { stage: 0, stageAt: performance.now(), startedAt: performance.now(), quip: 0 };

    const tick = () => {
      const now = performance.now();
      // Ease towards the next stop while waiting, but never reach it until the agent does.
      const creep = g.stage < last ? 0.85 * (1 - Math.exp(-(now - g.stageAt) / 3500)) : 0;
      const pos = Math.min(g.stage + creep, last) / last;
      track.style.setProperty("--pos", pos.toFixed(4));
      pctEl.textContent = `${Math.round(pos * 100)}%`;
      elapsedEl.textContent = ((now - g.startedAt) / 1000).toFixed(1);
      stops.forEach((li, i) => {
        li.classList.toggle("done", i < g.stage);
        li.classList.toggle("current", i === g.stage);
      });
      nextEl.textContent = stops[Math.min(g.stage, last)].querySelector(".label").textContent;
    };
    const quip = () => {
      const set = QUIPS[Math.min(g.stage, QUIPS.length - 1)];
      quipEl.textContent = set[g.quip++ % set.length];
    };
    const poll = async () => {
      try {
        const { stage } = await fetch(`/progress/${rid}`).then((r) => r.json());
        if (stage > g.stage) {
          g.stage = stage;
          g.stageAt = performance.now();
          g.quip = 0;
          quip();
        }
      } catch {}
    };

    quip();
    tick();
    gauge = [setInterval(tick, 80), setInterval(poll, 400), setInterval(quip, 2400)];
  }

  function stopGauge() {
    if (gauge) gauge.forEach(clearInterval);
    gauge = null;
  }

  document.body.addEventListener("htmx:configRequest", (e) => {
    if (e.detail.elt !== form) return;
    const rid = crypto.randomUUID();
    e.detail.parameters.rid = rid;
    startGauge(rid);
  });
  document.body.addEventListener("htmx:afterRequest", (e) => {
    if (e.detail.elt !== form) return;
    stopGauge();
    document.getElementById("result").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // ---- board clocks ----------------------------------------------------------------

  const clockFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const tickClocks = () => {
    const t = clockFmt.format(new Date());
    document.querySelectorAll("[data-clock]").forEach((el) => (el.textContent = t));
  };
  setInterval(tickClocks, 1000);
  document.body.addEventListener("htmx:afterSwap", tickClocks);

  // ---- wire up ---------------------------------------------------------------------

  document.querySelectorAll(".combo").forEach(setupCombo);
  form.querySelector(".swap").addEventListener("click", () => {
    const a = combos.from.get() ?? { name: form.from.value };
    const b = combos.to.get() ?? { name: form.to.value };
    combos.from.set(b.id ? byId.get(b.id) ?? b : null);
    combos.to.set(a.id ? byId.get(a.id) ?? a : null);
    if (!b.id) form.from.value = b.name;
    if (!a.id) form.to.value = a.name;
  });
  renderSaved();
  loadStations();
})();
