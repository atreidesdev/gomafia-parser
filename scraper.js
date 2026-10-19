const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (query) => new Promise((resolve) => rl.question(query, resolve));
const ROLE_NAMES = { red: 'Мирный', sheriff: 'Шериф', mafia: 'Маф', don: 'Дон' };

// ---------- helpers ----------
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
    return players
        .map((p, i) => ({ p, pts: points[i] }))
        .filter(x => x.pts === max)
        .map(x => ({ name: x.p.login, role: ROLE_NAMES[x.p.role] || x.p.role, points: x.pts }));
}

// --- числовые парсеры ---
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

// --- standings из JSON (учитывает финал) ---
function extractStandingsFromJson(serverData, playerName) {
    const lower = (playerName || '').toLowerCase().trim();
    const out = [];
    const scheme = serverData.scheme || {};
    const gamesFinal = int(scheme.number_of_games_final) || 0;
    const hasFinalStage = gamesFinal > 0;
    const withFinal = Array.isArray(serverData.tournamentResultWithFinal) ? serverData.tournamentResultWithFinal : [];
    const withoutFinal = Array.isArray(serverData.tournamentResultWithoutFinal) ? serverData.tournamentResultWithoutFinal : [];
    
    const mapRow = (row, stage) => ({
        source: 'json',
        stage,
        rank: int(row.place),
        total_points: num(row.sum),
        sum_db: num(row.sum_extra),
        plus: num(row.extra_point),
        minus: num(row.fine),
        first_kill_point: num(row.first_kill_point),
        compensation_point: num(row.compensation_point),
        wins: int(row.win),
        wins_as_don: int(row.win_as_don),
        wins_as_sheriff: int(row.win_as_sheriff),
        first_kill: int(row.first_kill),
        gg: num(row.global_game),
        elo_delta: num(row.elo_delta),
        is_paid: row.is_paid === '1' || row.is_paid === 1
    });

    let inFinal = false;
    const inWith = withFinal.find(r => (r.login || '').toLowerCase() === lower);
    if (inWith) {
        if (hasFinalStage) {
            // ИСПРАВЛЕНИЕ: считаем, что игрок в финале, только если у него есть валидное место (place)
            if (inWith.place != null && inWith.place !== '') {
                inFinal = true;
            }
            out.push(mapRow(inWith, 'Итог (Финал)'));
        } else {
            out.push(mapRow(inWith, 'Итог'));
        }
    }
    
    const inWithout = withoutFinal.find(r => (r.login || '').toLowerCase() === lower);
    if (inWithout) {
        out.push(mapRow(inWithout, 'Отбор (не прошёл в Финал)'));
    }
    
    return { standings: out, inFinal, hasFinalStage };
}

// --- команда игрока из JSON ---
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

    const myIdx = sorted.findIndex(t =>
        (t.users || []).some(u => (u.login || '').toLowerCase() === lower)
    );
    if (myIdx === -1) {
        return { teamsTotal: sorted.length, myTeam: null };
    }

    const ind = {};
    (serverData.tournamentResultWithFinal || []).forEach(r => {
        if (r.login) ind[r.login.toLowerCase()] = r;
    });
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
            sum: pSum,
            sum_db: num(rec.sum_extra),
            plus: num(rec.extra_point),
            minus: num(rec.fine),
            first_kill_point: num(rec.first_kill_point),
            compensation_point: num(rec.compensation_point),
            gg: num(rec.global_game),
            wins: int(rec.win),
            wins_as_don: int(rec.win_as_don),
            wins_as_sheriff: int(rec.win_as_sheriff),
            first_kill: int(rec.first_kill),
            place: int(rec.place),
            contributionPct: (teamSum > 0 && pSum != null) ? +((pSum / teamSum) * 100).toFixed(1) : null
        };
    });

    const myTeam = {
        place: myIdx + 1,
        teamsTotal: sorted.length,
        title: myRaw.title,
        sum: num(myRaw.sum),
        sum_db: num(myRaw.sum_extra),
        plus: num(myRaw.extra_point),
        minus: num(myRaw.fine),
        first_kill_point: num(myRaw.first_kill_point),
        compensation_point: num(myRaw.compensation_point),
        gg: num(myRaw.global_game),
        wins: int(myRaw.win),
        wins_as_don: int(myRaw.win_as_don),
        wins_as_sheriff: int(myRaw.win_as_sheriff),
        first_kill: int(myRaw.first_kill),
        players
    };
    return { teamsTotal: sorted.length, myTeam };
}

