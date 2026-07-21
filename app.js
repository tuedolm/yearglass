(() => {
  "use strict";

  // ---------- Config ----------

  const CONFIG = {
    name: "Yearglass",         // game name; single place to change on rename
    puzzlePath: "puzzles/",    // where daily blobs live (static dir or CDN)
    analyticsEndpoint: "https://yearglass-analytics.tuedolm.workers.dev/", // anonymous score events; GET /stats for aggregates
  };

  const MIN_YEAR = 1826;
  const MAX_YEAR = new Date().getUTCFullYear();
  const ROUNDS = 5;
  const MAX_POINTS = 5000;
  const DECAY = 12; // the single most important tuning parameter in the product
  const HINT_MULT = 0.6; // hint reveals the decade, keeps 60% of the round score

  // Non-linear slider: position fraction -> year. Recent decades get more
  // travel because the library is denser there and discrimination is finer.
  const ANCHORS = [
    [0.0, MIN_YEAR],
    [0.10, 1900],
    [0.22, 1940],
    [0.42, 1970],
    [0.72, 2000],
    [1.0, MAX_YEAR],
  ];

  // ---------- Slider math ----------

  function posToYear(p) {
    p = Math.min(1, Math.max(0, p));
    for (let i = 1; i < ANCHORS.length; i++) {
      const [p0, y0] = ANCHORS[i - 1];
      const [p1, y1] = ANCHORS[i];
      if (p <= p1) {
        return Math.round(y0 + ((p - p0) / (p1 - p0)) * (y1 - y0));
      }
    }
    return MAX_YEAR;
  }

  function yearToPos(y) {
    y = Math.min(MAX_YEAR, Math.max(MIN_YEAR, y));
    for (let i = 1; i < ANCHORS.length; i++) {
      const [p0, y0] = ANCHORS[i - 1];
      const [p1, y1] = ANCHORS[i];
      if (y <= y1) {
        return p0 + ((y - y0) / (y1 - y0)) * (p1 - p0);
      }
    }
    return 1;
  }

  // ---------- Scoring ----------

  function score(err) {
    return Math.round(MAX_POINTS * Math.exp(-Math.abs(err) / DECAY));
  }

  function band(err) {
    if (err <= 2) return { key: "g", emoji: "🟩", verdict: err === 0 ? "Perfect" : "Excellent" };
    if (err <= 5) return { key: "g", emoji: "🟩", verdict: "Strong" };
    if (err <= 10) return { key: "y", emoji: "🟨", verdict: "Respectable" };
    if (err <= 20) return { key: "o", emoji: "🟧", verdict: "Weak" };
    if (err <= 40) return { key: "r", emoji: "🟥", verdict: "Miss" };
    return { key: "b", emoji: "⬛", verdict: "Wild" };
  }

  const fmt = (n) => n.toLocaleString("en-US");

  // ---------- Dates ----------

  const todayStr = new Date().toISOString().slice(0, 10); // UTC date
  const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  // ---------- Storage ----------

  const KEY_STATE = "tl.state";
  const KEY_STATS = "tl.stats";
  const KEY_HELP = "tl.helpSeen";
  const KEY_VISIT = "tl.lastVisit";

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Private browsing / quota errors: the game still works, just without persistence.
    }
  }

  const defaultStats = () => ({
    games: 0, totalScore: 0, best: 0,
    streak: 0, maxStreak: 0, lastDate: "",
    bands: { g: 0, y: 0, o: 0, r: 0, b: 0 },
  });

  let stats = Object.assign(defaultStats(), loadJSON(KEY_STATS, {}));

  // ---------- Analytics (no-op unless an endpoint is configured) ----------

  function track(event, payload) {
    if (!CONFIG.analyticsEndpoint) return;
    const body = JSON.stringify(Object.assign({ e: event, d: todayStr }, payload));
    try {
      if (!(navigator.sendBeacon && navigator.sendBeacon(CONFIG.analyticsEndpoint, body))) {
        fetch(CONFIG.analyticsEndpoint, { method: "POST", body, keepalive: true }).catch(() => {});
      }
    } catch {
      // Analytics must never break the game.
    }
  }

  // ---------- State ----------

  let puzzle = null;
  let roundIndex = 0;
  let currentYear = posToYear(0.5); // same deterministic start for every player
  let committed = false;
  let hintUsed = false;
  let results = [];
  let countdownTimer = null;

  // ---------- Elements ----------

  const $ = (id) => document.getElementById(id);
  const els = {};
  for (const id of [
    "wordmark", "puzzle-label", "round-label", "score-label", "stage",
    "photo", "photo-loading", "no-puzzle", "controls", "year-readout",
    "slider", "slider-track", "ticks", "tick-labels", "thumb", "guess-btn",
    "reveal", "reveal-verdict", "reveal-guess", "reveal-actual",
    "reveal-error", "reveal-points", "reveal-blurb", "reveal-credit",
    "hint-chip", "hint-btn",
    "next-btn", "results", "results-name", "results-number", "results-grid",
    "results-total", "results-streak", "results-breakdown", "share-btn",
    "share-feedback", "countdown", "help-modal", "help-btn", "help-close",
    "stats-modal", "stats-btn", "stats-close", "stat-games", "stat-avg",
    "stat-best", "stat-streak", "stat-max-streak", "band-bars",
  ]) {
    els[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = $(id);
  }

  // ---------- Slider rendering ----------

  function buildTicks() {
    const labeled = [MIN_YEAR, 1900, 1950, 1980, MAX_YEAR];
    for (let y = 1830; y < MAX_YEAR; y += 10) {
      const tick = document.createElement("div");
      tick.className = "tick" + (y % 50 === 0 ? " major" : "");
      tick.style.left = (yearToPos(y) * 100).toFixed(3) + "%";
      els.ticks.appendChild(tick);
    }
    for (const y of labeled) {
      const label = document.createElement("div");
      label.className = "tick-label";
      label.textContent = y;
      label.style.left = (yearToPos(y) * 100).toFixed(3) + "%";
      els.tickLabels.appendChild(label);
    }
  }

  function setYear(y) {
    currentYear = Math.min(MAX_YEAR, Math.max(MIN_YEAR, Math.round(y)));
    els.thumb.style.left = (yearToPos(currentYear) * 100).toFixed(3) + "%";
    els.yearReadout.textContent = currentYear;
    els.slider.setAttribute("aria-valuenow", currentYear);
    els.slider.setAttribute("aria-valuetext", String(currentYear));
  }

  // ---------- Slider input ----------

  function posFromEvent(e) {
    const rect = els.sliderTrack.getBoundingClientRect();
    return (e.clientX - rect.left) / rect.width;
  }

  let dragging = false;

  els.slider.addEventListener("pointerdown", (e) => {
    if (committed) return;
    dragging = true;
    els.slider.classList.add("dragging");
    els.slider.setPointerCapture(e.pointerId);
    setYear(posToYear(posFromEvent(e)));
    els.slider.focus();
    e.preventDefault();
  });

  els.slider.addEventListener("pointermove", (e) => {
    if (!dragging || committed) return;
    setYear(posToYear(posFromEvent(e)));
  });

  els.slider.addEventListener("pointerup", () => {
    dragging = false;
    els.slider.classList.remove("dragging");
  });

  els.slider.addEventListener("keydown", (e) => {
    if (committed) return;
    const steps = {
      ArrowLeft: -1, ArrowDown: -1,
      ArrowRight: 1, ArrowUp: 1,
      PageDown: -10, PageUp: 10,
    };
    if (e.key in steps) {
      setYear(currentYear + steps[e.key]);
      e.preventDefault();
    } else if (e.key === "Home") {
      setYear(MIN_YEAR); e.preventDefault();
    } else if (e.key === "End") {
      setYear(MAX_YEAR); e.preventDefault();
    } else if (e.key === "Enter") {
      commitGuess(); e.preventDefault();
    }
  });

  // ---------- Round flow ----------

  function totalScore() {
    return results.reduce((s, r) => s + r.pts, 0);
  }

  function updateHeader() {
    els.scoreLabel.textContent = `${fmt(totalScore())} pts`;
    els.roundLabel.textContent = `Round ${Math.min(roundIndex + 1, ROUNDS)} of ${ROUNDS}`;
  }

  function loadRound(i) {
    const round = puzzle.rounds[i];
    committed = false;
    hintUsed = false;
    els.hintChip.hidden = true;
    els.hintBtn.disabled = false;
    els.photo.classList.remove("faded");
    els.photo.removeAttribute("src");
    els.photoLoading.hidden = false;
    els.photoLoading.textContent = "Loading photograph…";
    els.photo.src = round.image;
    els.reveal.hidden = true;
    els.controls.hidden = false;
    els.guessBtn.disabled = false;
    setYear(posToYear(0.5));
    updateHeader();
    els.slider.focus();
    if (i + 1 < puzzle.rounds.length) new Image().src = puzzle.rounds[i + 1].image;
  }

  els.photo.addEventListener("load", () => { els.photoLoading.hidden = true; });
  els.photo.addEventListener("error", () => {
    if (els.photo.getAttribute("src")) {
      els.photoLoading.hidden = false;
      els.photoLoading.textContent = "Photograph failed to load.";
    }
  });

  function commitGuess() {
    if (committed || !puzzle) return;
    committed = true;

    const round = puzzle.rounds[roundIndex];
    const err = Math.abs(currentYear - round.year);
    const pts = hintUsed ? Math.round(score(err) * HINT_MULT) : score(err);
    const b = band(err);
    results.push({ guess: currentYear, actual: round.year, err, pts, emoji: b.emoji, band: b.key, hinted: hintUsed });
    saveJSON(KEY_STATE, { date: todayStr, results });
    track("round", { n: puzzle.number, r: roundIndex + 1, err, pts, hint: hintUsed ? 1 : 0 });

    showReveal(results[results.length - 1], b.verdict, round);
  }

  function showReveal(r, verdict, round) {
    updateHeader();
    els.revealVerdict.textContent = verdict;
    els.revealGuess.textContent = r.guess;
    els.revealActual.textContent = r.actual;
    els.revealError.textContent =
      r.err === 0 ? "spot on" : r.err === 1 ? "1 year off" : `${r.err} years off`;
    els.revealPoints.textContent = `+${fmt(r.pts)} points` + (r.hinted ? " · hint used" : "");
    els.revealBlurb.textContent = round.blurb;
    els.revealCredit.textContent = round.credit;
    els.nextBtn.textContent = roundIndex === ROUNDS - 1 ? "See results" : "Next photo";

    els.controls.hidden = true;
    els.reveal.hidden = false;
    els.nextBtn.focus();
  }

  els.guessBtn.addEventListener("click", commitGuess);

  els.hintBtn.addEventListener("click", () => {
    if (committed || hintUsed || !puzzle) return;
    hintUsed = true;
    const decade = Math.floor(puzzle.rounds[roundIndex].year / 10) * 10;
    els.hintChip.textContent = `📅 The ${decade}s`;
    els.hintChip.hidden = false;
    els.hintBtn.disabled = true;
    els.slider.focus();
    track("hint", { n: puzzle.number, r: roundIndex + 1 });
  });

  els.nextBtn.addEventListener("click", () => {
    roundIndex++;
    if (roundIndex < ROUNDS) {
      loadRound(roundIndex);
    } else {
      finishGame();
    }
  });

  // ---------- Completion, stats, results ----------

  function finishGame() {
    // Stats update exactly once per day: skip if already recorded for today
    // (e.g. the player finished, refreshed, and we restored a done game).
    if (stats.lastDate !== todayStr) {
      const total = totalScore();
      stats.games += 1;
      stats.totalScore += total;
      stats.best = Math.max(stats.best, total);
      stats.streak = stats.lastDate === yesterdayStr ? stats.streak + 1 : 1;
      stats.maxStreak = Math.max(stats.maxStreak, stats.streak);
      stats.lastDate = todayStr;
      for (const r of results) stats.bands[r.band] += 1;
      saveJSON(KEY_STATS, stats);
      track("complete", { n: puzzle.number, total });
    }
    showResults();
  }

  function shareText() {
    const grid = results.map((r) => r.emoji).join("");
    const num = String(puzzle.number).padStart(3, "0");
    return `${CONFIG.name} #${num}\n${grid}\n${fmt(totalScore())} / ${fmt(ROUNDS * MAX_POINTS)}`;
  }

  function showResults() {
    els.stage.hidden = true;
    els.controls.hidden = true;
    els.reveal.hidden = true;
    els.results.hidden = false;
    els.roundLabel.textContent = "Done for today";
    els.scoreLabel.textContent = `${fmt(totalScore())} pts`;

    els.resultsName.textContent = CONFIG.name;
    els.resultsNumber.textContent = `#${String(puzzle.number).padStart(3, "0")}`;
    els.resultsGrid.textContent = results.map((r) => r.emoji).join("");
    els.resultsTotal.textContent = `${fmt(totalScore())} / ${fmt(ROUNDS * MAX_POINTS)}`;

    if (stats.streak >= 2) {
      els.resultsStreak.hidden = false;
      els.resultsStreak.textContent = `🔥 ${stats.streak}-day streak`;
    }

    els.resultsBreakdown.innerHTML = "";
    results.forEach((r, i) => {
      const round = puzzle.rounds[i];
      const card = document.createElement("div");
      card.className = "breakdown-card";

      const row = document.createElement("div");
      row.className = "breakdown-row";

      const emoji = document.createElement("div");
      emoji.className = "breakdown-emoji";
      emoji.textContent = r.emoji;

      const desc = document.createElement("div");
      desc.className = "breakdown-desc";
      const strong = document.createElement("strong");
      strong.textContent = r.actual;
      desc.append(strong, ` — you said ${r.guess}${r.hinted ? " 💡" : ""}`);

      const errEl = document.createElement("div");
      errEl.className = "breakdown-error";
      errEl.textContent = r.err === 0 ? "exact" : `${r.err} yr${r.err === 1 ? "" : "s"} off`;

      const ptsEl = document.createElement("div");
      ptsEl.className = "breakdown-points";
      ptsEl.textContent = fmt(r.pts);

      row.append(emoji, desc, errEl, ptsEl);
      card.appendChild(row);

      if (round) {
        const story = document.createElement("div");
        story.className = "breakdown-story";
        const thumb = document.createElement("img");
        thumb.className = "breakdown-thumb";
        thumb.src = round.image;
        thumb.alt = round.blurb;
        thumb.loading = "lazy";
        const text = document.createElement("div");
        const blurb = document.createElement("p");
        blurb.className = "breakdown-blurb";
        blurb.textContent = round.blurb;
        const storyP = document.createElement("p");
        storyP.className = "breakdown-story-text";
        storyP.textContent = round.story || "";
        text.append(blurb, storyP);
        story.append(thumb, text);
        card.appendChild(story);
      }

      els.resultsBreakdown.appendChild(card);
    });

    startCountdown();
    els.shareBtn.focus();
  }

  function startCountdown() {
    const tick = () => {
      const now = Date.now();
      const nextMidnight = Math.ceil(now / 86400000) * 86400000;
      let s = Math.max(0, Math.floor((nextMidnight - now) / 1000));
      const h = String(Math.floor(s / 3600)).padStart(2, "0");
      const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
      const sec = String(s % 60).padStart(2, "0");
      els.countdown.textContent = `${h}:${m}:${sec}`;
    };
    tick();
    clearInterval(countdownTimer);
    countdownTimer = setInterval(tick, 1000);
  }

  els.shareBtn.addEventListener("click", async () => {
    const text = shareText();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    els.shareFeedback.textContent = "Copied to clipboard";
    track("share", { n: puzzle.number });
    setTimeout(() => { els.shareFeedback.textContent = ""; }, 2500);
  });

  // ---------- Modals ----------

  function openModal(el) { el.hidden = false; }
  function closeModal(el) { el.hidden = true; }

  els.helpBtn.addEventListener("click", () => openModal(els.helpModal));
  els.helpClose.addEventListener("click", () => {
    closeModal(els.helpModal);
    saveJSON(KEY_HELP, true);
    els.slider.focus();
  });

  els.statsBtn.addEventListener("click", () => {
    renderStats();
    openModal(els.statsModal);
  });
  els.statsClose.addEventListener("click", () => closeModal(els.statsModal));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeModal(els.helpModal);
      closeModal(els.statsModal);
    }
  });
  for (const backdrop of [els.helpModal, els.statsModal]) {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal(backdrop);
    });
  }

  function renderStats() {
    els.statGames.textContent = stats.games;
    els.statAvg.textContent = stats.games ? fmt(Math.round(stats.totalScore / stats.games)) : "—";
    els.statBest.textContent = stats.games ? fmt(stats.best) : "—";
    els.statStreak.textContent = stats.streak;
    els.statMaxStreak.textContent = stats.maxStreak;

    const labels = { g: "≤ 5 yrs", y: "≤ 10", o: "≤ 20", r: "≤ 40", b: "wild" };
    const colors = { g: "#4caf6e", y: "#e8c53d", o: "#e8973d", r: "#e05252", b: "#555" };
    const max = Math.max(1, ...Object.values(stats.bands));
    els.bandBars.innerHTML = "";
    for (const key of ["g", "y", "o", "r", "b"]) {
      const row = document.createElement("div");
      row.className = "band-row";
      const label = document.createElement("span");
      label.className = "band-label";
      label.textContent = labels[key];
      const bar = document.createElement("div");
      bar.className = "band-bar";
      bar.style.width = (stats.bands[key] / max) * 100 + "%";
      bar.style.background = colors[key];
      const count = document.createElement("span");
      count.className = "band-count";
      count.textContent = stats.bands[key];
      row.append(label, bar, count);
      els.bandBars.appendChild(row);
    }
  }

  // ---------- Boot ----------

  function showNoPuzzle() {
    els.photoLoading.hidden = true;
    els.noPuzzle.hidden = false;
    els.controls.hidden = true;
    els.puzzleLabel.textContent = "#—";
    els.roundLabel.textContent = "No puzzle";
  }

  async function boot() {
    els.wordmark.textContent = CONFIG.name.toUpperCase();
    document.title = `${CONFIG.name} — the daily photo dating game`;
    els.slider.setAttribute("aria-valuemin", MIN_YEAR);
    els.slider.setAttribute("aria-valuemax", MAX_YEAR);
    buildTicks();

    try {
      const res = await fetch(`${CONFIG.puzzlePath}${todayStr}.json`, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      puzzle = await res.json();
    } catch {
      showNoPuzzle();
      return;
    }

    els.puzzleLabel.textContent = `#${String(puzzle.number).padStart(3, "0")}`;

    // Daily-active signal: once per browser per UTC day, no identifiers.
    if (loadJSON(KEY_VISIT, "") !== todayStr) {
      saveJSON(KEY_VISIT, todayStr);
      track("visit", { n: puzzle.number });
    }

    const state = loadJSON(KEY_STATE, null);
    if (state && state.date === todayStr && Array.isArray(state.results)) {
      results = state.results;
      roundIndex = results.length;
    }

    if (roundIndex >= ROUNDS) {
      showResults();
    } else {
      loadRound(roundIndex);
      if (!loadJSON(KEY_HELP, false)) openModal(els.helpModal);
    }
  }

  boot();
})();
