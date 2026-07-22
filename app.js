const BATCH = 10;
const STORAGE_KEY = "perfekt-weak-v1";

const MODES = [
  { id: "aux", title: "1. hat / ist", desc: "一次 10 題，只選完成時助動詞。" },
  { id: "participle", title: "2. 過去分詞", desc: "選擇或填寫 Partizip II。" },
  { id: "present", title: "3. 現在時", desc: "選第三人稱現在時形式。" },
  { id: "triple", title: "4. 混合完成時", desc: "同時答助動詞 + 分詞。" },
  { id: "sentence", title: "5. 例句填空", desc: "看德文例句與中文，補上 hat/ist + 分詞。" },
  { id: "review", title: "6. 弱項複習", desc: "只抽你錯過的詞。" },
];

function loadWeak() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveWeak(ids) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...new Set(ids)]));
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

function buildQueue(mode, weakIds, seed) {
  let all = window.VERBS.map((v) => v.id);
  if (mode === "sentence") {
    all = all.filter((id) => !!getExample(id));
  }
  if (mode === "review") {
    const base = weakIds.length ? weakIds.filter((id) => all.includes(id) || byId(id)) : all;
    const reviewBase = weakIds.length ? weakIds : all;
    return shuffle(reviewBase, seed).slice(0, Math.min(BATCH, reviewBase.length));
  }
  const weakSet = new Set(weakIds);
  const weak = shuffle(
    all.filter((id) => weakSet.has(id)),
    seed,
  );
  const fresh = shuffle(
    all.filter((id) => !weakSet.has(id)),
    seed + 7,
  );
  return [...weak, ...fresh].slice(0, BATCH);
}

/** @type {{
 *  screen:'menu'|'quiz'|'result',
 *  mode:string,
 *  difficulty:'easy'|'hard',
 *  seed:number,
 *  items:any[],
 *  answers:Record<string,{aux?:string,pick?:string,fill?:string}>,
 *  graded:null|{right:number,wrong:number,details:any[]},
 *  weakIds:string[]
 * }} */
let state = {
  screen: "menu",
  mode: "aux",
  difficulty: "easy",
  seed: Date.now() % 1e9,
  items: [],
  answers: {},
  graded: null,
  weakIds: loadWeak(),
};

function start(mode) {
  const seed = (state.seed + 17) >>> 0;
  const queue = buildQueue(mode, state.weakIds, seed);
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
  if (mode === "participle") {
    return state.difficulty === "easy" ? !!a.pick : normalize(a.fill).length > 0;
  }
  if (mode === "sentence") {
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
  let weak = [...state.weakIds];
  details.forEach((d, i) => {
    const id = state.items[i].id;
    if (d.ok) weak = weak.filter((x) => x !== id);
    else if (!weak.includes(id)) weak.push(id);
  });
  saveWeak(weak);
  state = {
    ...state,
    screen: "result",
    graded: { right, wrong, details },
    weakIds: weak,
  };
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
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

function renderMenu() {
  const sein = window.VERBS.filter((v) => v.aux === "ist").length;
  const exampleCount = Object.keys(window.EXAMPLES || {}).length;
  return `
    <h1>Perfekt 動詞速背</h1>
    <p class="sub">每卷 10 題，全部做完再一次提交驗證。錯題會存進弱項池。</p>
    <div class="stats">
      <div class="stat"><b>${window.VERBS.length}</b><span>詞彙總數</span></div>
      <div class="stat"><b>${exampleCount}</b><span>例句</span></div>
      <div class="stat"><b>${state.weakIds.length}</b><span>弱項</span></div>
    </div>
    <div class="seg">
      <button type="button" class="${state.difficulty === "easy" ? "on" : ""}" data-diff="easy">簡單·選擇</button>
      <button type="button" class="${state.difficulty === "hard" ? "on" : ""}" data-diff="hard">困難·填空</button>
    </div>
    <div class="modes">
      ${MODES.map(
        (m) => `
        <button class="mode" type="button" data-start="${m.id}">
          <strong>${esc(m.title)}</strong>
          <p>${esc(m.desc)}${m.id === "review" && state.weakIds.length ? `（目前 ${state.weakIds.length} 個）` : ""}</p>
        </button>`,
      ).join("")}
    </div>
    <div class="hint">
      建議順序：hat/ist → 分詞 → 混合 → 例句填空 → 弱項。例句題會同時練語序：助動詞在中間、分詞在句尾。
      <div class="install">手機：Safari / Chrome 開此頁 →「加入主畫面」，之後像 App 一樣點開。</div>
    </div>
  `;
}

function questionBlock(item, idx, locked, detail) {
  const v = item.verb;
  const a = state.answers[item.id] || {};
  const mode = state.mode;
  const cls = locked ? (detail.ok ? "ok" : "bad") : "";

  let body = "";
  let headInf = v.infinitive;
  let headZh = v.zh || "";

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
    headInf = "例句題";
    headZh = item.example ? item.example.zh : v.zh || "";
  } else {
    if (mode === "aux" || mode === "triple" || mode === "review") {
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

    if (mode === "participle" || mode === "triple" || mode === "review") {
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
        · ${esc(v.zh || "")}<br />
        ${esc(v.infinitive)} — ${esc(v.present)} — ${esc(v.aux)} ${esc(v.participle)}
        ${sentence ? `<br />完整句：${esc(sentence)}` : ""}
      </div>`;
  }

  return `
    <div class="q ${cls}" id="q-${v.id}">
      <div class="q-head">
        <div>
          <div class="q-inf">${esc(mode === "sentence" ? v.infinitive : headInf)}</div>
          <div class="q-zh">${esc(mode === "sentence" ? v.zh || "" : headZh)}</div>
        </div>
        <div class="q-num">第 ${idx + 1} / ${BATCH} 題</div>
      </div>
      ${body}
    </div>`;
}

function renderQuiz() {
  const modeTitle = MODES.find((m) => m.id === state.mode)?.title || "";
  const filled = filledCount();
  const locked = false;
  return `
    <div class="toolbar">
      <button type="button" class="btn ghost" style="flex:0;padding:8px 12px;font-size:0.85rem" data-back>選單</button>
      <span class="chip">${esc(modeTitle)}</span>
      <span class="chip">${state.difficulty === "easy" ? "選擇" : "填空"}</span>
      <span class="chip">已填 ${filled}/${state.items.length}</span>
    </div>
    ${state.items.map((item, i) => questionBlock(item, i, locked, null)).join("")}
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
  return `
    <div class="result-banner">
      <h2>本卷結果：${g.right} / ${g.right + g.wrong}</h2>
      <p class="sub" style="margin:0">正確率 ${pct}% · 弱項池現在有 ${state.weakIds.length} 個詞</p>
    </div>
    ${state.items
      .map((item, i) => questionBlock(item, i, true, g.details[i]))
      .join("")}
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
    const val = t.dataset.v;
    setAnswer(t.dataset.ans, { [t.dataset.k]: val });
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
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

render();
