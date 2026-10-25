// buildEloCache.js
const fs = require('fs');
const path = require('path');
const eloCache = require('./eloCache');

const MAX_AGE_DAYS = 30;
const CONCURRENCY  = 5;
const DELAY_MS     = 200;
const RETRIES      = 2;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- fetch одного профиля ----------
async function fetchElo(idOrUrl) {
  const url = String(idOrUrl).startsWith('http')
    ? idOrUrl
    : `https://gomafia.pro/stats/${idOrUrl}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru,en;q=0.9'
    }
  });

  if (res.status === 404) { const e = new Error('not_found'); e.code = 'EMPTY'; throw e; }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) { const e = new Error('no __NEXT_DATA__'); e.code = 'EMPTY'; throw e; }

  const data = JSON.parse(m[1]);
  const user = data?.props?.pageProps?.serverData?.user;
  if (!user || !user.login) { const e = new Error('no user'); e.code = 'EMPTY'; throw e; }

  return {
    id: user.id ? Number(user.id) : null,
    login: user.login,
    elo: user.elo != null ? Number(user.elo) : null
  };
}

async function fetchWithRetry(x) {
  let lastErr;
  for (let i = 0; i <= RETRIES; i++) {
    try { return await fetchElo(x); }
    catch (e) {
      if (e.code === 'EMPTY') throw e;           // 404/нет user — не ретраим
      lastErr = e;
      if (i < RETRIES) await sleep(800 * (i + 1));
    }
  }
  throw lastErr;
}

// ---------- пул воркеров ----------
async function pool(items, concurrency, worker, delay) {
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      try { await worker(items[idx], idx); }
      catch (e) { console.error('pool worker:', e.message); }
      await sleep(delay);
    }
  }));
}

// ---------- разбор --ids 1-10000,5,7000-7500 ----------
function parseIdSpec(spec) {
  const out = [];
  for (const part of spec.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = +m[1], b = +m[2];
      if (a > b) throw new Error(`неверный диапазон: ${p}`);
      for (let i = a; i <= b; i++) out.push(i);
    } else if (/^\d+$/.test(p)) {
      out.push(+p);
    } else {
      throw new Error(`неверный id: ${p}`);
    }
  }
  return out;
}

// ---------- собрать login+id из results/*.json ----------
function collectFromResults(dir) {
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (!Array.isArray(data)) continue;
      for (const t of data) {
        for (const g of (t.games || [])) {
          for (const c of (g.composition || [])) {
            if (!c || !c.name) continue;
            const key = c.name.toLowerCase();
            const id = c.id ?? c.user_id ?? null;
            if (!map.has(key)) map.set(key, { login: c.name, id });
            else if (id && !map.get(key).id) map.get(key).id = id;
          }
        }
        for (const s of (t.standings || [])) {
          const login = s.login || s.name;
          const id = s.id ?? s.user_id ?? null;
          if (!login) continue;
          const key = login.toLowerCase();
          if (!map.has(key)) map.set(key, { login, id });
          else if (id && !map.get(key).id) map.get(key).id = id;
        }
      }
    } catch {}
  }
  return map;
}

// ---------- main ----------
async function main() {
  const args = process.argv.slice(2);
  const opt  = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const flag = k => args.includes(k);

  const idsArg      = opt('--ids');
  const fromId      = opt('--from-id');
  const toId        = opt('--to-id');
  const urlsArg     = opt('--urls');
  const fromResults = opt('--from-results');
  const force       = flag('--force');
  const conc        = +opt('--concurrency') || CONCURRENCY;
  const delay       = +opt('--delay') || DELAY_MS;

  // 1. Загружаем существующую базу
  const cache  = eloCache.load();
  const before = Object.keys(cache.players).length;
  const knownById = eloCache.knownIds(cache);
  console.log(`📚 В базе уже: ${before} игроков`);
  if (before) console.log(`   файл: ${eloCache.DEFAULT_PATH} | обновлён: ${cache.updated || '—'}`);

  // 2. Собираем сырые задачи из всех источников
  const raw = [];

  if (idsArg) {
    parseIdSpec(idsArg).forEach(id => raw.push({ id }));
  }

  if (fromId || toId) {
    const a = +(fromId || 1);
    const b = +toId;
    if (!Number.isFinite(b) || b < a) throw new Error('нужны --from-id и --to-id (to >= from)');
    for (let i = a; i <= b; i++) raw.push({ id: i });
  }

  if (urlsArg) {
    urlsArg.split(',').map(s => s.trim()).filter(Boolean).forEach(u => {
      const m = u.match(/(\d+)(?:[/?#]|$)/);
      raw.push({ url: u, id: m ? +m[1] : null });
    });
  }

  if (fromResults) {
    if (!fs.existsSync(fromResults)) {
      throw new Error(`папка не найдена: ${fromResults}`);
    }
    const map = collectFromResults(fromResults);
    for (const { login, id } of map.values()) raw.push({ login, id });
  }

  if (raw.length === 0) {
    console.log('❌ Нечего парсить. Используй:');
    console.log('   --ids 1-10000,5,7000-7500');
    console.log('   --from-id 1 --to-id 10000');
    console.log('   --urls "https://gomafia.pro/stats/616,..."');
    console.log('   --from-results ./results');
    return;
  }

  // 3. MERGE-фильтр: убираем тех, кто уже есть и не устарел
  const seenId = new Set();
  const seenLogin = new Set();
  const tasks = [];
  let skippedById = 0;
  let skippedByLogin = 0;

  for (const t of raw) {
    // по id
    if (t.id != null) {
      const n = Number(t.id);
      if (!Number.isFinite(n)) continue;
      if (!force && knownById.has(n)) { skippedById++; continue; }
      if (seenId.has(n)) continue;
      seenId.add(n);
    }
    // по логину (если id отсутствует или нужно проверить свежесть)
    if (t.login) {
      const key = t.login.toLowerCase();
      if (!force && !eloCache.needsUpdate(cache, t.login, MAX_AGE_DAYS)) { skippedByLogin++; continue; }
      if (seenLogin.has(key)) continue;
      seenLogin.add(key);
    }
    // совсем пустой (url без id и без login) — оставляем как есть, fetch по url
    if (!t.id && !t.login && !t.url) continue;
    tasks.push(t);
  }

  console.log(`🎯 К парсингу: ${tasks.length} | пропущено по id: ${skippedById} | по login: ${skippedByLogin}`);
  console.log(`   concurrency=${conc} | delay=${delay}ms | force=${force}`);

  if (tasks.length === 0) {
    console.log('✅ Все запрошенные игроки уже есть в базе — ничего делать не нужно.');
    console.log('   (для перезаписи используй --force)');
    return;
  }

  // 4. Парсинг + инкрементальное долитие в базу
  const started = Date.now();
  let ok = 0, empty = 0, fail = 0;

  await pool(tasks, conc, async (t) => {
    try {
      const info = await fetchWithRetry(t.url || t.id);
      eloCache.set(cache, info);
      eloCache.saveAtomic(cache);   // merge: пишем всю базу с долитой записью
      ok++;
    } catch (e) {
      if (e.code === 'EMPTY') {
        empty++;
      } else {
        fail++;
        if (fail <= 10) console.log(`  ✖ id=${t.id ?? '?'}: ${e.message}`);
      }
    }
    const done = ok + empty + fail;
    if (done % 100 === 0) {
      const sec = (Date.now() - started) / 1000;
      const rate = done / sec;
      const eta = rate > 0 ? Math.round((tasks.length - done) / rate) : 0;
      console.log(
        `📈 ${done}/${tasks.length} | ok=${ok} empty=${empty} fail=${fail} | ` +
        `${rate.toFixed(1)}/с | ETA ~${Math.round(eta / 60)} мин | в базе: ${Object.keys(cache.players).length}`
      );
    }
  }, delay);

  // 5. Итог
  const after = Object.keys(cache.players).length;
  const sec = (Date.now() - started) / 1000;
  console.log(`\n✅ Готово за ${Math.round(sec)}с (${(sec / 60).toFixed(1)} мин)`);
  console.log(`   ok=${ok} | empty=${empty} | fail=${fail} | пропущено_сразу=${skippedById + skippedByLogin}`);
  console.log(`   📚 Было в базе: ${before}, стало: ${after} (+${after - before})`);
  console.log(`   💾 Файл: ${eloCache.DEFAULT_PATH}`);
}

main().catch(e => {
  console.error('❌ Ошибка:', e);
  process.exit(1);
});