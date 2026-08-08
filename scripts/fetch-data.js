// Fetches LCK/LPL/LEC standings, results, upcoming schedule from the lolesports.com
// live API, plus best-effort Player of the Game data from Leaguepedia's Cargo API.
// Writes docs/data.json, which the static site fetches at runtime.

const fs = require("fs");
const path = require("path");

const ESPORTS_API_KEY = "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z";
const ESPORTS_BASE = "https://esports-api.lolesports.com/persisted/gw";
const LEAGUEPEDIA_BASE = "https://lol.fandom.com/api.php";

const LEAGUES = [
  { key: "LEC", id: "98767991302996019", pogTournament: "LEC 2026 Split 3" },
  { key: "LCK", id: "98767991310872058", pogTournament: "LCK 2026 Split 3" },
  { key: "LPL", id: "98767991314006698", pogTournament: "LPL 2026 Split 3" },
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

async function findCurrentTournamentName(league) {
  const today = new Date().toISOString().slice(0, 10);
  const where = encodeURIComponent(
    `Tournaments.League="${league.key}" AND Tournaments.DateStart<="${today}" AND Tournaments.Date>="${today}"`
  );
  const url = `${LEAGUEPEDIA_BASE}?action=cargoquery&tables=Tournaments&fields=Tournaments.Name,Tournaments.OverviewPage&where=${where}&order_by=Tournaments.DateStart%20DESC&limit=1&format=json`;
  const res = await fetch(url, {
    headers: { "User-Agent": "RiftReportBot/1.0 (contact:sebbifodor12@gmail.com)" },
  });
  console.log(`[pog] ${league.key} tournament lookup status=${res.status}`);
  if (!res.ok) return null;
  const json = await res.json();
  if (json.error) {
    console.log(`[pog] ${league.key} tournament lookup error:`, JSON.stringify(json.error));
    return null;
  }
  const row = json.cargoquery && json.cargoquery[0];
  if (!row) {
    console.log(`[pog] ${league.key} no active tournament found in Leaguepedia Tournaments table`);
    return null;
  }
  console.log(`[pog] ${league.key} resolved tournament name: ${row.title.Name}`);
  return row.title.Name;
}

async function fetchPog(league) {
  try {
    const tournamentName = await findCurrentTournamentName(league);
    if (!tournamentName) return [];

    const where = encodeURIComponent(
      `ScoreboardPlayers.Tournament="${tournamentName}" AND ScoreboardPlayers.PlayerWin="Yes"`
    );
    const url = `${LEAGUEPEDIA_BASE}?action=cargoquery&tables=ScoreboardPlayers&fields=ScoreboardPlayers.Link,ScoreboardPlayers.Team,ScoreboardPlayers.Champion,ScoreboardPlayers.DateTime_UTC&where=${where}&order_by=ScoreboardPlayers.DateTime_UTC%20DESC&limit=5&format=json`;
    const res = await fetch(url, {
      headers: { "User-Agent": "RiftReportBot/1.0 (contact:sebbifodor12@gmail.com)" },
    });
    console.log(`[pog] ${league.key} scoreboard query status=${res.status}`);
    if (!res.ok) return [];
    const json = await res.json();
    if (json.error) {
      console.log(`[pog] ${league.key} scoreboard query error:`, JSON.stringify(json.error));
      return [];
    }
    if (!json.cargoquery) return [];
    console.log(`[pog] ${league.key} got ${json.cargoquery.length} POG rows`);
    return json.cargoquery.map((row) => ({
      player: row.title.Link,
      team: row.title.Team,
      champion: row.title.Champion,
      date: row.title["DateTime UTC"],
    }));
  } catch (err) {
    console.error(`Leaguepedia POG fetch failed for ${league.key}:`, err.message);
    return [];
  }
}

async function main() {
  const data = {};
  const pog = {};

  for (const league of LEAGUES) {
    console.log(`Fetching ${league.key}...`);
    data[league.key] = await fetchLeagueData(league);
    pog[league.key] = await fetchPog(league);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    leagues: data,
    pog,
  };

  const outPath = path.join(__dirname, "..", "docs", "data.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