// --- HTML snapshot ---
async function extractHtmlSnapshot(page, playerName) {
    return page.evaluate((pn) => {
        const lowerPn = (pn || '').toLowerCase().trim();
        const standings = [];
        const judgeMap = {};
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
                    source: 'html',
                    stage: stage || `table_${idx}`,
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
            const th = tbl.querySelector('thead th[colspan="3"] > div > div');
            if (!th) return;
            const m = th.textContent.trim().match(/^Стол\s+(\d+),\s*(.+)$/);
            if (m) {
                const numT = parseInt(m[1], 10);
                const judge = m[2].trim();
                if (!judgeMap[numT]) judgeMap[numT] = judge;
            }
        });
        return { standings, judgeMap };
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
        if (await clickTabByText(page, name)) {
            await page.waitForTimeout(700);
            return name;
        }
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

// ---------- main parser ----------
async function parsePlayerHistory(playerUrl, targetRoles, matchMode, startIdx, endIdx) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    const results = [];
    let globalTournamentIndex = 0;
    let currentPage = 1;
    let shouldContinue = true;
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

        while (shouldContinue) {
            const targetUrl = new URL(playerUrl);
            targetUrl.searchParams.set('tab', 'history');
            if (currentPage > 1) targetUrl.searchParams.set('page', currentPage.toString());
            console.log(`\n📄 Загрузка страницы истории (стр. ${currentPage}): ${targetUrl.toString()}`);
            await page.goto(targetUrl.toString(), { waitUntil: 'networkidle', timeout: 30000 });

            const rows = await page.$$('table tbody tr');
            if (rows.length === 0) { console.log('⚠️ Таблица турниров не найдена или список закончился.'); break; }

            for (const row of rows) {
                const cells = await row.$$('td');
                const cellTexts = await Promise.all(cells.map(c => c.evaluate(el => el.innerText.trim())));
                const rawTournamentName = cellTexts[1] || 'Неизвестный турнир';
                const tournamentName = rawTournamentName.replace(/\n/g, ', ');
                const linkElement = await row.$('td:nth-child(2) a');
                const tournamentHref = linkElement ? await linkElement.evaluate(el => el.getAttribute('href')) : null;
                if (!tournamentHref) continue;

                globalTournamentIndex++;
                if (globalTournamentIndex < startIdx) continue;
                if (globalTournamentIndex > endIdx) {
                    console.log(`\n🏁 Достигнут верхний предел диапазона (турнир #${endIdx}). Остановка.`);
                    shouldContinue = false;
                    break;
                }

                console.log(`🏆 Обработка турнира #${globalTournamentIndex}: ${tournamentName}`);
                const tournamentUrl = `https://gomafia.pro${tournamentHref}`;
                const tournamentPage = await context.newPage();
                try {
                    await tournamentPage.goto(tournamentUrl, { waitUntil: 'networkidle', timeout: 30000 });
                    await tournamentPage.waitForTimeout(600);
                    const content = await tournamentPage.content();
                    const scriptMatch = content.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/);
                    if (!scriptMatch) { console.warn('  ⚠️ Не удалось найти JSON турнира.'); continue; }

                    const data = JSON.parse(scriptMatch[1]);
                    const serverData = data?.props?.pageProps?.serverData;
                    if (!serverData) { console.warn('  ⚠️ serverData отсутствует.'); continue; }

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

                    if (!gamesData) continue;

                    const jsonStandings = extractStandingsFromJson(serverData, playerName);
                    const teamInfo = extractMyTeamFromJson(serverData, playerName);

                    let snapshot = await extractHtmlSnapshot(tournamentPage, playerName);
                    if (jsonStandings.standings.length === 0) {
                        if (snapshot.standings.length === 0) {
                            const opened = await ensureStandingsTabVisible(tournamentPage);
                            if (opened) {
                                const retry = await extractHtmlSnapshot(tournamentPage, playerName);
                                snapshot.standings = retry.standings;
                                Object.assign(snapshot.judgeMap, retry.judgeMap);
                            }
                        }
                    }

                    if (Object.keys(snapshot.judgeMap).length === 0) {
                        if (await clickTabByText(tournamentPage, 'Итоги по играм')) {
                            await tournamentPage.waitForTimeout(700);
                            const retry = await extractHtmlSnapshot(tournamentPage, playerName);
                            Object.assign(snapshot.judgeMap, retry.judgeMap);
                            snapshot.standings = dedupeStandings([...snapshot.standings, ...retry.standings]);
                        }
                    }

                    const standingsFinal = dedupeStandings(
                        jsonStandings.standings.length > 0 ? jsonStandings.standings : snapshot.standings
                    );

                    const matchingGames = [];
                    let judgeMissingLogged = false;
                    let playedInFinal = false; // <-- ИСПРАВЛЕНИЕ: Флаг реального участия в финале

                    for (const game of gamesData) {
                        const gameNum = int(game.gameNum) ?? game.gameNum;
                        let round = 'Отбор';
                        if (gamesFinal > 0 && gameNum > gamesQualifying + gamesSemi) round = 'Финал';
                        else if (gamesSemi > 0 && gameNum > gamesQualifying) round = 'Полуфинал';

                        for (const table of game.game) {
                            const tableNum = table.tableNum;
                            const winCode = table.win;
                            const judgeJson = getJudgeFromJson(table);
                            const judgeHtml = snapshot.judgeMap[tableNum] || snapshot.judgeMap[Number(tableNum)] || null;
                            const judge = judgeJson || judgeHtml;
                            const playerRecord = table.table.find(p => p.login.toLowerCase() === playerName.toLowerCase());
                            if (!playerRecord) continue;

                            // <-- ИСПРАВЛЕНИЕ: Если игрок найден в игре Финала, помечаем флаг
                            if (round === 'Финал') {
                                playedInFinal = true;
                            }

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
                                console.log(`  ⚠️ Судья не найден для стола ${tableNum}. Ключи JSON стола: ${Object.keys(table).join(', ')}`);
                                judgeMissingLogged = true;
                            }

                            const composition = table.table.map(p => ({
                                name: p.login,
                                role: ROLE_NAMES[p.role] || p.role,
                                isYou: p.login.toLowerCase() === playerName.toLowerCase(),
                                playType: p.type || 'n',
                                points: typeof p.points === 'number' ? p.points : 0
                            }));

                            matchingGames.push({
                                round,
                                gameNumber: `Игра ${gameNum}`,
                                tableNumber: `Стол ${tableNum}`,
                                tableJudge: judge,
                                role: ROLE_NAMES[roleCode] || roleCode,
                                winner: winCode === 'city' ? 'Мирные' : 'Мафия',
                                isWin,
                                mvp: computeMvp(table.table),
                                composition
                            });
                        }
                    }

                    if (matchingGames.length > 0) {
                        results.push({
                            tournament: tournamentName,
                            url: tournamentUrl,
                            dateStart,
                            dateEnd,
                            type: typeCode,
                            elo_average: eloAverage,
                            star,
                            hasFinalStage: jsonStandings.hasFinalStage,
                            inFinal: playedInFinal, // <-- ИСПРАВЛЕНИЕ: Используем реальный флаг участия
                            standings: standingsFinal,
                            team: teamInfo?.myTeam || null,
                            games: matchingGames
                        });
                        
                        console.log(`  ✅ Найдено совпадений: ${matchingGames.length}`);
                        if (jsonStandings.hasFinalStage) {
                            console.log(`  🏁 Финал: ${playedInFinal ? '✅ игрок в финале (место и очки — из финала)' : '❌ не прошёл в финал или не играл'}`);
                        }
                        if (teamInfo?.myTeam) {
                            const mt = teamInfo.myTeam;
                            console.log(`  👥 Команда «${mt.title}» — место ${mt.place ?? '?'} из ${mt.teamsTotal} (Σ ${mt.sum ?? '?'}, GG ${mt.gg ?? '?'})`);
                            mt.players.forEach(p => {
                                const mark = p.isYou ? ' ← вы' : '';
                                const contrib = p.contributionPct != null ? ` | вклад ${p.contributionPct}%` : '';
                                console.log(`     • ${p.login}${mark}: Σ ${p.sum ?? '?'}${contrib} | GG ${p.gg ?? '?'} | личное место ${p.place ?? '?'}`);
                            });
                        }
                        if (standingsFinal.length) {
                            console.log(`  📊 ` + standingsFinal.map(s =>
                                `[${s.source}] ${s.stage}: место ${s.rank ?? '?'} (${s.total_points ?? '?'})` +
                                (s.gg != null ? ` | GG: ${s.gg}` : '')
                            ).join(' | '));
                        } else {
                            console.log('  ⚠️ Строчка игрока в турнирной таблице не найдена.');
                        }
                    }
                } catch (err) {
                    console.error(`  ❌ Ошибка при обработке турнира ${tournamentName}:`, err.message);
                } finally {
                    await tournamentPage.close();
                }
            }

            if (shouldContinue) {
                const nextPageBtn = await page.$('.Pagination_pagination__page___s0V8:not(.Pagination_pagination__page-selected__8gXVU)');
                if (!nextPageBtn) { console.log('\n🏁 Достигнут конец списка турниров.'); break; }
                currentPage++;
            }
        }
        return { results, playerName };
    } catch (error) {
        console.error('❌ Критическая ошибка скрипта:', error);
        return { results: [], playerName: 'UnknownPlayer' };
    } finally {
        await browser.close();
    }
}

