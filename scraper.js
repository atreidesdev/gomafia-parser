const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (query) => new Promise((resolve) => rl.question(query, resolve));

const ROLE_NAMES = { red: 'Мирный', sheriff: 'Шериф', mafia: 'Маф', don: 'Дон' };
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ============== Общие хелперы ==============

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

function computeMvp(players) {
    if (!Array.isArray(players) || players.length === 0) return [];
    const points = players.map(p => {
        const v = p.points;
        if (typeof v === 'number' && isFinite(v)) return v;
        if (typeof v === 'string') { const n = parseFloat(v.replace(',', '.')); return isNaN(n) ? 0 : n; }
        return 0;
    });
    const max = Math.max(...points);
    if (!(max > 0)) return [];
    return players.map((p, i) => ({ p, pts: points[i] }))
        .filter(x => x.pts === max)
        .map(x => ({ name: x.p.login, role: ROLE_NAMES[x.p.role] || x.p.role, points: x.pts }));
}

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

function parseEloFromList(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim().replace(',', '.');
    if (!s || s === '–' || s === '-' || s === '—') return null;
    const m = s.match(/^[+-]?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
}

function getLhStatus(p, lhKey, lhMap) {
    const loginLower = (p.login || '').toLowerCase();
    if (lhMap && lhMap[lhKey] && lhMap[lhKey][loginLower]) return lhMap[lhKey][loginLower];
    return null;
}

function extractTournamentId(url) {
    if (!url) return null;
    const m = String(url).match(/\/tournament\/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}

function readPlayerUrlsFromFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const urls = [];
    for (const line of content.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#') || t.startsWith('//')) continue;
        urls.push(t);
    }
    return urls;
}

// ============== Парсинг данных ==============

function extractStandingsFromJson(serverData, playerName) {
    const lower = (playerName || '').toLowerCase().trim();
    const out = [];
    const scheme = serverData.scheme || {};
    const gamesFinal = int(scheme.number_of_games_final) || 0;
    const hasFinalStage = gamesFinal > 0;
    const withFinal = Array.isArray(serverData.tournamentResultWithFinal) ? serverData.tournamentResultWithFinal : [];
    const withoutFinal = Array.isArray(serverData.tournamentResultWithoutFinal) ? serverData.tournamentResultWithoutFinal : [];

    const mapRow = (row, stage) => ({
        source: 'json', stage,
        rank: int(row.place), total_points: num(row.sum), sum_db: num(row.sum_extra),
        plus: num(row.extra_point), minus: num(row.fine),
        first_kill_point: num(row.first_kill_point), compensation_point: num(row.compensation_point),
        wins: int(row.win), wins_as_don: int(row.win_as_don), wins_as_sheriff: int(row.win_as_sheriff),
        first_kill: int(row.first_kill), gg: num(row.global_game), elo_delta: num(row.elo_delta),
        is_paid: row.is_paid === '1' || row.is_paid === 1
    });

    let inFinal = false;
    const inWith = withFinal.find(r => (r.login || '').toLowerCase() === lower);
    if (inWith) {
        if (hasFinalStage) {
            if (inWith.place != null && inWith.place !== '') inFinal = true;
            out.push(mapRow(inWith, 'Итог (Финал)'));
        } else {
            out.push(mapRow(inWith, 'Итог'));
        }
    }
    const inWithout = withoutFinal.find(r => (r.login || '').toLowerCase() === lower);
    if (inWithout) out.push(mapRow(inWithout, 'Отбор (не прошёл в Финал)'));
    return { standings: out, inFinal, hasFinalStage };
}

function extractMyTeamFromJson(serverData, playerName) {
    const teams = serverData.teamsResult;
    if (!Array.isArray(teams) || teams.length === 0) return null;
    const lower = (playerName || '').toLowerCase().trim();

    const sorted = [...teams].sort((a, b) => {
        const sa = num(a.order_sum) || 0, sb = num(b.order_sum) || 0;
        if (sb !== sa) return sb - sa;
        const ga = num(a.order_global_game) || 0, gb = num(b.order_global_game) || 0;
        if (gb !== ga) return gb - ga;
        const wa = num(a.order_win_as_sheriff_and_don) || 0, wb = num(b.order_win_as_sheriff_and_don) || 0;
        return wb - wa;
    });

    const myIdx = sorted.findIndex(t => (t.users || []).some(u => (u.login || '').toLowerCase() === lower));
    if (myIdx === -1) return { teamsTotal: sorted.length, myTeam: null };

    const ind = {};
    (serverData.tournamentResultWithFinal || []).forEach(r => { if (r.login) ind[r.login.toLowerCase()] = r; });
    (serverData.tournamentResultWithoutFinal || []).forEach(r => {
        if (r.login && !ind[r.login.toLowerCase()]) ind[r.login.toLowerCase()] = r;
    });

    const myRaw = sorted[myIdx];
    const teamSum = num(myRaw.sum) || 0;
    const players = (myRaw.users || []).map(u => {
        const rec = ind[(u.login || '').toLowerCase()] || {};
        const pSum = num(rec.sum);
        return {
            login: u.login,
            fullName: [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || null,
            isYou: (u.login || '').toLowerCase() === lower,
            sum: pSum, sum_db: num(rec.sum_extra), plus: num(rec.extra_point), minus: num(rec.fine),
            first_kill_point: num(rec.first_kill_point), compensation_point: num(rec.compensation_point),
            gg: num(rec.global_game), wins: int(rec.win), wins_as_don: int(rec.win_as_don),
            wins_as_sheriff: int(rec.win_as_sheriff), first_kill: int(rec.first_kill), place: int(rec.place),
            contributionPct: (teamSum > 0 && pSum != null) ? +((pSum / teamSum) * 100).toFixed(1) : null
        };
    });

    const myTeam = {
        place: myIdx + 1, teamsTotal: sorted.length, title: myRaw.title,
        sum: num(myRaw.sum), sum_db: num(myRaw.sum_extra), plus: num(myRaw.extra_point), minus: num(myRaw.fine),
        first_kill_point: num(myRaw.first_kill_point), compensation_point: num(myRaw.compensation_point),
        gg: num(myRaw.global_game), wins: int(myRaw.win), wins_as_don: int(myRaw.win_as_don),
        wins_as_sheriff: int(myRaw.win_as_sheriff), first_kill: int(myRaw.first_kill), players
    };
    return { teamsTotal: sorted.length, myTeam };
}

async function extractHtmlSnapshot(page, playerName) {
    return page.evaluate((pn) => {
        const lowerPn = (pn || '').toLowerCase().trim();
        const standings = [];
        const judgeMap = {};
        const lhMap = {};
        let stage = null;

        document.querySelectorAll('.Tabs_tabs-tab__ognto.Tabs_tabs-tab_selected__F8aQs').forEach(el => {
            const t = el.textContent.trim();
            if (!stage && (t === 'Отбор' || t === 'Финал')) stage = t;
        });
        if (!stage) {
            const mainTab = document.querySelector('.Tabs_tabs-tab__ognto.Tabs_tabs-tab_selected__F8aQs');
            if (mainTab) stage = mainTab.textContent.trim();
        }

        document.querySelectorAll('[class*="TableTournamentResult_tournaments-table-result"] table').forEach((tbl, idx) => {
            tbl.querySelectorAll('tbody tr').forEach(row => {
                const tds = row.querySelectorAll('td');
                if (tds.length < 3) return;
                const nameCell = tds[1];
                const nameDiv = nameCell.querySelector('.d-flex');
                const rawName = (nameDiv ? nameDiv.childNodes[0]?.textContent : nameCell.textContent) || '';
                const nameText = rawName.replace(/\s+/g, ' ').trim();
                if (!nameText || nameText.toLowerCase() !== lowerPn) return;
                const rank = parseInt((tds[0]?.textContent || '').trim(), 10);
                const tp = parseFloat((tds[2]?.textContent || '').trim().replace(',', '.'));
                const entry = {
                    source: 'html', stage: stage || `table_${idx}`,
                    rank: isNaN(rank) ? null : rank,
                    total_points: isNaN(tp) ? null : tp
                };
                const extraKeys = ['sum_db', 'plus', 'minus', 'lh', 'ci', 'p', 'd', 'sh', 'u', 'gg'];
                for (let i = 3; i < tds.length && (i - 3) < extraKeys.length; i++) {
                    const txt = (tds[i]?.textContent || '').trim().replace(',', '.').replace(/^\+/, '');
                    const v = parseFloat(txt);
                    if (!isNaN(v)) entry[extraKeys[i - 3]] = v;
                }
                standings.push(entry);
            });
        });

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

        return { standings, judgeMap, lhMap };
    }, playerName);
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

async function ensureStandingsTabVisible(page) {
    const candidates = ['Турнирные таблицы', 'Личный зачёт', 'Командный зачёт', 'Отбор', 'Финал'];
    for (const name of candidates) {
        if (await clickTabByText(page, name)) { await page.waitForTimeout(700); return name; }
    }
    return null;
}

function dedupeStandings(standings) {
    const seen = new Set();
    const out = [];
    for (const s of standings) {
        const key = `${s.source}|${s.stage}|${s.rank}|${s.total_points}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
    }
    return out;
}

// ============== Скрейп одного турнира (вынесено из parsePlayerHistory) ==============

async function scrapeSingleTournament(context, tournamentHref, tournamentName, playerName, targetRoles, matchMode, eloDeltaFromList, ggFromList) {
    const tournamentUrl = `https://gomafia.pro${tournamentHref}`;
    const tournamentPage = await context.newPage();
    try {
        await tournamentPage.goto(tournamentUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await tournamentPage.waitForTimeout(600);
        const content = await tournamentPage.content();
        const scriptMatch = content.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/);
        if (!scriptMatch) { console.warn('  ⚠️ Не удалось найти JSON турнира.'); return null; }

        const data = JSON.parse(scriptMatch[1]);
        const serverData = data?.props?.pageProps?.serverData;
        if (!serverData) { console.warn('  ⚠️ serverData отсутствует.'); return null; }

        const gamesData = serverData.games;
        const tournamentInfo = serverData.tournament || {};
        const scheme = serverData.scheme || {};
        const gamesQualifying = int(scheme.number_of_games_qualifying) || 0;
        const gamesSemi = int(scheme.number_of_games_semi_final) || 0;
        const gamesFinal = int(scheme.number_of_games_final) || 0;
        const eloAverage = num(tournamentInfo.elo_average);
        const star = int(tournamentInfo.star);
        const dateStart = tournamentInfo.date_start || null;
        const dateEnd = tournamentInfo.date_end || null;
        const typeCode = tournamentInfo.type || null;
        if (!gamesData) return null;

        const jsonStandings = extractStandingsFromJson(serverData, playerName);
        const teamInfo = extractMyTeamFromJson(serverData, playerName);

        let snapshot = await extractHtmlSnapshot(tournamentPage, playerName);
        if (jsonStandings.standings.length === 0 && snapshot.standings.length === 0) {
            const opened = await ensureStandingsTabVisible(tournamentPage);
            if (opened) {
                const retry = await extractHtmlSnapshot(tournamentPage, playerName);
                snapshot.standings = retry.standings;
                Object.assign(snapshot.judgeMap, retry.judgeMap);
                Object.assign(snapshot.lhMap, retry.lhMap);
            }
        }

        if (await clickTabByText(tournamentPage, 'Итоги по играм')) {
            await tournamentPage.waitForTimeout(1500);
            const retry = await extractHtmlSnapshot(tournamentPage, playerName);
            Object.assign(snapshot.judgeMap, retry.judgeMap);
            Object.assign(snapshot.lhMap, retry.lhMap);
            snapshot.standings = dedupeStandings([...snapshot.standings, ...retry.standings]);
        }

        if (process.env.DEBUG_LH) {
            const total = Object.values(snapshot.lhMap).reduce((s, m) => s + Object.keys(m).length, 0);
            console.log(`  🔍 lhMap: ${Object.keys(snapshot.lhMap).length} ключей, ${total} записей ЛХ`);
            Object.entries(snapshot.lhMap).forEach(([k, m]) => {
                if (Object.keys(m).length) console.log(`     ${k}:`, m);
            });
        }

        const standingsFinal = dedupeStandings(
            jsonStandings.standings.length > 0 ? jsonStandings.standings : snapshot.standings
        );
        const standingsWithListElo = standingsFinal.map(s => ({
            ...s,
            elo_delta: eloDeltaFromList != null ? eloDeltaFromList : s.elo_delta,
            gg: (s.gg == null && ggFromList != null) ? ggFromList : s.gg
        }));

        const matchingGames = [];
        let judgeMissingLogged = false;
        let playedInFinal = false;

        for (const game of gamesData) {
            const rawGameNum = game.gameNum;
            const gameNum = parseInt(String(rawGameNum).replace(/\D/g, ''), 10) || 0;
            let round = 'Отбор';
            if (gamesFinal > 0 && gameNum > gamesQualifying + gamesSemi) round = 'Финал';
            else if (gamesSemi > 0 && gameNum > gamesQualifying) round = 'Полуфинал';

            for (const table of game.game) {
                const tableNum = int(table.tableNum) ?? table.tableNum;
                const lhKey = `${gameNum}_${tableNum}`;
                const winCode = table.win;
                const judgeJson = getJudgeFromJson(table);
                const judgeHtml = snapshot.judgeMap[lhKey] || null;
                const judge = judgeJson || judgeHtml;
                const playerRecord = table.table.find(p => p.login.toLowerCase() === playerName.toLowerCase());
                if (!playerRecord) continue;
                if (round === 'Финал') playedInFinal = true;

                const roleCode = playerRecord.role;
                const playerTeam = (roleCode === 'red' || roleCode === 'sheriff') ? 'city' : 'mafia';
                const isWin = winCode === playerTeam;
                const isLoss = winCode !== playerTeam;
                let isMatch = false;
                if (targetRoles.includes(roleCode)) {
                    if (matchMode === 'all') isMatch = true;
                    else if (matchMode === 'win' && isWin) isMatch = true;
                    else if (matchMode === 'loss' && isLoss) isMatch = true;
                }
                if (!isMatch) continue;

                if (!judge && !judgeMissingLogged) {
                    console.log(`  ⚠️ Судья не найден для стола ${tableNum} (игра ${gameNum}).`);
                    judgeMissingLogged = true;
                }

                const composition = table.table.map(p => {
                    const lhStatus = getLhStatus(p, lhKey, snapshot.lhMap);
                    const base = {
                        name: p.login, role: ROLE_NAMES[p.role] || p.role,
                        isYou: p.login.toLowerCase() === playerName.toLowerCase(),
                        playType: p.type || 'n',
                        points: typeof p.points === 'number' ? p.points : 0
                    };
                    if (lhStatus !== null) { base.isFirstKill = true; base.lhStatus = lhStatus; }
                    return base;
                });
                const firstKilledPlayer = composition.find(p => p.isFirstKill) || null;

                matchingGames.push({
                    round, gameNumber: `Игра ${gameNum}`, tableNumber: `Стол ${tableNum}`,
                    tableJudge: judge, role: ROLE_NAMES[roleCode] || roleCode,
                    winner: winCode === 'city' ? 'Мирные' : 'Мафия', isWin,
                    firstKill: firstKilledPlayer ? {
                        name: firstKilledPlayer.name, role: firstKilledPlayer.role, lhStatus: firstKilledPlayer.lhStatus
                    } : null,
                    mvp: computeMvp(table.table), composition
                });
            }
        }

        if (matchingGames.length > 0) {
            console.log(`  ✅ Найдено совпадений: ${matchingGames.length}`);
            if (jsonStandings.hasFinalStage) {
                console.log(`  🏁 Финал: ${playedInFinal ? '✅ игрок в финале' : '❌ не прошёл в финал или не играл'}`);
            }
            if (teamInfo?.myTeam) {
                const mt = teamInfo.myTeam;
                console.log(`  👥 Команда «${mt.title}» — место ${mt.place ?? '?'} из ${mt.teamsTotal} (Σ ${mt.sum ?? '?'}, GG ${mt.gg ?? '?'})`);
            }
            console.log(`  📈 ELO (из списка): ${eloDeltaFromList != null ? (eloDeltaFromList > 0 ? '+' : '') + eloDeltaFromList : '—'}` +
                (ggFromList != null ? ` | GG (из списка): ${ggFromList}` : ''));
            if (standingsWithListElo.length) {
                console.log(`  📊 ` + standingsWithListElo.map(s =>
                    `[${s.source}] ${s.stage}: место ${s.rank ?? '?'} (${s.total_points ?? '?'})` +
                    (s.gg != null ? ` | GG: ${s.gg}` : '') +
                    (s.elo_delta != null ? ` | ELO: ${s.elo_delta > 0 ? '+' : ''}${s.elo_delta}` : '')
                ).join(' | '));
            }
            return {
                tournament: tournamentName, url: tournamentUrl, dateStart, dateEnd, type: typeCode,
                elo_average: eloAverage, elo_delta: eloDeltaFromList, gg: ggFromList, star,
                hasFinalStage: jsonStandings.hasFinalStage, inFinal: playedInFinal,
                standings: standingsWithListElo, team: teamInfo?.myTeam || null, games: matchingGames
            };
        }
        return null;
    } catch (err) {
        console.error(`  ❌ Ошибка при обработке турнира ${tournamentName}:`, err.message);
        return null;
    } finally {
        await tournamentPage.close();
    }
}

// ============== Получение списка турниров со страницы истории ==============

async function fetchTournamentListFromProfile(page, playerUrl) {
    const list = [];
    let currentPage = 1;
    let globalIndex = 0;
    while (true) {
        const targetUrl = new URL(playerUrl);
        targetUrl.searchParams.set('tab', 'history');
        if (currentPage > 1) targetUrl.searchParams.set('page', currentPage.toString());
        console.log(`\n📄 Загрузка списка турниров (стр. ${currentPage})`);
        await page.goto(targetUrl.toString(), { waitUntil: 'networkidle', timeout: 30000 });

        const headerCells = await page.$$eval(
            'table thead tr > td, table thead tr > th',
            els => els.map(el => el.innerText.trim())
        );
        const idxElo = headerCells.findIndex(h => /^elo$/i.test(h));
        const idxGG = headerCells.findIndex(h => /^gg$/i.test(h));

        const rows = await page.$$('table tbody tr');
        if (rows.length === 0) break;

        let foundAny = false;
        for (const row of rows) {
            const cells = await row.$$('td');
            const cellTexts = await Promise.all(cells.map(c => c.evaluate(el => el.innerText.trim())));
            const linkElement = await row.$('td:nth-child(2) a');
            const href = linkElement ? await linkElement.evaluate(el => el.getAttribute('href')) : null;
            if (!href) continue;
            foundAny = true;
            globalIndex++;
            const name = (cellTexts[1] || 'Неизвестный турнир').replace(/\n/g, ', ');
            list.push({
                index: globalIndex,
                href,
                name,
                eloDeltaFromList: idxElo >= 0 ? parseEloFromList(cellTexts[idxElo]) : null,
                ggFromList: idxGG >= 0 ? num(cellTexts[idxGG]) : null
            });
        }
        if (!foundAny) break;

        const nextPageBtn = await page.$('.Pagination_pagination__page___s0V8:not(.Pagination_pagination__page-selected__8gXVU)');
        if (!nextPageBtn) break;
        currentPage++;
    }
    return list;
}

// ============== Основной парсинг (диапазон) ==============

async function parsePlayerHistory(playerUrl, targetRoles, matchMode, startIdx, endIdx) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: USER_AGENT });
    const page = await context.newPage();
    const results = [];
    let playerName = 'UnknownPlayer';

    try {
        console.log(`\n🌐 Переход по ссылке: ${playerUrl}`);
        await page.goto(playerUrl, { waitUntil: 'networkidle', timeout: 30000 });
        const playerNameEl = await page.$('div[class*="ProfileUserInfo_profile-user__name"]');
        if (playerNameEl) {
            playerName = await page.evaluate(el => el.innerText.trim(), playerNameEl);
            console.log(`✅ Имя игрока определено: ${playerName}`);
        } else {
            console.warn('⚠️ Не удалось извлечь имя со страницы. Будет использовано "UnknownPlayer".');
        }

        const list = await fetchTournamentListFromProfile(page, playerUrl);
        console.log(`📋 Найдено турниров в истории: ${list.length}`);

        for (const item of list) {
            if (item.index < startIdx) continue;
            if (item.index > endIdx) {
                console.log(`\n🏁 Достигнут верхний предел диапазона (турнир #${endIdx}). Остановка.`);
                break;
            }
            console.log(`\n🏆 Обработка турнира #${item.index}: ${item.name}`);
            const result = await scrapeSingleTournament(
                context, item.href, item.name, playerName, targetRoles, matchMode,
                item.eloDeltaFromList, item.ggFromList
            );
            if (result) results.push(result);
        }

        if (results.length) {
            results[0].playerUrl = playerUrl;
            results[0].playerName = playerName;
            const idMatch = String(playerUrl).match(/\/(\d+)(?:[/?#]|$)/);
            if (idMatch) results[0].playerId = parseInt(idMatch[1], 10);
        }
        return { results, playerName };
    } catch (error) {
        console.error('❌ Критическая ошибка скрипта:', error);
        return { results: [], playerName: 'UnknownPlayer' };
    } finally {
        await browser.close();
    }
}

// ============== Обновление (только новые турниры) ==============

async function updatePlayerHistory(playerUrl) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: USER_AGENT });
    const page = await context.newPage();
    try {
        await page.goto(playerUrl, { waitUntil: 'networkidle', timeout: 30000 });
        let playerName = 'UnknownPlayer';
        const playerNameEl = await page.$('div[class*="ProfileUserInfo_profile-user__name"]');
        if (playerNameEl) {
            playerName = await page.evaluate(el => el.innerText.trim(), playerNameEl);
            console.log(`✅ Имя игрока: ${playerName}`);
        } else {
            console.warn(`⚠️ Не удалось извлечь имя для ${playerUrl}`);
        }

        const outputDir = path.join(__dirname, 'results');
        const safeName = playerName.replace(/[^a-zA-Zа-яА-Я0-9_-]/g, '_');
        const filename = path.join(outputDir, `${safeName}-все_игры_all.json`);

        let existing = [];
        if (fs.existsSync(filename)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(filename, 'utf-8'));
                if (Array.isArray(parsed)) existing = parsed;
                console.log(`📂 Существующих турниров в файле: ${existing.length}`);
            } catch (e) {
                console.warn(`⚠️ Не удалось прочитать ${filename}: ${e.message}`);
            }
        } else {
            console.log(`📂 Файл не существует — начинаем с нуля.`);
        }

        const knownIds = new Set(
            existing.map(r => extractTournamentId(r.url)).filter(v => v != null)
        );

        const list = await fetchTournamentListFromProfile(page, playerUrl);
        console.log(`📋 Турниров в истории: ${list.length}`);

        const targetRoles = ['red', 'sheriff', 'mafia', 'don'];
        const newTournaments = [];

        for (const item of list) {
            const fullUrl = `https://gomafia.pro${item.href}`;
            const tid = extractTournamentId(fullUrl);
            if (tid && knownIds.has(tid)) continue;
            console.log(`\n🆕 Новый турнир #${item.index}: ${item.name}`);
            const result = await scrapeSingleTournament(
                context, item.href, item.name, playerName, targetRoles, 'all',
                item.eloDeltaFromList, item.ggFromList
            );
            if (result) newTournaments.push(result);
        }

        const merged = [...newTournaments, ...existing];
        if (merged.length === 0) {
            console.log(`⚠️ Нет данных для сохранения.`);
            return { playerName, saved: false, newCount: 0, totalCount: 0 };
        }

        // Обновляем мета-инфо игрока (id, url, name) в первом элементе
        merged[0].playerUrl = playerUrl;
        merged[0].playerName = playerName;
        const idMatch = String(playerUrl).match(/\/(\d+)(?:[/?#]|$)/);
        if (idMatch) merged[0].playerId = parseInt(idMatch[1], 10);

        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(filename, JSON.stringify(merged, null, 2), 'utf-8');
        console.log(`💾 Сохранено: ${filename} (новых: ${newTournaments.length}, всего: ${merged.length})`);

        return { playerName, saved: true, newCount: newTournaments.length, totalCount: merged.length };
    } catch (err) {
        console.error(`❌ Ошибка обновления ${playerUrl}:`, err.message);
        return { playerName: 'UnknownPlayer', saved: false, newCount: 0, totalCount: 0 };
    } finally {
        await browser.close();
    }
}

// ============== Точка входа ==============

(async () => {
    console.log('🕵️ Парсер статистики gomafia.pro (Интерактивный режим)');
    console.log('=======================================================');
    try {
        console.log('\n🎭 Выберите режим поиска:');
        console.log('  1. Все победы');
        console.log('  2. Все поражения');
        console.log('  3. Мирный');
        console.log('  4. Шериф');
        console.log('  5. Маф');
        console.log('  6. Дон');
        console.log('  7. Мирные-победы');
        console.log('  8. Мирные-поражения');
        console.log('  9. Черные-победы');
        console.log(' 10. Черные-поражения');
        console.log(' 11. Все игры');
        console.log(' 12. Все игры во всех турнирах (без указания диапазона)');
        console.log(' 13. 📁 Загрузить всех игроков из файла — ВСЕ турниры (полная перезапись)');
        console.log(' 14. 🔄 Обновить всех игроков из файла — только НОВЫЕ турниры');

        let roleChoice = '';
        const validChoices = ['1','2','3','4','5','6','7','8','9','10','11','12','13','14'];
        while (!validChoices.includes(roleChoice)) {
            roleChoice = (await question('👉 Введите номер варианта (1-14): ')).trim();
            if (!validChoices.includes(roleChoice)) console.log('❌ Введите число от 1 до 14.');
        }

        // ---------- Батч-режимы (13 / 14) ----------
if (roleChoice === '13' || roleChoice === '14') {
    // Автовыбор файла: env → players.txt рядом со скриптом
    const candidates = [
        process.env.PLAYERS_FILE,
        path.join(__dirname, 'players.txt'),
        path.join(__dirname, 'players', 'all.txt')
    ].filter(Boolean);

    let filePath = candidates.find(p => fs.existsSync(p));

    if (!filePath) {
        console.log('\n⚠️ Автоматически players.txt не найден. Проверены пути:');
        candidates.forEach(p => console.log(`   • ${p}`));
        filePath = (await question('📁 Введите путь к файлу со ссылками (Enter — отмена): ')).trim();
        if (!filePath) { rl.close(); console.log('Отменено.'); return; }
    }

    rl.close();
    if (!fs.existsSync(filePath)) {
        console.log(`❌ Файл не найден: ${filePath}`);
        return;
    }

    console.log(`📁 Используется файл: ${filePath}`);
            const urls = readPlayerUrlsFromFile(filePath);
            if (urls.length === 0) {
                console.log('⚠️ Файл пуст (или всё — комментарии).');
                return;
            }
            const isLoadAll = roleChoice === '13';
            console.log(`\n📁 Ссылок: ${urls.length}`);
            console.log(`🎬 Режим: ${isLoadAll ? 'Загрузка ВСЕХ турниров' : 'Обновление (только новые)'}`);

            const outputDir = path.join(__dirname, 'results');
            if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

            const summary = [];
            for (let i = 0; i < urls.length; i++) {
                const playerUrl = urls[i];
                console.log(`\n${'='.repeat(60)}`);
                console.log(`[${i + 1}/${urls.length}] 👤 ${playerUrl}`);
                console.log('='.repeat(60));
                try {
                    if (isLoadAll) {
                        const { results, playerName } = await parsePlayerHistory(
                            playerUrl, ['red', 'sheriff', 'mafia', 'don'], 'all', 1, Infinity
                        );
                        if (results.length === 0) {
                            console.log(`⚠️ Нет данных для ${playerUrl}`);
                            summary.push({ url: playerUrl, playerName, tournaments: 0, games: 0, error: false });
                            continue;
                        }
                        const safeName = playerName.replace(/[^a-zA-Zа-яА-Я0-9_-]/g, '_');
                        const filename = path.join(outputDir, `${safeName}-все_игры_all.json`);
                        fs.writeFileSync(filename, JSON.stringify(results, null, 2), 'utf-8');
                        const totalGames = results.reduce((s, t) => s + t.games.length, 0);
                        console.log(`💾 Сохранено: ${filename}`);
                        summary.push({ url: playerUrl, playerName, tournaments: results.length, games: totalGames, error: false });
                    } else {
                        const r = await updatePlayerHistory(playerUrl);
                        summary.push({
                            url: playerUrl,
                            playerName: r.playerName,
                            tournaments: r.totalCount,
                            newCount: r.newCount,
                            error: !r.saved && r.totalCount === 0
                        });
                    }
                } catch (err) {
                    console.error(`❌ Ошибка при обработке ${playerUrl}:`, err.message);
                    summary.push({ url: playerUrl, playerName: '—', tournaments: 0, error: true });
                }
            }

            console.log(`\n${'='.repeat(60)}`);
            console.log(`📊 ИТОГИ БАТЧ-ОБРАБОТКИ`);
            console.log('='.repeat(60));
            summary.forEach((s, i) => {
                const status = s.error ? '❌' : '✅';
                if (isLoadAll) {
                    console.log(`${status} [${i + 1}] ${s.playerName} — турниров: ${s.tournaments}, игр: ${s.games}`);
                } else {
                    console.log(`${status} [${i + 1}] ${s.playerName} — новых: ${s.newCount ?? 0}, всего: ${s.tournaments}`);
                }
            });
            return;
        }

        // ---------- Одиночный режим (1-12) ----------
        const playerUrl = await question('🔗 Введите ссылку на профиль: ');
        let targetRoles = [], matchMode = 'all', modeString = '', skipRange = false;
        switch (roleChoice) {
            case '1': targetRoles = ['red','sheriff','mafia','don']; matchMode='win';  modeString='Все победы'; break;
            case '2': targetRoles = ['red','sheriff','mafia','don']; matchMode='loss'; modeString='Все поражения'; break;
            case '3': targetRoles = ['red'];     modeString='Мирный (все игры)'; break;
            case '4': targetRoles = ['sheriff']; modeString='Шериф (все игры)'; break;
            case '5': targetRoles = ['mafia'];   modeString='Маф (все игры)'; break;
            case '6': targetRoles = ['don'];     modeString='Дон (все игры)'; break;
            case '7': targetRoles = ['red','sheriff']; matchMode='win';  modeString='Мирные-победы'; break;
            case '8': targetRoles = ['red','sheriff']; matchMode='loss'; modeString='Мирные-поражения'; break;
            case '9': targetRoles = ['mafia','don'];   matchMode='win';  modeString='Черные-победы'; break;
            case '10':targetRoles = ['mafia','don'];   matchMode='loss'; modeString='Черные-поражения'; break;
            case '11':targetRoles = ['red','sheriff','mafia','don']; modeString='Все игры'; break;
            case '12':targetRoles = ['red','sheriff','mafia','don']; modeString='Все игры'; skipRange = true; break;
        }

        let startTournament, endTournament;
        if (skipRange) {
            startTournament = 1; endTournament = Infinity;
            console.log('\n📅 Диапазон пропущен — парсим ВСЕ турниры до конца истории.');
        } else {
            console.log('\n📅 Диапазон турниров (1 = самый новый):');
            const startInput = await question('👉 Начальный номер: ');
            const endInput = await question('👉 Конечный номер: ');
            startTournament = parseInt(startInput, 10);
            endTournament = parseInt(endInput, 10);
            if (isNaN(startTournament) || isNaN(endTournament) || startTournament > endTournament || startTournament < 1) {
                console.log('❌ Неверный диапазон турниров.');
                rl.close();
                return;
            }
        }
        rl.close();

        console.log(`\n⏳ Запуск: [${modeString}], [${skipRange ? 'все турниры' : startTournament + '-' + endTournament}]\n`);
        const { results, playerName } = await parsePlayerHistory(
            playerUrl, targetRoles, matchMode, startTournament, endTournament
        );

        const totalGames = results.reduce((s, t) => s + t.games.length, 0);
        console.log(`\n✅ Готово! Турниров: ${results.length}, игр: ${totalGames}`);

        if (results.length) {
            const safePlayerName = playerName.replace(/[^a-zA-Zа-яА-Я0-9_-]/g, '_');
            const safeMode = modeString.replace(/\s+/g, '_').toLowerCase();
            const rangeStr = skipRange ? 'all' : `${startTournament}-${endTournament}`;
            const outputDir = path.join(__dirname, 'results');
            if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
            const filename = path.join(outputDir, `${safePlayerName}-${safeMode}_${rangeStr}.json`);
            fs.writeFileSync(filename, JSON.stringify(results, null, 2), 'utf-8');
            console.log(`💾 Сохранено: ${filename}`);
            console.log(`👤 Профиль: ${playerUrl}`);

            console.log('\n📋 Сводка:');
            results.forEach(t => {
                const eloStr = t.elo_delta != null ? ` | Δ ELO: ${t.elo_delta > 0 ? '+' : ''}${t.elo_delta}` : '';
                console.log(`\n🏆 ${t.tournament} (${t.dateStart ?? '?'} – ${t.dateEnd ?? '?'})`);
                console.log(`   ⭐ ${t.star ?? '?'} | ELO ср.: ${t.elo_average ?? '?'}${eloStr}` + (t.type === 'team' ? ' | Командный' : ' | Личный'));
                console.log(`🔗 ${t.url}`);
                if (t.hasFinalStage) {
                    console.log(`   🏁 Финал: ${t.inFinal ? '✅ игрок в финале' : '❌ не прошёл в финал или не играл'}`);
                }
                (t.standings || []).forEach(s =>
                    console.log(`   📊 [${s.source}] ${s.stage}: место ${s.rank ?? '?'} | ${s.total_points ?? '?'} очков` +
                        (s.gg != null ? ` | GG: ${s.gg}` : '') +
                        (s.elo_delta != null ? ` | ELO: ${s.elo_delta > 0 ? '+' : ''}${s.elo_delta}` : '')));
                t.games.forEach(g => {
                    const r = g.isWin ? '✅ Победа' : '❌ Поражение';
                    const j = g.tableJudge ? ` | Судья: ${g.tableJudge}` : '';
                    const m = g.mvp?.length ? ` | MVP: ${g.mvp.map(x => `${x.name} (${x.points})`).join(', ')}` : '';
                    const round = g.round ? ` [${g.round}]` : '';
                    const fk = g.firstKill
                        ? ` | 🎯 1-й убит: ${g.firstKill.name} (${g.firstKill.role}, ЛХ: ${g.firstKill.lhStatus})`
                        : ' | 🎯 1-й убит: —';
                    console.log(`   ├─${round} ${g.gameNumber}, ${g.tableNumber} | Роль: ${g.role}, ${r}${fk}${j}${m}`);
                });
            });
        } else {
            console.log('⚠️ Совпадений не найдено.');
        }
    } catch (error) {
        console.error('❌ Ошибка:', error);
        rl.close();
    }
})();