(function () {
  const main = document.getElementById("main");
  const updatedEl = document.getElementById("updated-at");
  const refreshBtn = document.getElementById("refresh-btn");
  const tabs = document.querySelectorAll(".tab");

  let currentLeague = "LEC";
  let payload = null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fmtDateTime(iso) {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const datePart = sameDay ? "Today" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const timePart = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${datePart} · ${timePart}`;
  }

  function relativeTime(iso) {
    const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 5) return "just now";
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    return `${hrs} ${hrs === 1 ? "hr" : "hrs"} ago`;
  }

  function logoImg(src, code) {
    if (!src) return "";
    return `<img class="team-logo" src="${escapeHtml(src)}" alt="" loading="lazy" onerror="this.style.display='none'" />`;
  }

  function renderStandings(rows) {
    const trs = rows
      .map((r) => {
        const matchTotal = r.matchWins + r.matchLosses;
        const pct = matchTotal ? Math.round((r.matchWins / matchTotal) * 100) : 0;
        return `<tr>
          <td><span class="rank-num">${r.rank}</span></td>
          <td>
            <div class="team-cell">
              ${logoImg(r.image, r.code)}
              <div>
                <span class="team-name">${escapeHtml(r.name)}</span><span class="team-code">${escapeHtml(r.code)}</span>
                <div class="winrate-bar"><span style="width:${pct}%"></span></div>
              </div>
            </div>
          </td>
          <td class="num record"><span class="w">${r.matchWins}</span>–<span class="l">${r.matchLosses}</span></td>
          <td class="num record faint">${r.gameWins}–${r.gameLosses}</td>
          <td class="num record">${pct}%</td>
        </tr>`;
      })
      .join("");
    return `<div class="table-scroll"><table class="standings">
      <thead><tr><th></th><th>Team</th><th class="num">Matches</th><th class="num">Games</th><th class="num">Win%</th></tr></thead>
      <tbody>${trs}</tbody>
    </table></div>`;
  }

  function renderResults(rows) {
    if (!rows.length) return `<div class="empty-note">No completed matches yet this split.</div>`;
    return rows
      .slice()
      .reverse()
      .map((r) => {
        const w1 = r.wins1 > r.wins2;
        const w2 = r.wins2 > r.wins1;
        return `<div class="list-row">
          <div class="when"><span>${escapeHtml(r.blockName || "")}</span><span>${fmtDateTime(r.startTime)}</span></div>
          <div class="matchup">
            <div class="side ${w1 ? "winner" : ""}">${logoImg(r.image1, r.code1)}<span class="name">${escapeHtml(r.code1)}</span></div>
            <div class="score"><span class="${w1 ? "w" : ""}">${r.wins1}</span>–<span class="${w2 ? "w" : ""}">${r.wins2}</span></div>
            <div class="side right ${w2 ? "winner" : ""}"><span class="name">${escapeHtml(r.code2)}</span>${logoImg(r.image2, r.code2)}</div>
          </div>
        </div>`;
      })
      .join("");
  }

  function renderUpcoming(rows) {
    if (!rows.length) return `<div class="empty-note">No games currently scheduled — check back soon.</div>`;
    return rows
      .map((r) => {
        return `<div class="list-row">
          <div class="when"><span>${escapeHtml(r.blockName || "")}</span><span>${fmtDateTime(r.startTime)}</span></div>
          <div class="matchup">
            <div class="side">${logoImg(r.image1, r.code1)}<span class="name">${escapeHtml(r.code1)}</span></div>
            <div class="vs">vs</div>
            <div class="side right"><span class="name">${escapeHtml(r.code2)}</span>${logoImg(r.image2, r.code2)}</div>
          </div>
          <div style="text-align:right"><span class="bo-tag">BO${r.bestOf || 3}</span></div>
        </div>`;
      })
      .join("");
  }

  function renderPanel(key, d) {
    return `<div class="grid">
      <section class="card">
        <div class="card-head"><h2>Standings</h2><span class="meta">Regular season</span></div>
        ${renderStandings(d.standings)}
      </section>
      <section class="card">
        <div class="card-head"><h2>Recent Results</h2><span class="meta">Last ${d.results.length}</span></div>
        ${renderResults(d.results)}
      </section>
      <section class="card">
        <div class="card-head"><h2>Upcoming</h2><span class="meta">Next ${d.upcoming.length}</span></div>
        ${renderUpcoming(d.upcoming)}
      </section>
    </div>`;
  }

  function render() {
    main.innerHTML = Object.keys(payload.leagues)
      .map((key) => `<div class="region-panel${key === currentLeague ? " active" : ""}" data-panel="${key}">${renderPanel(key, payload.leagues[key])}</div>`)
      .join("");
    updatedEl.textContent = relativeTime(payload.generatedAt);
  }

  function setActive(league) {
    currentLeague = league;
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.league === league));
    document.querySelectorAll(".region-panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === league));
  }

  tabs.forEach((t) => t.addEventListener("click", () => setActive(t.dataset.league)));

  async function load(bust) {
    const url = bust ? `data.json?t=${Date.now()}` : "data.json";
    const res = await fetch(url, { cache: "no-store" });
    payload = await res.json();
    render();
    setActive(currentLeague);
  }

  refreshBtn.addEventListener("click", async () => {
    const previousGeneratedAt = payload && payload.generatedAt;
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing…";
    updatedEl.classList.remove("flash");
    try {
      await load(true);
      const changed = payload.generatedAt !== previousGeneratedAt;
      refreshBtn.textContent = changed ? "Updated ✓" : "Already current ✓";
      // eslint-disable-next-line no-unused-expressions
      updatedEl.offsetWidth; // restart the CSS animation
      updatedEl.classList.add("flash");
    } catch (err) {
      refreshBtn.textContent = "Refresh failed";
    } finally {
      setTimeout(() => {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "Refresh";
      }, 1400);
    }
  });

  load(false).then(() => {
    setInterval(() => updatedEl.textContent = relativeTime(payload.generatedAt), 5000);
    setInterval(() => load(true), 10 * 60 * 1000);
  }).catch((err) => {
    main.innerHTML = `<div class="empty-note" style="padding:60px 16px;">Couldn't load data: ${escapeHtml(err.message)}</div>`;
  });
})();
