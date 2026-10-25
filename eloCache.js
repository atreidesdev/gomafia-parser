// eloCache.js
const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, 'elo-cache.json');

function load(file = DEFAULT_PATH) {
  if (!fs.existsSync(file)) return { updated: null, players: {} };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!j || typeof j !== 'object') return { updated: null, players: {} };
    if (!j.players || typeof j.players !== 'object') j.players = {};
    return j;
  } catch (e) {
    try { fs.copyFileSync(file, `${file}.broken.${Date.now()}`); } catch {}
    console.warn('⚠️ elo-cache.json битый, создаю пустой:', e.message);
    return { updated: null, players: {} };
  }
}

function saveAtomic(cache, file = DEFAULT_PATH) {
  cache.updated = new Date().toISOString();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

const norm = s => (s || '').toLowerCase().trim();

function get(cache, login) {
  return cache.players[norm(login)] || null;
}

function getElo(cache, login) {
  const p = cache.players[norm(login)];
  return p && p.elo != null ? p.elo : null;
}

function getById(cache, id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  for (const p of Object.values(cache.players)) if (p.id === n) return p;
  return null;
}

function set(cache, { id, login, elo }) {
  const key = norm(login);
  if (!key) return null;
  const prev = cache.players[key] || {};
  cache.players[key] = {
    id: id != null ? Number(id) : (prev.id != null ? prev.id : null),
    login: login || prev.login || key,
    elo: elo != null ? Number(elo) : (prev.elo != null ? prev.elo : null),
    fetchedAt: new Date().toISOString()
  };
  return cache.players[key];
}

function needsUpdate(cache, login, maxAgeDays = 30) {
  const p = cache.players[norm(login)];
  if (!p || p.elo == null || !p.fetchedAt) return true;
  return (Date.now() - new Date(p.fetchedAt).getTime()) > maxAgeDays * 86400000;
}

function knownIds(cache) {
  const s = new Set();
  for (const p of Object.values(cache.players)) {
    if (p.id != null) s.add(Number(p.id));
  }
  return s;
}

module.exports = {
  DEFAULT_PATH,
  load,
  save: saveAtomic,
  saveAtomic,
  get,
  getElo,
  getById,
  set,
  needsUpdate,
  knownIds
};