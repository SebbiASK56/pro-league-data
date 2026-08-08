// Fetches LCK/LPL/LEC standings, results, and upcoming schedule from the
// lolesports.com live API and writes docs/data.json, which the static site
// fetches at runtime.
//
// Note: Player of the Game data lives only on Leaguepedia, whose Cargo API
// blocks cloud/datacenter IP ranges outright (confirmed from both a sandboxed
// dev environment and GitHub Actions runners) -- not something retries fix,
// so it's intentionally left out here.

const fs = require("fs");
const path = require("path");

const ESPORTS_API_KEY = "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z";
const ESPORTS_BASE = "https://esports-api.lolesports.com/persisted/gw";

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

function extractStandings(standingsResp) {
  const stages = standingsResp.data.standings[0]?.stages || [];
  const stage = stages.find((s) => s.slug === "regular_season") || stages[0];
  if (!stage) return [];
  const rows = [];
  for (const rank of stage.sections[0].rankings) {
    for (const team of rank.teams) {
      rows.push({
        rank: rank.ordinal,
        name: team.name,
        code: team.code,
        image: team.image,
        wins: team.record?.wins ?? 0,
        losses: team.record?.losses ?? 0,
      });
    }
  }
  return rows;
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

async function fetchLeagueData(league) {
  const tournaments = await esportsFetch(
    `/getTournamentsForLeague?hl=en-US&leagueId=${league.id}`
  );
  const today = new Date().toISOString().slice(0, 10);
  const current = tournaments.data.leagues[0].tournaments
    .filter((t) => t.startDate <= today)
    .sort((a, b) => (a.startDate < b.startDate ? 1 : -1))[0];

  const [standingsResp, scheduleResp] = await Promise.all([
    esportsFetch(`/getStandings?hl=en-US&tournamentId=${current.id}`),
    esportsFetch(`/getSchedule?hl=en-US&leagueId=${league.id}`),
  ]);

  return {
    tournamentSlug: current.slug,
    standings: extractStandings(standingsResp),
    results: extractResults(scheduleResp.data.schedule.events),
    upcoming: extractUpcoming(scheduleResp.data.schedule.events),
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
