// Fetches LCK/LPL/LEC standings, results, and upcoming schedule from the
// lolesports.com live API and writes docs/data.json, which the static site
// fetches at runtime.
//
// Standings are computed from the schedule feed rather than the API's own
// getStandings endpoint, because that endpoint's "record" field only covers
// whatever sub-stage (Groups/Play-Ins/etc.) is currently active and doesn't
// match what leagues actually display as the regular-season table. Instead
// we aggregate every completed "Week N" match since the most recent "Week 1"
// marker. This generalizes correctly across leagues with different season
// shapes: LEC resets to Week 1 every split (so this naturally scopes to the
// current split only), while LCK/LPL continue week numbering across Split 2
// into Split 3 without resetting (so this naturally spans both splits,
// matching what their live standings show -- verified against a real
// example: Dplus KIA's Split 2+3 combined record is 13-8 matches / 28-21
// games, which is exactly what this computation produces).
//
// Note: Player of the Game data lives only on Leaguepedia, whose Cargo API
// blocks cloud/datacenter IP ranges outright (confirmed from both a sandboxed
// dev environment and GitHub Actions runners) -- not something retries fix,
// so it's intentionally left out here.

const fs = require("fs");
const path = require("path");

const ESPORTS_API_KEY = "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z";
const ESPORTS_BASE = "https://esports-api.lolesports.com/persisted/gw";
const REGULAR_SEASON_WEEK = /^Week (\d+)$/;
const HISTORY_PAGES = 4; // pages of "older" schedule to fetch beyond the default window

const LEAGUES = [
  { key: "LEC", id: "98767991302996019" },
  { key: "LCK", id: "98767991310872058" },
  { key: "LPL", id: "98767991314006698" },
];

async function esportsFetch(pathAndQuery) {
  const res = await fetch(`${ESPORTS_BASE}${pathAndQuery}`, {
    headers: { "x-api-key": ESPORTS_API_KEY },
  });
  if (!res.ok) throw new Error(`esports API ${pathAndQuery} -> ${res.status}`);
  return res.json();
}

async function fetchFullSchedule(leagueId) {
  const first = await esportsFetch(`/getSchedule?hl=en-US&leagueId=${leagueId}`);
  let events = first.data.schedule.events;
  let olderToken = first.data.schedule.pages.older;

  for (let i = 0; i < HISTORY_PAGES && olderToken; i++) {
    const page = await esportsFetch(
      `/getSchedule?hl=en-US&leagueId=${leagueId}&pageToken=${encodeURIComponent(olderToken)}`
    );
    events = page.data.schedule.events.concat(events);
    olderToken = page.data.schedule.pages.older;
  }
  return events;
}

function extractResults(events) {
  const completed = events.filter((e) => e.state === "completed").slice(-8);
  return completed.map((e) => ({
    startTime: e.startTime,
    blockName: e.blockName,
    team1: e.match.teams[0].name,
    code1: e.match.teams[0].code,
    image1: e.match.teams[0].image,
    wins1: e.match.teams[0].result?.gameWins ?? 0,
    team2: e.match.teams[1].name,
    code2: e.match.teams[1].code,
    image2: e.match.teams[1].image,
    wins2: e.match.teams[1].result?.gameWins ?? 0,
  }));
}

function extractUpcoming(events) {
  const upcoming = events.filter((e) => e.state === "unstarted").slice(0, 8);
  return upcoming.map((e) => ({
    startTime: e.startTime,
    blockName: e.blockName,
    team1: e.match.teams[0].name,
    code1: e.match.teams[0].code,
    image1: e.match.teams[0].image,
    team2: e.match.teams[1].name,
    code2: e.match.teams[1].code,
    image2: e.match.teams[1].image,
    bestOf: e.match.strategy?.count ?? 3,
  }));
}

// Computes the current regular-season standings by summing every completed
// "Week N" match since the most recent "Week 1" marker (see file header).
function computeStandings(events) {
  const weekEvents = events
    .filter((e) => e.state === "completed" && REGULAR_SEASON_WEEK.test(e.blockName || ""))
    .sort((a, b) => (a.startTime < b.startTime ? -1 : 1));

  let windowStartIdx = 0;
  for (let i = weekEvents.length - 1; i >= 0; i--) {
    if (REGULAR_SEASON_WEEK.exec(weekEvents[i].blockName)[1] === "1") {
      windowStartIdx = i;
      break;
    }
  }
  const currentWindow = weekEvents.slice(windowStartIdx);

  const teams = new Map(); // code -> { name, code, image, matchWins, matchLosses, gameWins, gameLosses }
  function getTeam(t) {
    if (!teams.has(t.code)) {
      teams.set(t.code, {
        name: t.name,
        code: t.code,
        image: t.image,
        matchWins: 0,
        matchLosses: 0,
        gameWins: 0,
        gameLosses: 0,
      });
    }
    return teams.get(t.code);
  }

  for (const e of currentWindow) {
    const [a, b] = e.match.teams;
    const aWins = a.result?.gameWins ?? 0;
    const bWins = b.result?.gameWins ?? 0;
    const teamA = getTeam(a);
    const teamB = getTeam(b);
    teamA.gameWins += aWins;
    teamA.gameLosses += bWins;
    teamB.gameWins += bWins;
    teamB.gameLosses += aWins;
    if (aWins > bWins) {
      teamA.matchWins += 1;
      teamB.matchLosses += 1;
    } else {
      teamB.matchWins += 1;
      teamA.matchLosses += 1;
    }
  }

  const rows = Array.from(teams.values());
  const sortKey = (t) => {
    const matchTotal = t.matchWins + t.matchLosses;
    const matchPct = matchTotal ? t.matchWins / matchTotal : 0;
    const gameTotal = t.gameWins + t.gameLosses;
    const gamePct = gameTotal ? t.gameWins / gameTotal : 0;
    return [matchPct, t.matchWins, gamePct];
  };
  rows.sort((x, y) => {
    const kx = sortKey(x);
    const ky = sortKey(y);
    for (let i = 0; i < kx.length; i++) {
      if (kx[i] !== ky[i]) return ky[i] - kx[i];
    }
    return x.name.localeCompare(y.name);
  });

  return rows.map((t, i) => {
    let rank = i + 1;
    if (i > 0) {
      const prevKey = JSON.stringify(sortKey(rows[i - 1]));
      if (JSON.stringify(sortKey(t)) === prevKey) rank = rows[i - 1]._rank;
    }
    t._rank = rank;
    return {
      rank,
      name: t.name,
      code: t.code,
      image: t.image,
      matchWins: t.matchWins,
      matchLosses: t.matchLosses,
      gameWins: t.gameWins,
      gameLosses: t.gameLosses,
    };
  });
}

async function fetchLeagueData(league) {
  const events = await fetchFullSchedule(league.id);
  return {
    standings: computeStandings(events),
    results: extractResults(events),
    upcoming: extractUpcoming(events),
  };
}

async function main() {
  const data = {};

  for (const league of LEAGUES) {
    console.log(`Fetching ${league.key}...`);
    data[league.key] = await fetchLeagueData(league);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    leagues: data,
  };

  const outPath = path.join(__dirname, "..", "docs", "data.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
