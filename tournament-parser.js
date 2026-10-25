// tournament-parser.js
// Парсер турниров gomafia.pro — сохраняет таблицу + все игры/столы/игроков в один JSON
// Запуск:
//   node tournament-parser.js 2659 2760 https://gomafia.pro/tournament/3299
//   node tournament-parser.js --file tournaments.txt
//   node tournament-parser.js   (интерактивный ввод)
//   node tournament-parser.js --force         — перезаписать существующие в базе
//   node tournament-parser.js --enrich-only   — только обогатить существующую базу ELO (без скрейпа)
//
// ELO игроков берётся из elo-cache.json (рядом с парсером). Для наполнения кэша:
//   node buildEloCache.js --from-results ./results
//   node buildEloCache.js --ids 1-100000
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DB_FILE = process.env.TOURNAMENTS_DB || path.join(__dirname, 'tournaments-db.json');

const ROLE_NAMES = { red: 'Мирный', sheriff: 'Шериф', mafia: 'Маф', don: 'Дон' };

// ============ ELO CACHE ============
let eloCacheModule = null;
try { eloCacheModule = require('./eloCache'); } catch { /* optional */ }

let GLOBAL_ELO_CACHE = null;
const GLOBAL_ELO_STATS = { total: 0, found: 0, missing: new Set() };

function loadGlobalEloCache() {
    if (!eloCacheModule) {
        console.warn('⚠️ eloCache.js не найден — ELO не будет обогащено');
        return;
    }
    try {
        const p = process.env.ELO_CACHE || eloCacheModule.DEFAULT_PATH;
        GLOBAL_ELO_CACHE = eloCacheModule.load(p);
        const n = Object.keys(GLOBAL_ELO_CACHE.players).length;
        console.log(`📚 elo-cache.json: ${n} игроков (${p})`);
    } catch (e) {
        console.warn('⚠️ Не удалось загрузить elo-cache.json:', e.message);
    }
}

function enrichPlayersWithElo(players) {
    if (!GLOBAL_ELO_CACHE || !eloCacheModule) return null;
    let eloSum = 0, eloCount = 0;
    players.forEach(p => {
        if (!p.login) return;
        const cached = eloCacheModule.get(GLOBAL_ELO_CACHE, p.login);
        if (cached && cached.elo != null) {
            p.elo = cached.elo;
            eloSum += cached.elo;
            eloCount++;
            GLOBAL_ELO_STATS.found++;
        } else {
            p.elo = null;
            GLOBAL_ELO_STATS.missing.add(p.login.toLowerCase());
        }
        GLOBAL_ELO_STATS.total++;
    });
    return eloCount > 0 ? Math.round(eloSum / eloCount) : null;
}

