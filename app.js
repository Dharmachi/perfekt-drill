const BATCH = 10;
const WEAK_KEY = "perfekt-weak-v1";
const PROGRESS_KEY = "perfekt-progress-v1";
const MAX_FAM = 5;

const MODES = [
  { id: "aux", title: "1. hat / ist", desc: "只練完成時助動詞。" },
  { id: "participle", title: "2. 過去分詞", desc: "選擇或填寫 Partizip II。" },
  { id: "present", title: "3. 現在時", desc: "選第三人稱現在時形式。" },
  { id: "triple", title: "4. 混合完成時", desc: "同時答助動詞 + 分詞。" },
  { id: "sentence", title: "5. 例句填空", desc: "看例句與中文，補上 hat/ist + 分詞。" },
];

const SAMPLING = [
  { id: "study", title: "背誦進度", desc: "依詞表順序，每卷 10 個新詞，不重複直到刷完一輪。" },
  { id: "smart", title: "智能混合", desc: "隨機抽題，越不熟悉出現越多。" },
  { id: "weak", title: "弱項加強", desc: "只打熟悉度低或最近錯過的詞。" },
];

function loadProgress() {
  try {
    const raw = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
    const familiarity = raw.familiarity && typeof raw.familiarity === "object" ? raw.familiarity : {};
    // migrate old weak list into familiarity 0
    try {
      const oldWeak = JSON.parse(localStorage.getItem(WEAK_KEY) || "[]");
      oldWeak.forEach((id) => {
        if (familiarity[id] == null) familiarity[id] = 0;
      });
    } catch {
      /* ignore */
    }
    return {
      familiarity,
      studyIndex: Number.isFinite(raw.studyIndex) ? raw.studyIndex : 0,
      cycles: Number.isFinite(raw.cycles) ? raw.cycles : 0,
    };
  } catch {
    return { familiarity: {}, studyIndex: 0, cycles: 0 };
  }
}

function saveProgress(progress) {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
}

function famOf(progress, id) {
  const n = progress.familiarity[id];
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_FAM, n)) : 0;
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, seed) {
  const rng = mulberry32(seed >>> 0);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normalize(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/ß/g, "ss")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue");
}

function byId(id) {
  return window.VERBS.find((v) => v.id === id);
}

function getExample(id) {
  return (window.EXAMPLES && window.EXAMPLES[id]) || null;
}

function perfectPhrase(verb) {
  return `${verb.aux} ${verb.participle}`;
}

function fullSentence(verb, ex) {
  if (!ex) return perfectPhrase(verb);
  const after = ex.after == null ? "." : ex.after;
  return `${ex.before} ${verb.aux} ${ex.mid} ${verb.participle}${after}`;
}

function distractors(verb, field, seed, n = 3) {
  const pool = window.VERBS.filter((v) => v.id !== verb.id && v[field] !== verb[field]).map(
    (v) => v[field],
  );
  return shuffle(pool, seed).slice(0, n);
}

function phraseDistractors(verb, seed, n = 3) {
  const correct = perfectPhrase(verb);
  const pool = window.VERBS.filter((v) => v.id !== verb.id)
    .map((v) => perfectPhrase(v))
    .filter((p) => p !== correct);
  return shuffle([...new Set(pool)], seed).slice(0, n);
}

function poolIds(mode) {
  let all = window.VERBS.map((v) => v.id);
  if (mode === "sentence") all = all.filter((id) => !!getExample(id));
  return all;
}

function weightedSample(ids, getWeight, n, seed) {
  const rng = mulberry32(seed >>> 0);
  const pool = ids.map((id) => ({ id, w: Math.max(0.01, getWeight(id)) }));
  const result = [];
  for (let k = 0; k < n && pool.length; k++) {
    const total = pool.reduce((s, p) => s + p.w, 0);
    let r = rng() * total;
    let idx = 0;
    for (; idx < pool.length; idx++) {
      r -= pool[idx].w;
      if (r <= 0) break;
    }
    idx = Math.min(idx, pool.length - 1);
    result.push(pool[idx].id);
    pool.splice(idx, 1);
  }
  return result;
}

