const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const RIOT_KEY = process.env.RIOT_API_KEY || '';
const PLATFORM = 'la2';
const MASS = 'americas';

const PLAYERS = [
  { name: 'SALCHIPRIME', tag: 'AURA', color: '#C89B3C', id: 'salchi' },
  { name: 'CHORIPRIME',  tag: 'AURA', color: '#7B6EE8', id: 'chori'  },
];

// ── Data Dragon helpers ──────────────────────────────────────────
let ddVersion = null;
async function getDDVersion() {
  if (ddVersion) return ddVersion;
  try {
    const res = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
    const arr = await res.json();
    ddVersion = arr[0];
  } catch (e) {
    ddVersion = '15.1.1'; // fallback
  }
  return ddVersion;
}

function champIconUrl(championName, version) {
  // Handle special cases where API name differs from DD name
  const nameMap = {
    'FiddleSticks': 'Fiddlesticks',
    'Wukong': 'MonkeyKing',
    "Bel'Veth": 'Belveth',
    "Cho'Gath": 'Chogath',
    "Kha'Zix": 'Khazix',
    "Kog'Maw": 'KogMaw',
    "Rek'Sai": 'RekSai',
    "Vel'Koz": 'Velkoz',
    "K'Sante": 'KSante',
    "Nunu & Willump": 'Nunu',
    "Renata Glasc": 'Renata',
    "Tahm Kench": 'TahmKench',
    "Twisted Fate": 'TwistedFate',
    "Master Yi": 'MasterYi',
    "Miss Fortune": 'MissFortune',
    "Dr. Mundo": 'DrMundo',
    "Aurelion Sol": 'AurelionSol',
    "Jarvan IV": 'JarvanIV',
    "Lee Sin": 'LeeSin',
    "Xin Zhao": 'XinZhao',
    "Aatrox": 'Aatrox',
  };
  const ddName = nameMap[championName] || championName;
  return `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${ddName}.png`;
}

function rankEmblemUrl(tier) {
  if (!tier) return null;
  const t = tier.toLowerCase();
  return `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-${t}.png`;
}

// ── Riot fetch ───────────────────────────────────────────────────
async function riotFetch(url) {
  console.log('Fetching:', url);
  const res = await fetch(url, { headers: { 'X-Riot-Token': RIOT_KEY } });
  if (!res.ok) {
    const txt = await res.text();
    console.log('Error en:', url, res.status, txt);
    throw new Error('Riot API ' + res.status + ': ' + txt);
  }
  return res.json();
}

// ── Cache ────────────────────────────────────────────────────────
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

// ── Streak helper ────────────────────────────────────────────────
function calcStreak(history) {
  if (!history.length) return { type: null, count: 0 };
  const sorted = [...history].sort((a, b) => b.date - a.date);
  const type = sorted[0].win ? 'win' : 'loss';
  let count = 0;
  for (const m of sorted) {
    if (m.win === (type === 'win')) count++;
    else break;
  }
  return { type, count };
}