// ============ UTILS ============
function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(String(v).replace(',', '.'));
    return isNaN(n) ? null : n;
}
function int(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = parseInt(String(v), 10);
    return isNaN(n) ? null : n;
}
function extractTournamentId(url) {
    if (!url) return null;
    const m = String(url).match(/\/tournament\/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}
function normalizeUrl(input) {
    const s = String(input).trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return `https://gomafia.pro/tournament/${s}`;
    if (/^https?:\/\//.test(s)) return s;
    if (s.startsWith('/tournament/')) return `https://gomafia.pro${s}`;
    return s;
}
function getJudgeFromJson(table) {
    const keys = ['judge', 'referee', 'sudya', 'table_judge', 'tableJudge',
        'judge_login', 'sudya_login', 'referee_login', 'judge_name'];
    for (const k of keys) {
        const v = table[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (v && typeof v === 'object') {
            if (typeof v.login === 'string' && v.login) return v.login;
            if (typeof v.name === 'string' && v.name) return v.name;
        }
    }
    return null;
}
function mapStandingRow(r) {
    return {
        login: r.login,
        place: int(r.place),
        sum: num(r.sum),
        sum_extra: num(r.sum_extra),
        plus: num(r.extra_point),
        minus: num(r.fine),
        first_kill_point: num(r.first_kill_point),
        compensation_point: num(r.compensation_point),
        wins: int(r.win),
        wins_as_don: int(r.win_as_don),
        wins_as_sheriff: int(r.win_as_sheriff),
        first_kill: int(r.first_kill),
        gg: num(r.global_game),
        elo_delta: num(r.elo_delta),
        is_paid: r.is_paid === '1' || r.is_paid === 1
    };
}

async function clickTabByText(page, text) {
    return page.evaluate((t) => {
        const tabs = document.querySelectorAll('.Tabs_tabs-tab__ognto');
        for (const tab of tabs) {
            if (tab.textContent.trim() === t) { tab.click(); return true; }
        }
        return false;
    }, text);
}

async function extractHtmlSnapshot(page) {
    return page.evaluate(() => {
        const judgeMap = {};
        const lhMap = {};
        document.querySelectorAll('[class*="TableTournamentResultGame_table-tournament-result-game"]').forEach(container => {
            const tbl = container.tagName === 'TABLE' ? container : container.querySelector('table');
            if (!tbl) return;
            let p = tbl.parentElement;
            let gameNum = null;
            while (p && gameNum === null) {
                const titleEl = p.querySelector('[class*="games-tour-title__"]');
                if (titleEl) {
                    const m = titleEl.textContent.trim().match(/Тур\s+(\d+)/);
                    if (m) gameNum = parseInt(m[1], 10);
                }
                p = p.parentElement;
            }
            if (gameNum === null) return;
            const th = tbl.querySelector('thead th[colspan="3"] > div > div');
            let numT = null;
            if (th) {
                const m = th.textContent.trim().match(/^Стол\s+(\d+),\s*(.+)$/);
                if (m) {
                    numT = parseInt(m[1], 10);
                    const key = `${gameNum}_${numT}`;
                    if (!judgeMap[key]) judgeMap[key] = m[2].trim();
                }
            }
            if (numT === null) return;
            const key = `${gameNum}_${numT}`;
            if (!lhMap[key]) lhMap[key] = {};
            tbl.querySelectorAll('tbody tr').forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length < 3) return;
                const name = cells[1]?.textContent?.trim()?.toLowerCase();
                const roleCell = cells[2];
                if (!name || !roleCell) return;
                const m = (roleCell.className || '').match(/__item_([a-z]+)__/);
                if (!m) return;
                const code = m[1];
                if (code === 'g') lhMap[key][name] = 'полный';
                else if (code === 'lg') lhMap[key][name] = 'частичный';
                else if (code === 'b') lhMap[key][name] = 'нулевой';
            });
        });
        return { judgeMap, lhMap };
    });
}

