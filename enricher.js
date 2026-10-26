// enricher.js
const eloCache = require('./eloCache');

let _emptyWarned = false;

function getCacheSafe() {
  try {
    const c = eloCache.load();
    if (!_emptyWarned && Object.keys(c.players || {}).length === 0) {
      console.warn('   ℹ️ elo-cache.json пуст или не найден — ELO не обогащён. Запусти buildEloCache.js.');
      _emptyWarned = true;
    }
    return c;
  } catch (e) {
    console.warn('⚠️ Не удалось загрузить elo-cache:', e.message);
    return null;
  }
}

function enrichTournament(t, cache) {
  if (!t || !Array.isArray(t.games)) return 0;
  let gamesTouched = 0;
  for (const g of t.games) {
    if (!Array.isArray(g.composition)) continue;
    let eloSum = 0, eloCount = 0;
    for (const p of g.composition) {
      if (!p || !p.name) continue;
      const cached = eloCache.get(cache, p.name);
      if (cached && cached.elo != null) {
        p.elo = cached.elo;
        eloSum += cached.elo;
        eloCount++;
      }
    }
    g.averageElo = eloCount > 0 ? Math.round(eloSum / eloCount) : null;
    gamesTouched++;
  }
  return gamesTouched;
}

function enrichResults(results, cache) {
  if (!Array.isArray(results)) return { games: 0, players: 0 };
  const usedCache = cache || getCacheSafe();
  if (!usedCache) return { games: 0, players: 0 };
  let games = 0;
  for (const t of results) games += enrichTournament(t, usedCache);
  const players = Object.keys(usedCache.players || {}).length;
  return { games, players };
}

module.exports = { enrichResults, enrichTournament, getCacheSafe };