// ── Main endpoint ────────────────────────────────────────────────
app.get('/api/duo', async (req, res) => {
  try {
    if (cache && Date.now() - cacheTime < CACHE_TTL) {
      return res.json({ ...cache, cached: true, cacheAge: Math.round((Date.now() - cacheTime) / 1000) });
    }

    const version = await getDDVersion();
    const results = [];

    for (const player of PLAYERS) {
      const account = await riotFetch(
        `https://${MASS}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(player.name)}/${encodeURIComponent(player.tag)}`
      );

      // Summoner data (for level)
      let level = 0;
      try {
        const summoner = await riotFetch(
          `https://${PLATFORM}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${account.puuid}`
        );
        level = summoner.summonerLevel || 0;
      } catch (e) {
        console.log('Error fetching summoner level:', e.message);
      }

      const ranked = await riotFetch(
        `https://${PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-puuid/${account.puuid}`
      );

      const matchIds = await riotFetch(
        `https://${MASS}.api.riotgames.com/lol/match/v5/matches/by-puuid/${account.puuid}/ids?queue=420&type=ranked&count=20`
      );

      const matches = [];
      for (const mid of matchIds.slice(0, 15)) {
        try {
          const m = await riotFetch(`https://${MASS}.api.riotgames.com/lol/match/v5/matches/${mid}`);
          matches.push(m);
        } catch (e) {
          console.log('Error cargando partida', mid, e.message);
        }
      }

      const solo = ranked.find(e => e.queueType === 'RANKED_SOLO_5x5') || null;
      const flex = ranked.find(e => e.queueType === 'RANKED_FLEX_SR') || null;

      let kills = 0, deaths = 0, assists = 0, dmg = 0, dmgTaken = 0, dmgObj = 0;
      let cs = 0, vision = 0, kp = 0, kpG = 0, wins = 0, losses = 0;
      let firstBloods = 0, pentakills = 0, quadrakills = 0, tripleKills = 0, doubleKills = 0;
      let totalGold = 0;
      const champs = {};
      const roles = {};
      const history = [];
      let bestGame = null, bestGameScore = -1;

      for (const m of matches) {
        const p = m.info.participants.find(x => x.puuid === account.puuid);
        if (!p) continue;

        const win = p.win;
        if (win) wins++; else losses++;

        kills += p.kills;
        deaths += p.deaths;
        assists += p.assists;
        dmg += p.totalDamageDealtToChampions;
        dmgTaken += p.totalDamageTaken || 0;
        dmgObj += p.damageDealtToObjectives || 0;
        cs += (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0);
        vision += p.visionScore || 0;
        totalGold += p.goldEarned || 0;
        if (p.firstBloodKill) firstBloods++;
        if (p.pentaKills > 0) pentakills += p.pentaKills;
        if (p.quadraKills > 0) quadrakills += p.quadraKills;
        if (p.tripleKills > 0) tripleKills += p.tripleKills;
        if (p.doubleKills > 0) doubleKills += p.doubleKills;

        const tk = m.info.participants.filter(x => x.teamId === p.teamId).reduce((a, x) => a + x.kills, 0);
        if (tk > 0) { kp += (p.kills + p.assists) / tk; kpG++; }

        // Champion stats
        if (!champs[p.championName]) champs[p.championName] = { g: 0, w: 0, kills: 0, deaths: 0, assists: 0, dmg: 0 };
        champs[p.championName].g++;
        champs[p.championName].kills += p.kills;
        champs[p.championName].deaths += p.deaths;
        champs[p.championName].assists += p.assists;
        champs[p.championName].dmg += p.totalDamageDealtToChampions;
        if (win) champs[p.championName].w++;

        // Role tracking
        const pos = p.teamPosition || p.individualPosition || 'UNKNOWN';
        if (pos && pos !== 'UNKNOWN') {
          roles[pos] = (roles[pos] || 0) + 1;
        }

        // Items array
        const items = [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6].filter(i => i > 0);

        // Best game score: KDA * dmg / 1000 * (win ? 1.5 : 1)
        const gameScore = ((p.kills + p.assists) / Math.max(p.deaths, 1)) * (p.totalDamageDealtToChampions / 1000) * (win ? 1.5 : 1);
        if (gameScore > bestGameScore) {
          bestGameScore = gameScore;
          bestGame = {
            champion: p.championName,
            championIcon: champIconUrl(p.championName, version),
            kills: p.kills, deaths: p.deaths, assists: p.assists,
            dmg: p.totalDamageDealtToChampions,
            win,
            matchId: m.metadata.matchId,
            duration: Math.round(m.info.gameDuration / 60),
            date: m.info.gameCreation,
          };
        }

        history.push({
          matchId: m.metadata.matchId,
          date: m.info.gameCreation,
          win,
          champion: p.championName,
          championIcon: champIconUrl(p.championName, version),
          kills: p.kills, deaths: p.deaths, assists: p.assists,
          dmg: p.totalDamageDealtToChampions,
          dmgTaken: p.totalDamageTaken || 0,
          duration: Math.round(m.info.gameDuration / 60),
          durationSecs: m.info.gameDuration,
          kp: tk > 0 ? Math.round((p.kills + p.assists) / tk * 100) : 0,
          cs: (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0),
          csPerMin: m.info.gameDuration > 0 ? parseFloat((((p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0)) / (m.info.gameDuration / 60)).toFixed(1)) : 0,
          vision: p.visionScore || 0,
          gold: p.goldEarned || 0,
          position: p.teamPosition || p.individualPosition || null,
          pentaKills: p.pentaKills || 0,
          quadraKills: p.quadraKills || 0,
          tripleKills: p.tripleKills || 0,
          doubleKills: p.doubleKills || 0,
          firstBlood: !!p.firstBloodKill,
          items,
        });
      }

      const g = wins + losses;
      const streak = calcStreak(history);

      // Top position
      const mainRole = Object.entries(roles).sort((a, b) => b[1] - a[1])[0];

      results.push({
        id: player.id,
        name: player.name,
        tag: player.tag,
        color: player.color,
        puuid: account.puuid,
        level,
        ranked: solo ? {
          tier: solo.tier,
          rank: solo.rank,
          lp: solo.leaguePoints,
          wins: solo.wins,
          losses: solo.losses,
          wr: Math.round(solo.wins / (solo.wins + solo.losses) * 100),
          emblemUrl: rankEmblemUrl(solo.tier),
        } : null,
        flex: flex ? {
          tier: flex.tier,
          rank: flex.rank,
          lp: flex.leaguePoints,
          wins: flex.wins,
          losses: flex.losses,
          wr: Math.round(flex.wins / (flex.wins + flex.losses) * 100),
          emblemUrl: rankEmblemUrl(flex.tier),
        } : null,
        stats: {
          wins, losses, g,
          kda: deaths === 0 ? 99 : parseFloat(((kills + assists) / deaths).toFixed(2)),
          wr: g ? Math.round(wins / g * 100) : 0,
          avgDmg: g ? Math.round(dmg / g) : 0,
          avgDmgTaken: g ? Math.round(dmgTaken / g) : 0,
          avgDmgObj: g ? Math.round(dmgObj / g) : 0,
          avgCs: g ? parseFloat((cs / g / 28).toFixed(1)) : 0,
          avgVision: g ? Math.round(vision / g) : 0,
          avgGold: g ? Math.round(totalGold / g) : 0,
          kp: kpG ? Math.round(kp / kpG * 100) : 0,
          firstBloods, pentakills, quadrakills, tripleKills, doubleKills,
        },
        streak,
        mainRole: mainRole ? { role: mainRole[0], games: mainRole[1] } : null,
        roles,
        champs: Object.entries(champs)
          .sort((a, b) => b[1].g - a[1].g)
          .slice(0, 8)
          .map(([name, d]) => ({
            name,
            championIcon: champIconUrl(name, version),
            games: d.g,
            wins: d.w,
            wr: Math.round(d.w / d.g * 100),
            kda: d.deaths === 0 ? 99 : parseFloat(((d.kills + d.assists) / d.deaths).toFixed(2)),
            avgDmg: Math.round(d.dmg / d.g),
          })),
        bestGame,
        history: history.sort((a, b) => b.date - a.date),
        matchIds,
      });
    }

    // ── Duo shared games ─────────────────────────────────────────
    const mids1 = new Set(results[0].matchIds);
    const mids2 = new Set(results[1].matchIds);
    const sharedIds = [...mids1].filter(id => mids2.has(id));

    let duoWins = 0;
    const duoHistory = [];
    for (const m of results[0].history) {
      if (!sharedIds.includes(m.matchId)) continue;
      if (m.win) duoWins++;
      const p2hist = results[1].history.find(h => h.matchId === m.matchId);
      duoHistory.push({ ...m, p2: p2hist || null });
    }

    const duoStreak = calcStreak(duoHistory);

    // Combined duo stats
    const p1 = results[0], p2 = results[1];
    let duoAvgDmg = 0, duoAvgKda = 0;
    const duoGames = duoHistory.length;
    if (duoGames > 0) {
      duoAvgDmg = Math.round(duoHistory.reduce((a, m) => a + m.dmg + (m.p2 ? m.p2.dmg : 0), 0) / duoGames);
      const combinedKills = duoHistory.reduce((a, m) => a + m.kills + (m.p2 ? m.p2.kills : 0), 0);
      const combinedDeaths = duoHistory.reduce((a, m) => a + m.deaths + (m.p2 ? m.p2.deaths : 0), 0);
      const combinedAssists = duoHistory.reduce((a, m) => a + m.assists + (m.p2 ? m.p2.assists : 0), 0);
      duoAvgKda = combinedDeaths === 0 ? 99 : parseFloat(((combinedKills + combinedAssists) / combinedDeaths).toFixed(2));
    }

    const duo = {
      games: sharedIds.length,
      wins: duoWins,
      losses: sharedIds.length - duoWins,
      wr: sharedIds.length ? Math.round(duoWins / sharedIds.length * 100) : 0,
      streak: duoStreak,
      avgCombinedDmg: duoAvgDmg,
      avgCombinedKda: duoAvgKda,
      history: duoHistory.sort((a, b) => b.date - a.date).slice(0, 15),
    };

    cache = {
      players: results.map(r => { const { matchIds, ...rest } = r; return rest; }),
      duo,
      version,
      updatedAt: Date.now(),
    };
    cacheTime = Date.now();

    res.json({ ...cache, cached: false });

  } catch (e) {
    console.log('Error general:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (_, res) => res.json({ ok: true, key: RIOT_KEY ? 'presente' : 'FALTA' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('Duo Prime API corriendo en :' + PORT));