// ---------- CLI ----------
(async () => {
    console.log('🕵️ Парсер статистики gomafia.pro (Интерактивный режим)');
    console.log('=======================================================');
    try {
        const playerUrl = await question('🔗 Введите ссылку на профиль (например, https://gomafia.pro/stats/1373): ');
        console.log('\n🎭 Выберите режим поиска:');
        console.log('  1. Все победы'); console.log('  2. Все поражения');
        console.log('  3. Мирный'); console.log('  4. Шериф'); console.log('  5. Маф'); console.log('  6. Дон');
        console.log('  7. Мирные-победы'); console.log('  8. Мирные-поражения');
        console.log('  9. Черные-победы'); console.log(' 10. Черные-поражения');
        console.log(' 11. Все игры');
        
        let roleChoice = '';
        const validChoices = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'];
        while (!validChoices.includes(roleChoice)) {
            roleChoice = (await question('👉 Введите номер варианта (1-11): ')).trim();
            if (!validChoices.includes(roleChoice)) console.log('❌ Введите число от 1 до 11.');
        }

        let targetRoles = [], matchMode = 'all', modeString = '';
        switch (roleChoice) {
            case '1': targetRoles = ['red', 'sheriff', 'mafia', 'don']; matchMode = 'win'; modeString = 'Все победы'; break;
            case '2': targetRoles = ['red', 'sheriff', 'mafia', 'don']; matchMode = 'loss'; modeString = 'Все поражения'; break;
            case '3': targetRoles = ['red']; modeString = 'Мирный (все игры)'; break;
            case '4': targetRoles = ['sheriff']; modeString = 'Шериф (все игры)'; break;
            case '5': targetRoles = ['mafia']; modeString = 'Маф (все игры)'; break;
            case '6': targetRoles = ['don']; modeString = 'Дон (все игры)'; break;
            case '7': targetRoles = ['red', 'sheriff']; matchMode = 'win'; modeString = 'Мирные-победы'; break;
            case '8': targetRoles = ['red', 'sheriff']; matchMode = 'loss'; modeString = 'Мирные-поражения'; break;
            case '9': targetRoles = ['mafia', 'don']; matchMode = 'win'; modeString = 'Черные-победы'; break;
            case '10': targetRoles = ['mafia', 'don']; matchMode = 'loss'; modeString = 'Черные-поражения'; break;
            case '11': targetRoles = ['red', 'sheriff', 'mafia', 'don']; modeString = 'Все игры'; break;
        }

        console.log('\n📅 Диапазон турниров (1 = самый новый):');
        const startInput = await question('👉 Начальный номер: ');
        const endInput = await question('👉 Конечный номер: ');
        rl.close();

        const startTournament = parseInt(startInput, 10);
        const endTournament = parseInt(endInput, 10);
        if (isNaN(startTournament) || isNaN(endTournament) || startTournament > endTournament || startTournament < 1) {
            console.log('❌ Неверный диапазон турниров.'); return;
        }

        console.log(`\n⏳ Запуск: [${modeString}], [${startTournament}-${endTournament}]\n`);
        const { results, playerName } = await parsePlayerHistory(
            playerUrl, targetRoles, matchMode, startTournament, endTournament
        );

        const totalGames = results.reduce((s, t) => s + t.games.length, 0);
        console.log(`\n✅ Готово! Турниров: ${results.length}, игр: ${totalGames}`);

        if (results.length) {
            const safePlayerName = playerName.replace(/[^a-zA-Zа-яА-Я0-9_-]/g, '_');
            const safeMode = modeString.replace(/\s+/g, '_').toLowerCase();

            // Общая подпапка для результатов всех игроков
            const outputDir = path.join(__dirname, 'results');
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            const filename = path.join(
                outputDir,
                `${safePlayerName}-${safeMode}_${startTournament}-${endTournament}.json`
            );
            fs.writeFileSync(filename, JSON.stringify(results, null, 2), 'utf-8');
            console.log(`💾 Сохранено: ${filename}`);

            console.log('\n📋 Сводка:');
            results.forEach(t => {
                console.log(`\n🏆 ${t.tournament} (${t.dateStart ?? '?'} – ${t.dateEnd ?? '?'})`);
                console.log(`   ⭐ ${t.star ?? '?'} | ELO ср.: ${t.elo_average ?? '?'}` + (t.type === 'team' ? ' | Командный' : ' | Личный'));
                console.log(`🔗 ${t.url}`);
                if (t.hasFinalStage) {
                    console.log(`   🏁 Финал: ${t.inFinal ? '✅ игрок в финале (место и очки — из финала)' : '❌ не прошёл в финал или не играл'}`);
                }
                (t.standings || []).forEach(s =>
                    console.log(`   📊 [${s.source}] ${s.stage}: место ${s.rank ?? '?'} | ${s.total_points ?? '?'} очков` +
                        (s.gg != null ? ` | GG: ${s.gg}` : '')));
                if (t.type === 'team' && t.team) {
                    const mt = t.team;
                    console.log(`   👥 Команда «${mt.title}» — место ${mt.place ?? '?'} из ${mt.teamsTotal ?? '?'} (Σ ${mt.sum ?? '?'}, GG ${mt.gg ?? '?'}, побед ${mt.wins ?? '?'})`);
                    mt.players.forEach(p => {
                        const mark = p.isYou ? ' ← вы' : '';
                        const contrib = p.contributionPct != null ? ` | вклад ${p.contributionPct}%` : '';
                        console.log(`     • ${p.login}${mark}: Σ ${p.sum ?? '?'}${contrib} | GG ${p.gg ?? '?'} | личное место ${p.place ?? '?'}`);
                    });
                }
                t.games.forEach(g => {
                    const r = g.isWin ? '✅ Победа' : '❌ Поражение';
                    const j = g.tableJudge ? ` | Судья: ${g.tableJudge}` : '';
                    const m = g.mvp?.length ? ` | MVP: ${g.mvp.map(x => `${x.name} (${x.points})`).join(', ')}` : '';
                    const round = g.round ? ` [${g.round}]` : '';
                    console.log(`   ├─${round} ${g.gameNumber}, ${g.tableNumber} | Роль: ${g.role}, ${r}${j}${m}`);
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