function buildQueue(mode, sampling, progress, seed) {
  const all = poolIds(mode);
  if (!all.length) return [];

  if (sampling === "study") {
    const start = ((progress.studyIndex % all.length) + all.length) % all.length;
    const queue = [];
    for (let i = 0; i < Math.min(BATCH, all.length); i++) {
      queue.push(all[(start + i) % all.length]);
    }
    return queue;
  }

  if (sampling === "weak") {
    const weak = all.filter((id) => famOf(progress, id) <= 1);
    const base = weak.length ? weak : all;
    return weightedSample(base, (id) => (MAX_FAM + 1 - famOf(progress, id)) ** 2, Math.min(BATCH, base.length), seed);
  }

  // smart: unfamiliar appears more
  return weightedSample(
    all,
    (id) => (MAX_FAM + 1 - famOf(progress, id)) ** 2,
    Math.min(BATCH, all.length),
    seed,
  );
}

function progressStats(progress) {
  const ids = window.VERBS.map((v) => v.id);
  let unseen = 0;
  let learning = 0;
  let known = 0;
  ids.forEach((id) => {
    const f = famOf(progress, id);
    if (f <= 0) unseen += 1;
    else if (f <= 3) learning += 1;
    else known += 1;
  });
  const weak = ids.filter((id) => famOf(progress, id) <= 1).length;
  const studied = Math.min(progress.studyIndex, ids.length);
  return { unseen, learning, known, weak, studied, total: ids.length };
}

let progress = loadProgress();

/** @type {any} */
let state = {
  screen: "menu",
  mode: "aux",
  difficulty: "easy",
  sampling: "study",
  seed: Date.now() % 1e9,
  items: [],
  answers: {},
  graded: null,
  studyWrapped: false,
};

