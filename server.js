const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const RIOT_KEY = process.env.RIOT_API_KEY || '';
const PLATFORM = 'la1';
const MASS = 'americas';

const PLAYERS = [
  { name: 'SALCHIPRIME', tag: 'AURA', color: '#C89B3C', id: 'salchi' },
  { name: 'CHORIPRIME',  tag: 'AURA', color: '#7B6EE8', id: 'chori'  },
];

async function riotFetch(url) {
  const res = await fetch(url, { headers: { 'X-Riot-Token': RIOT_KEY } });
  if (!res.ok) throw new Error(`Riot API ${res.status}: ${await res.text()}`);
  return res.json();
}

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

app.get('/api/duo', async (req, res) => {
  try {
    if (cache && Date.now() - cacheTime < CACHE_TTL) {
      return res.json({ ...cache, cached: true, cacheAge: Math.round((Date.now() - cacheTime) / 1000) });
    }

    const results = [];

    for (const player of PLAYERS) {
      const account = await riotFetch(
        `https://${MASS}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(player.name)}/${encodeURIComponent(player.tag)}`
      );

      const summoner = await riotFetch(
        `https://${PLATFORM}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${account.puuid}`
      );

      const ranked = await riotFetch(
        `https://${PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-summoner/${summoner.id}`
      );

      const matchIds = await riotFetch(
        `https://${MASS}.api.riotgames.com/lol/match/v5/matches/by-puuid/${account.puuid}/ids?queue=420&type=ranked&count=20`
      );

      const matches = [];
      for (const mid of matchIds.slice(0, 15)) {
        try {
          const m = await riotFetch(`https://${MASS}.api.riotgames.com/lol/match/v5/matches/${mid}`);
          matches.push(m);
        } catch(e) {}
      }

      const solo = ranked.find(e => e.queueType === 'RANKED_SOLO_5x5') || null;

      // compute stats
      let kills=0, deaths=0, assists=0, dmg=0, cs=0, vision=0, kp=0, kpG=0, wins=0, losses=0;
      const champs = {};
      const history = [];

      for (const m of matches) {
        const p = m.info.participants.find(x => x.puuid === account.puuid);
        if (!p) continue;
        if (p.win) wins++; else losses++;
        kills += p.kills; deaths += p.deaths; assists += p.assists;
        dmg += p.totalDamageDealtToChampions;
        cs += (p.totalMinionsKilled||0) + (p.neutralMinionsKilled||0);
        vision += p.visionScore||0;
        const tk = m.info.participants.filter(x=>x.teamId===p.teamId).reduce((a,x)=>a+x.kills,0);
        if (tk>0) { kp += (p.kills+p.assists)/tk; kpG++; }
        if (!champs[p.championName]) champs[p.championName] = { g:0, w:0 };
        champs[p.championName].g++;
        if (p.win) champs[p.championName].w++;
        history.push({
          matchId: m.metadata.matchId,
          date: m.info.gameCreation,
          win: p.win,
          champion: p.championName,
          kills: p.kills, deaths: p.deaths, assists: p.assists,
          dmg: p.totalDamageDealtToChampions,
          duration: Math.round(m.info.gameDuration / 60),
          kp: tk > 0 ? Math.round((p.kills+p.assists)/tk*100) : 0,
        });
      }

      const g = wins + losses;
      results.push({
        id: player.id,
        name: player.name,
        tag: player.tag,
        color: player.color,
        puuid: account.puuid,
        level: summoner.summonerLevel,
        ranked: solo ? {
          tier: solo.tier, rank: solo.rank, lp: solo.leaguePoints,
          wins: solo.wins, losses: solo.losses,
          wr: Math.round(solo.wins/(solo.wins+solo.losses)*100),
        } : null,
        stats: {
          wins, losses, g,
          kda: deaths === 0 ? 99 : parseFloat(((kills+assists)/deaths).toFixed(2)),
          wr: g ? Math.round(wins/g*100) : 0,
          avgDmg: g ? Math.round(dmg/g) : 0,
          avgCs: g ? parseFloat((cs/g/28).toFixed(1)) : 0,
          avgVision: g ? Math.round(vision/g) : 0,
          kp: kpG ? Math.round(kp/kpG*100) : 0,
        },
        champs: Object.entries(champs).sort((a,b)=>b[1].g-a[1].g).slice(0,6).map(([name,d])=>({
          name, games: d.g, wins: d.w, wr: Math.round(d.w/d.g*100)
        })),
        history: history.sort((a,b)=>b.date-a.date),
        matchIds,
      });
    }

    // duo-specific stats
    const mids1 = new Set(results[0].matchIds);
    const mids2 = new Set(results[1].matchIds);
    const sharedIds = [...mids1].filter(id => mids2.has(id));

    let duoWins = 0;
    const duoHistory = [];
    for (const m of results[0].history) {
      if (!sharedIds.includes(m.matchId)) continue;
      if (m.win) duoWins++;
      const p2hist = results[1].history.find(h => h.matchId === m.matchId);
      duoHistory.push({ ...m, p2: p2hist });
    }

    const duo = {
      games: sharedIds.length,
      wins: duoWins,
      losses: sharedIds.length - duoWins,
      wr: sharedIds.length ? Math.round(duoWins/sharedIds.length*100) : 0,
      history: duoHistory.sort((a,b)=>b.date-a.date).slice(0,15),
    };

    cache = { players: results.map(r => { const {matchIds, ...rest} = r; return rest; }), duo, updatedAt: Date.now() };
    cacheTime = Date.now();

    res.json({ ...cache, cached: false });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Duo Prime API corriendo en :${PORT}`));