// ============ SCRAPE ONE TOURNAMENT ============
async function scrapeTournament(context, rawUrl) {
    const url = normalizeUrl(rawUrl);
    const page = await context.newPage();
    try {
        console.log(`\n🌐 ${url}`);
        await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
        await page.waitForTimeout(800);

        const content = await page.content();
        const scriptMatch = content.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (!scriptMatch) {
            console.error('  ❌ __NEXT_DATA__ не найден');
            return null;
        }
        let data;
        try { data = JSON.parse(scriptMatch[1]); }
        catch (e) { console.error('  ❌ Ошибка парсинга JSON:', e.message); return null; }

        const serverData = data?.props?.pageProps?.serverData;
        if (!serverData) { console.error('  ❌ serverData отсутствует'); return null; }

        const tournamentInfo = serverData.tournament || {};
        const scheme = serverData.scheme || {};
        const gamesData = Array.isArray(serverData.games) ? serverData.games : [];
        const gamesQualifying = int(scheme.number_of_games_qualifying) || 0;
        const gamesSemi = int(scheme.number_of_games_semi_final) || 0;
        const gamesFinal = int(scheme.number_of_games_final) || 0;
        const hasFinalStage = gamesFinal > 0;
        const tid = extractTournamentId(url) || int(tournamentInfo.id);

        let snapshot = { judgeMap: {}, lhMap: {} };
        if (await clickTabByText(page, 'Итоги по играм')) {
            await page.waitForTimeout(2000);
            snapshot = await extractHtmlSnapshot(page);
        }
        console.log(`  👨‍⚖️ Судьи: ${Object.keys(snapshot.judgeMap).length} | ЛХ-столов: ${Object.keys(snapshot.lhMap).length}`);

        const standings = {
            withFinal: (serverData.tournamentResultWithFinal || []).map(mapStandingRow),
            withoutFinal: (serverData.tournamentResultWithoutFinal || []).map(mapStandingRow)
        };

        const rawTeams = (serverData.teamsResult || []).map(t => ({
            title: t.title,
            sum: num(t.sum), sum_extra: num(t.sum_extra),
            plus: num(t.extra_point), minus: num(t.fine), gg: num(t.global_game),
            wins: int(t.win),
            order_sum: num(t.order_sum) || 0,
            order_global_game: num(t.order_global_game) || 0,
            order_win_as_sheriff_and_don: num(t.order_win_as_sheriff_and_don) || 0,
            users: (t.users || []).map(u => ({
                login: u.login,
                firstName: u.first_name || null,
                lastName: u.last_name || null
            }))
        }));
        const teams = [...rawTeams].sort((a, b) => {
            if (b.order_sum !== a.order_sum) return b.order_sum - a.order_sum;
            if (b.order_global_game !== a.order_global_game) return b.order_global_game - a.order_global_game;
            return b.order_win_as_sheriff_and_don - a.order_win_as_sheriff_and_don;
        }).map((t, i) => ({ ...t, place: i + 1 }));

        const games = [];
        let totalTables = 0;
        let tablesWithElo = 0;
        for (const game of gamesData) {
            const gameNum = parseInt(String(game.gameNum).replace(/\D/g, ''), 10) || 0;
            let round = 'Отбор';
            if (gamesFinal > 0 && gameNum > gamesQualifying + gamesSemi) round = 'Финал';
            else if (gamesSemi > 0 && gameNum > gamesQualifying) round = 'Полуфинал';

            const tables = [];
            for (const table of (game.game || [])) {
                const tableNum = int(table.tableNum) ?? table.tableNum;
                if (tableNum === null || tableNum === undefined) continue;
                const lhKey = `${gameNum}_${tableNum}`;
                const judgeJson = getJudgeFromJson(table);
                const judgeHtml = snapshot.judgeMap[lhKey] || null;
                const judge = judgeJson || judgeHtml || null;
                const lhMap = snapshot.lhMap[lhKey] || {};

                const players = (table.table || []).map(p => {
                    const loginLower = (p.login || '').toLowerCase();
                    return {
                        login: p.login,
                        userId: p.user_id ?? p.userId ?? p.uid ?? null,
                        role: p.role,
                        roleName: ROLE_NAMES[p.role] || p.role,
                        playType: p.type || 'n',
                        points: typeof p.points === 'number' ? p.points : 0,
                        lhStatus: lhMap[loginLower] || null,
                        elo: null
                    };
                });

                // Enrich composition with ELO from cache + compute table average
                const averageElo = enrichPlayersWithElo(players);
                if (averageElo != null) tablesWithElo++;

                tables.push({
                    tableNumber: tableNum,
                    judge,
                    winner: table.win,   // 'city' | 'mafia'
                    averageElo,
                    players
                });
                totalTables++;
            }

            games.push({ gameNumber: gameNum, round, tables });
        }

        console.log(`  🎮 Игр: ${games.length} | столов: ${totalTables} | с ELO: ${tablesWithElo}`);

        return {
            id: tid,
            tournament: tournamentInfo.title || 'Без названия',
            url,
            dateStart: tournamentInfo.date_start || null,
            dateEnd: tournamentInfo.date_end || null,
            type: tournamentInfo.type || null,
            typeTranslate: tournamentInfo.type_translate || null,
            star: int(tournamentInfo.star),
            elo_average: num(tournamentInfo.elo_average),
            country: tournamentInfo.country || null,
            city: tournamentInfo.city || null,
            hasFinalStage,
            scheme: { qualifying: gamesQualifying, semi: gamesSemi, final: gamesFinal },
            standings,
            teams,
            games
        };
    } catch (err) {
        console.error(`  ❌ Ошибка:`, err.message);
        return null;
    } finally {
        await page.close();
    }
}