function start(mode) {
  const seed = (state.seed + 17) >>> 0;
  const queue = buildQueue(mode, state.sampling, progress, seed);
  const items = queue.map((id, i) => {
    const verb = byId(id);
    const itemSeed = seed + i * 97;
    const phrase = perfectPhrase(verb);
    return {
      id,
      verb,
      example: getExample(id),
      presentOpts: shuffle([verb.present, ...distractors(verb, "present", itemSeed, 3)], itemSeed + 1),
      partOpts: shuffle(
        [verb.participle, ...distractors(verb, "participle", itemSeed + 3, 3)],
        itemSeed + 5,
      ),
      phraseOpts: shuffle([phrase, ...phraseDistractors(verb, itemSeed + 9, 3)], itemSeed + 11),
    };
  });
  state = {
    ...state,
    screen: "quiz",
    mode,
    seed,
    items,
    answers: Object.fromEntries(queue.map((id) => [id, {}])),
    graded: null,
    studyWrapped: false,
  };
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setAnswer(id, patch) {
  state.answers[id] = { ...state.answers[id], ...patch };
  render();
}

function isFilled(item) {
  const a = state.answers[item.id] || {};
  const mode = state.mode;
  if (mode === "aux") return !!a.aux;
  if (mode === "present") return !!a.pick;
  if (mode === "participle" || mode === "sentence") {
    return state.difficulty === "easy" ? !!a.pick : normalize(a.fill).length > 0;
  }
  const partOk = state.difficulty === "easy" ? !!a.pick : normalize(a.fill).length > 0;
  return !!a.aux && partOk;
}

function filledCount() {
  return state.items.filter(isFilled).length;
}

function gradeOne(item) {
  const a = state.answers[item.id] || {};
  const v = item.verb;
  let ok = false;
  let expected = "";

  if (state.mode === "aux") {
    ok = a.aux === v.aux;
    expected = v.aux;
  } else if (state.mode === "present") {
    ok = a.pick === v.present;
    expected = v.present;
  } else if (state.mode === "participle") {
    ok =
      state.difficulty === "easy"
        ? a.pick === v.participle
        : normalize(a.fill) === normalize(v.participle);
    expected = v.participle;
  } else if (state.mode === "sentence") {
    expected = perfectPhrase(v);
    ok =
      state.difficulty === "easy"
        ? a.pick === expected
        : normalize(a.fill) === normalize(expected);
  } else {
    const auxOk = a.aux === v.aux;
    const partOk =
      state.difficulty === "easy"
        ? a.pick === v.participle
        : normalize(a.fill) === normalize(v.participle);
    ok = auxOk && partOk;
    expected = perfectPhrase(v);
  }

  return { ok, expected, verb: v };
}

function submit() {
  const details = state.items.map(gradeOne);
  const right = details.filter((d) => d.ok).length;
  const wrong = details.length - right;

  details.forEach((d, i) => {
    const id = state.items[i].id;
    const cur = famOf(progress, id);
    progress.familiarity[id] = d.ok ? Math.min(MAX_FAM, cur + 1) : Math.max(0, cur - 1);
  });

  let studyWrapped = false;
  if (state.sampling === "study") {
    const all = poolIds(state.mode);
    const next = progress.studyIndex + state.items.length;
    if (next >= all.length) {
      progress.studyIndex = next % all.length;
      progress.cycles += 1;
      studyWrapped = true;
    } else {
      progress.studyIndex = next;
    }
  }

  saveProgress(progress);

  state = {
    ...state,
    screen: "result",
    graded: { right, wrong, details },
    studyWrapped,
  };
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetProgress() {
  if (!confirm("確定要清空熟悉度與背誦進度嗎？")) return;
  progress = { familiarity: {}, studyIndex: 0, cycles: 0 };
  saveProgress(progress);
  localStorage.removeItem(WEAK_KEY);
  render();
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSentenceFrame(item, shownAux, shownPart) {
  const ex = item.example;
  if (!ex) return "";
  const after = ex.after == null ? "." : ex.after;
  const auxSlot = shownAux
    ? `<span class="slot filled">${esc(shownAux)}</span>`
    : `<span class="slot">____</span>`;
  const partSlot = shownPart
    ? `<span class="slot filled">${esc(shownPart)}</span>`
    : `<span class="slot">____</span>`;
  return `
    <div class="sent-zh">${esc(ex.zh)}</div>
    <div class="sent-de">
      <span>${esc(ex.before)}</span>
      ${auxSlot}
      <span>${esc(ex.mid)}</span>
      ${partSlot}<span>${esc(after)}</span>
    </div>
    <div class="sent-hint">提示動詞：<strong>${esc(item.verb.infinitive)}</strong>（${esc(item.verb.zh || "")}）</div>
  `;
}

function famLabel(id) {
  const f = famOf(progress, id);
  return `熟悉 ${f}/${MAX_FAM}`;
}

function renderMenu() {
  const stats = progressStats(progress);
  const pct = Math.round((stats.known / Math.max(1, stats.total)) * 100);
  const studyFrom = (progress.studyIndex % stats.total) + 1;
  const studyTo = Math.min(studyFrom + BATCH - 1, stats.total);
  const samplingMeta = SAMPLING.find((s) => s.id === state.sampling);

  return `
    <h1>Perfekt 動詞速背</h1>
    <p class="sub">先用背誦進度刷完詞表，再用智能混合加強不熟的詞。<span style="opacity:.7">（版本 v6）</span></p>
    <div class="stats">
      <div class="stat"><b>${stats.unseen}</b><span>未熟悉</span></div>
      <div class="stat"><b>${stats.learning}</b><span>練習中</span></div>
      <div class="stat"><b>${stats.known}</b><span>較熟</span></div>
    </div>
    <div class="progress-wrap">
      <div class="progress-top">
        <span>掌握度 ${pct}%</span>
        <span>背誦進度 ${studyFrom}–${Math.min(studyTo, stats.total)} / ${stats.total}</span>
      </div>
      <div class="progress-bar"><i style="width:${pct}%"></i></div>
      <div class="progress-note">已完成整表 ${progress.cycles} 輪 · 弱項約 ${stats.weak} 個</div>
    </div>

    <div class="label-row">抽題方式</div>
    <div class="seg">
      ${SAMPLING.map(
        (s) => `
        <button type="button" class="${state.sampling === s.id ? "on" : ""}" data-sampling="${s.id}">${esc(s.title)}</button>`,
      ).join("")}
    </div>
    <p class="seg-desc">${esc(samplingMeta ? samplingMeta.desc : "")}</p>

    <div class="label-row">答題難度</div>
    <div class="seg">
      <button type="button" class="${state.difficulty === "easy" ? "on" : ""}" data-diff="easy">簡單·選擇</button>
      <button type="button" class="${state.difficulty === "hard" ? "on" : ""}" data-diff="hard">困難·填空</button>
    </div>

    <div class="label-row">題型（每卷 10 題）</div>
    <div class="modes">
      ${MODES.map(
        (m) => `
        <button class="mode" type="button" data-start="${m.id}">
          <strong>${esc(m.title)}</strong>
          <p>${esc(m.desc)}</p>
        </button>`,
      ).join("")}
    </div>
    <div class="hint">
      建議：背誦進度 + hat/ist／分詞 → 背誦進度 + 例句 → 智能混合 + 例句。答對熟悉度 +1，答錯 -1；智能混合會讓低分詞更常出現。
      <div class="install">
        <button type="button" class="linkish" data-reset>重置進度</button>
         · 手機可「加入主畫面」
      </div>
    </div>
  `;
}

function questionBlock(item, idx, locked, detail) {
  const v = item.verb;
  const a = state.answers[item.id] || {};
  const mode = state.mode;
  const cls = locked ? (detail.ok ? "ok" : "bad") : "";
  let body = "";

  if (mode === "sentence") {
    let shownAux = "";
    let shownPart = "";
    if (locked) {
      shownAux = v.aux;
      shownPart = v.participle;
    } else if (state.difficulty === "easy" && a.pick) {
      const parts = a.pick.split(" ");
      shownAux = parts[0] || "";
      shownPart = parts.slice(1).join(" ");
    } else if (state.difficulty === "hard" && a.fill) {
      const parts = a.fill.trim().split(/\s+/);
      shownAux = parts[0] || "";
      shownPart = parts.slice(1).join(" ");
    }
    body += renderSentenceFrame(item, shownAux, shownPart);
    body += `<div class="label">選擇或填寫完整完成時（助動詞 + 分詞）</div>`;
    if (state.difficulty === "easy") {
      body += `<div class="choices">
        ${item.phraseOpts
          .map(
            (opt) => `
          <button type="button" class="choice ${a.pick === opt ? "on" : ""}" data-ans="${v.id}" data-k="pick" data-v="${esc(opt)}" ${locked ? "disabled" : ""}>${esc(opt)}</button>`,
          )
          .join("")}
      </div>`;
    } else {
      body += `<input type="text" data-fill="${v.id}" placeholder="例如：ist abgefahren" value="${esc(a.fill || "")}" ${locked ? "disabled" : ""} />`;
    }
  } else {
    if (mode === "aux" || mode === "triple") {
      body += `
        <div class="label">完成時助動詞</div>
        <div class="choices">
          <button type="button" class="aux-btn ${a.aux === "hat" ? "on" : ""}" data-ans="${v.id}" data-k="aux" data-v="hat" ${locked ? "disabled" : ""}>hat</button>
          <button type="button" class="aux-btn ${a.aux === "ist" ? "on" : ""}" data-ans="${v.id}" data-k="aux" data-v="ist" ${locked ? "disabled" : ""}>ist</button>
        </div>`;
    }

    if (mode === "present") {
      body += `
        <div class="label">第三人稱現在時</div>
        <div class="choices">
          ${item.presentOpts
            .map(
              (opt) => `
            <button type="button" class="choice ${a.pick === opt ? "on" : ""}" data-ans="${v.id}" data-k="pick" data-v="${esc(opt)}" ${locked ? "disabled" : ""}>${esc(opt)}</button>`,
            )
            .join("")}
        </div>`;
    }

    if (mode === "participle" || mode === "triple") {
      body += `<div class="label">過去分詞 Partizip II</div>`;
      if (state.difficulty === "easy") {
        body += `<div class="choices">
          ${item.partOpts
            .map(
              (opt) => `
            <button type="button" class="choice ${a.pick === opt ? "on" : ""}" data-ans="${v.id}" data-k="pick" data-v="${esc(opt)}" ${locked ? "disabled" : ""}>${esc(opt)}</button>`,
            )
            .join("")}
        </div>`;
      } else {
        body += `<input type="text" data-fill="${v.id}" placeholder="例如：gegangen" value="${esc(a.fill || "")}" ${locked ? "disabled" : ""} />`;
      }
    }
  }

  if (locked) {
    const sentence = mode === "sentence" ? fullSentence(v, item.example) : "";
    body += `
      <div class="answer-key">
        <span class="mark ${detail.ok ? "ok" : "bad"}">${detail.ok ? "正確" : "錯誤"}</span>
        · ${esc(famLabel(v.id))} · ${esc(v.zh || "")}<br />
        ${esc(v.infinitive)} — ${esc(v.present)} — ${esc(v.aux)} ${esc(v.participle)}
        ${sentence ? `<br />完整句：${esc(sentence)}` : ""}
      </div>`;
  }

  return `
    <div class="q ${cls}" id="q-${v.id}">
      <div class="q-head">
        <div>
          <div class="q-inf">${esc(v.infinitive)}</div>
          <div class="q-zh">${esc(v.zh || "")} · ${esc(famLabel(v.id))}</div>
        </div>
        <div class="q-num">第 ${idx + 1} / ${state.items.length} 題</div>
      </div>
      ${body}
    </div>`;
}

function renderQuiz() {
  const modeTitle = MODES.find((m) => m.id === state.mode)?.title || "";
  const samplingTitle = SAMPLING.find((s) => s.id === state.sampling)?.title || "";
  const filled = filledCount();
  return `
    <div class="toolbar">
      <button type="button" class="btn ghost" style="flex:0;padding:8px 12px;font-size:0.85rem" data-back>選單</button>
      <span class="chip">${esc(samplingTitle)}</span>
      <span class="chip">${esc(modeTitle)}</span>
      <span class="chip">已填 ${filled}/${state.items.length}</span>
    </div>
    ${state.items.map((item, i) => questionBlock(item, i, false, null)).join("")}
    <div class="dock"><div class="dock-inner">
      <button type="button" class="btn ghost" data-back>返回</button>
      <button type="button" class="btn primary" data-submit ${filled < state.items.length ? "disabled" : ""}>
        提交驗證（${filled}/${state.items.length}）
      </button>
    </div></div>
  `;
}

function renderResult() {
  const g = state.graded;
  const pct = Math.round((g.right / Math.max(1, g.right + g.wrong)) * 100);
  const stats = progressStats(progress);
  const wrapNote = state.studyWrapped
    ? `<p class="sub" style="margin:8px 0 0">太棒了：背誦模式已刷完整表一輪（累計 ${progress.cycles} 輪）。下一卷會從頭再來，也可改用智能混合。</p>`
    : "";
  return `
    <div class="result-banner">
      <h2>本卷結果：${g.right} / ${g.right + g.wrong}</h2>
      <p class="sub" style="margin:0">正確率 ${pct}% · 較熟 ${stats.known}/${stats.total} · 弱項約 ${stats.weak}</p>
      ${wrapNote}
    </div>
    ${state.items.map((item, i) => questionBlock(item, i, true, g.details[i])).join("")}
    <div class="dock"><div class="dock-inner">
      <button type="button" class="btn ghost" data-back>回選單</button>
      <button type="button" class="btn primary" data-again>再來一卷</button>
    </div></div>
  `;
}

function render() {
  const root = document.getElementById("app");
  if (state.screen === "menu") root.innerHTML = renderMenu();
  else if (state.screen === "quiz") root.innerHTML = renderQuiz();
  else root.innerHTML = renderResult();
}

document.getElementById("app").addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;

  if (t.dataset.diff) {
    state.difficulty = t.dataset.diff;
    render();
    return;
  }
  if (t.dataset.sampling) {
    state.sampling = t.dataset.sampling;
    render();
    return;
  }
  if (t.hasAttribute("data-reset")) {
    resetProgress();
    return;
  }
  if (t.dataset.start) {
    start(t.dataset.start);
    return;
  }
  if (t.hasAttribute("data-back")) {
    state.screen = "menu";
    state.graded = null;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  if (t.hasAttribute("data-again")) {
    start(state.mode);
    return;
  }
  if (t.hasAttribute("data-submit")) {
    if (filledCount() === state.items.length) submit();
    return;
  }
  if (t.dataset.ans) {
    setAnswer(t.dataset.ans, { [t.dataset.k]: t.dataset.v });
  }
});

document.getElementById("app").addEventListener("input", (e) => {
  const el = e.target;
  if (el.matches("input[data-fill]")) {
    state.answers[el.dataset.fill] = {
      ...state.answers[el.dataset.fill],
      fill: el.value,
    };
    const filled = filledCount();
    const btn = document.querySelector("[data-submit]");
    if (btn) {
      btn.disabled = filled < state.items.length;
      btn.textContent = `提交驗證（${filled}/${state.items.length}）`;
    }
    const chip = [...document.querySelectorAll(".chip")].find((c) =>
      c.textContent.startsWith("已填"),
    );
    if (chip) chip.textContent = `已填 ${filled}/${state.items.length}`;
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./sw.js")
    .then((reg) => {
      reg.update().catch(() => {});
      // 若已有等待中的新 SW，立刻启用
      if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            // 新版本装好后刷新一次页面
            location.reload();
          }
        });
      });
    })
    .catch(() => {});

  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
}

render();