// ============ INPUT ============
async function getInputUrls() {
    const args = process.argv.slice(2);
    const flags = new Set(args.filter(a => a.startsWith('--')));
    const positional = args.filter(a => !a.startsWith('--'));

    let filePath = null;
    for (const f of flags) {
        if (f.startsWith('--file=')) filePath = f.slice(7);
    }
    const fileIdx = args.indexOf('--file');
    if (fileIdx !== -1 && args[fileIdx + 1]) filePath = args[fileIdx + 1];

    if (filePath) {
        if (!fs.existsSync(filePath)) { console.error(`❌ Файл не найден: ${filePath}`); process.exit(1); }
        console.log(`📁 Читаем из файла: ${filePath}`);
        return fs.readFileSync(filePath, 'utf-8')
            .split(/\r?\n/).map(l => l.trim())
            .filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
    }

    if (positional.length > 0) return positional;

    const auto = path.join(__dirname, 'tournaments.txt');
    if (fs.existsSync(auto)) {
        console.log(`📁 Найден tournaments.txt — читаем из него`);
        return fs.readFileSync(auto, 'utf-8')
            .split(/\r?\n/).map(l => l.trim())
            .filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (q) => new Promise(r => rl.question(q, r));
    console.log('📝 Введите ID или ссылки на турниры (пустая строка = конец):');
    const list = [];
    while (true) {
        const line = (await question('> ')).trim();
        if (!line) break;
        if (line.startsWith('#') || line.startsWith('//')) continue;
        list.push(line);
    }
    rl.close();
    return list;
}

// ============ ENRICH EXISTING DB ============
function enrichExistingDatabase() {
    if (!fs.existsSync(DB_FILE)) {
        console.error(`❌ База не найдена: ${DB_FILE}`);
        return;
    }
    console.log(`📂 Обогащение существующей базы: ${DB_FILE}`);
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    if (!Array.isArray(db)) { console.error('❌ База не является массивом'); return; }

    let tablesProcessed = 0;
    let tablesWithElo = 0;
    db.forEach(t => {
        (t.games || []).forEach(g => {
            (g.tables || []).forEach(tbl => {
                const players = Array.isArray(tbl.players) ? tbl.players : [];
                const avg = enrichPlayersWithElo(players);
                tbl.averageElo = avg;
                if (avg != null) tablesWithElo++;
                tablesProcessed++;
            });
        });
    });
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');

    const pct = tablesProcessed > 0 ? Math.round(tablesWithElo / tablesProcessed * 100) : 0;
    console.log(`\n✅ Готово. Столов обработано: ${tablesProcessed}`);
    console.log(`   С ELO: ${tablesWithElo} (${pct}%)`);
    console.log(`   💾 Сохранено в ${DB_FILE}`);

    reportEloStats();
}

function reportEloStats() {
    if (!GLOBAL_ELO_CACHE) return;
    const pct = GLOBAL_ELO_STATS.total > 0
        ? Math.round(GLOBAL_ELO_STATS.found / GLOBAL_ELO_STATS.total * 100) : 0;
    console.log(`\n📊 ELO обогащение: ${GLOBAL_ELO_STATS.found}/${GLOBAL_ELO_STATS.total} (${pct}%)`);
    if (GLOBAL_ELO_STATS.missing.size > 0) {
        const missingFile = path.join(__dirname, 'missing-elo-players.txt');
        const list = Array.from(GLOBAL_ELO_STATS.missing).sort();
        fs.writeFileSync(missingFile, list.join('\n'), 'utf-8');
        console.log(`⚠️ Игроков без ELO в кэше: ${missingFile.replace(__dirname + path.sep, '')}`);
        console.log(`   💡 Обновите кэш: node buildEloCache.js --from-results ./results`);
        console.log(`   📝 Список сохранён: ${missingFile}`);
    }
}

// ============ MAIN ============
async function main() {
    console.log('🏆 Парсер турниров gomafia.pro');
    console.log('================================');

    loadGlobalEloCache();

    if (process.argv.includes('--enrich-only')) {
        enrichExistingDatabase();
        return;
    }

    const urls = await getInputUrls();
    if (!urls.length) { console.log('⚠️ Нет входных данных.'); return; }
    console.log(`📋 К обработке: ${urls.length}`);

    const force = process.argv.includes('--force');

    let db = [];
    if (fs.existsSync(DB_FILE)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
            if (Array.isArray(parsed)) {
                db = parsed;
                console.log(`📂 Существующая база: ${db.length} турниров (${DB_FILE})`);
            }
        } catch (e) {
            console.warn(`⚠️ Не удалось прочитать ${DB_FILE}, начинаем с нуля`);
        }
    } else {
        console.log(`📂 База не найдена, создаём: ${DB_FILE}`);
    }
    const existingIds = new Set(db.map(t => t.id).filter(v => v != null));
    const saveDb = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: USER_AGENT });

    let added = 0, skipped = 0, failed = 0;

    for (let i = 0; i < urls.length; i++) {
        const raw = urls[i];
        const url = normalizeUrl(raw);
        const tid = extractTournamentId(url);
        console.log(`\n[${i + 1}/${urls.length}] ${url}`);

        if (!force && tid && existingIds.has(tid)) {
            console.log(`  ⏭️ Уже в базе, пропускаем`);
            skipped++;
            continue;
        }

        const result = await scrapeTournament(context, url);
        if (!result) { failed++; continue; }

        if (force && result.id && existingIds.has(result.id)) {
            db = db.filter(t => t.id !== result.id);
        }
        db.push(result);
        if (result.id) existingIds.add(result.id);
        added++;
        saveDb();
        console.log(`  💾 Сохранено (всего: ${db.length})`);
    }

    await browser.close();
    saveDb();

    console.log(`\n${'='.repeat(50)}`);
    console.log(`✅ Готово`);
    console.log(`   Добавлено: ${added}`);
    console.log(`   Пропущено: ${skipped}`);
    console.log(`   Ошибок:   ${failed}`);
    console.log(`   Всего в базе: ${db.length}`);
    console.log(`   Файл: ${DB_FILE}`);

    reportEloStats();
}

main().catch(err => { console.error('❌ Фатальная ошибка:', err); process.exit(1); });