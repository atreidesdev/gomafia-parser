#!/usr/bin/env node
// merge-for-viewer.js
// Объединяет результаты scraper.js в tournaments-db.json для tournament-viewer.html
//
// Использование:
//   node merge-for-viewer.js                        # ./results → ./tournaments-db.json
//   node merge-for-viewer.js -i path/to/results     # своя папка
//   node merge-for-viewer.js -i file.json           # один файл
//   node merge-for-viewer.js -o db.json             # своё имя выходного файла
//   node merge-for-viewer.js --with-standings       # включить таблицы результатов

const fs = require('fs');
const path = require('path');

const ROLE_NAMES = { red: 'Мирный', sheriff: 'Шериф', mafia: 'Маф', don: 'Дон' };

// ===== CLI =====
function parseArgs() {
    const args = process.argv.slice(2);
// стало
const opts = {
    input: path.join(__dirname, 'results'),
    output: path.join(__dirname, 'viewer-db.json'),
    withStandings: false,
};
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--input' || a === '-i') opts.input = args[++i];
        else if (a === '--output' || a === '-o') opts.output = args[++i];
        else if (a === '--with-standings') opts.withStandings = true;
        else if (a === '--help' || a === '-h') {
            console.log('Использование: node merge-for-viewer.js [опции]');
            console.log('  --input, -i DIR|FILE   Папка с JSON или один файл (по умолчанию ./results)');
            console.log('  --output, -o FILE      Куда сохранить (по умолчанию ./tournaments-db.json)');
            console.log('  --with-standings       Включить таблицы результатов (по умолчанию пропускаются)');
            process.exit(0);
        }
    }
    return opts;
}

// ===== Утилиты =====
function extractTournamentId(url) {
    if (!url) return null;
    const m = String(url).match(/\/tournament\/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}

function extractNum(val) {
    if (val === null || val === undefined) return null;
    const m = String(val).match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
}

function convertWinner(w) {
    if (!w) return null;
    const s = String(w).toLowerCase();
    if (s === 'city' || s.includes('мирн')) return 'city';
    if (s === 'mafia' || s.includes('маф')) return 'mafia';
    return null;
}

function getPlayerNameFromTours(tours) {
    for (const t of tours) if (t.playerName) return t.playerName;
    for (const t of tours) {
        for (const g of (t.games || [])) {
            const me = (g.composition || []).find(p => p.isYou);
            if (me) return me.name;
        }
    }
    return null;
}

// ===== Конвертация standings (только при --with-standings) =====
function convertStandingRow(s, playerLogin) {
    return {
        login: s.login || playerLogin || '',
        place: s.rank ?? s.place ?? null,
        sum: s.total_points ?? s.sum ?? null,
        sum_extra: s.sum_db ?? s.sum_extra ?? null,
        plus: s.plus ?? null,
        minus: s.minus ?? null,
        first_kill_point: s.first_kill_point ?? null,
        compensation_point: s.compensation_point ?? null,
        wins: s.wins ?? null,
        wins_as_don: s.wins_as_don ?? null,
        wins_as_sheriff: s.wins_as_sheriff ?? null,
        first_kill: s.first_kill ?? null,
        gg: s.gg ?? null,
        elo_delta: s.elo_delta ?? null,
        is_paid: s.is_paid ?? false,
    };
}

function convertTeam(t) {
    if (!t) return null;
    const users = (t.players || []).map(p => {
        const full = (p.fullName || '').trim();
        const idx = full.indexOf(' ');
        return {
            login: p.login,
            firstName: idx > 0 ? full.slice(0, idx) : (full || null),
            lastName: idx > 0 ? full.slice(idx + 1) : null,
        };
    });
    return {
        title: t.title,
        place: t.place,
        sum: t.sum,
        sum_extra: t.sum_db ?? null,
        plus: t.plus ?? null,
        minus: t.minus ?? null,
        gg: t.gg ?? null,
        wins: t.wins ?? null,
        wins_as_don: t.wins_as_don ?? null,
        wins_as_sheriff: t.wins_as_sheriff ?? null,
        first_kill: t.first_kill ?? null,
        order_sum: t.sum ?? 0,
        order_global_game: t.gg ?? 0,
        order_win_as_sheriff_and_don: (t.wins_as_sheriff || 0) + (t.wins_as_don || 0),
        users,
    };
}

// ===== Конвертация одного турнира =====
function convertTournament(scraper, opts) {
    const playerLogin = opts._playerLogin;

    // Группируем плоские игры (столы) в игры {gameNumber, round, tables[]}
    const gamesMap = new Map();
    (scraper.games || []).forEach(g => {
        const gameNum = extractNum(g.gameNumber);
        const tableNum = extractNum(g.tableNumber);
        if (gameNum === null || tableNum === null) return;

        const players = (g.composition || []).map(p => {
            let lhStatus = p.lhStatus || null;
            let isFirstKill = !!p.isFirstKill;
            if (g.firstKill && g.firstKill.name === p.name) {
                isFirstKill = true;
                if (!lhStatus) lhStatus = g.firstKill.lhStatus || null;
            }
            return {
                login: p.name,
                role: p.role,             // уже по-русски из scraper.js
                roleName: p.role,
                playType: p.playType || 'n',
                points: typeof p.points === 'number' ? p.points : 0,
                lhStatus,
                isFirstKill,
                elo: typeof p.elo === 'number' ? p.elo : null,
            };
        });

        const elos = players.map(p => p.elo).filter(e => typeof e === 'number');
        const averageElo = elos.length > 0
            ? Math.round(elos.reduce((a, b) => a + b, 0) / elos.length)
            : null;

        const table = {
            tableNumber: tableNum,
            judge: g.tableJudge || null,
            winner: convertWinner(g.winner) || 'city',
            averageElo,
            players,
        };

        if (!gamesMap.has(gameNum)) {
            gamesMap.set(gameNum, {
                gameNumber: gameNum,
                round: g.round || 'Отбор',
                tables: [],
            });
        }
        const ge = gamesMap.get(gameNum);
        if (!ge.tables.find(tb => tb.tableNumber === tableNum)) {
            ge.tables.push(table);
        }
    });

    const games = Array.from(gamesMap.values()).sort((a, b) => a.gameNumber - b.gameNumber);
    games.forEach(g => g.tables.sort((a, b) => (a.tableNumber || 0) - (b.tableNumber || 0)));

    const qualifying = games.filter(g => g.round === 'Отбор').length;
    const semi = games.filter(g => g.round === 'Полуфинал').length;
    const final = games.filter(g => g.round === 'Финал').length;

    const standings = { withFinal: [], withoutFinal: [] };
    if (opts.withStandings) {
        (scraper.standings || []).forEach(s => {
            const row = convertStandingRow(s, playerLogin);
            if (s.stage && /отбор|не прошёл/i.test(s.stage)) standings.withoutFinal.push(row);
            else standings.withFinal.push(row);
        });
    }

    const teams = [];
    if (scraper.team) {
        const ct = convertTeam(scraper.team);
        if (ct) teams.push(ct);
    }

    return {
        id: extractTournamentId(scraper.url),
        tournament: scraper.tournament,
        url: scraper.url,
        dateStart: scraper.dateStart,
        dateEnd: scraper.dateEnd,
        type: scraper.type,
        typeTranslate:
            scraper.type === 'team' ? 'Командный'
            : scraper.type === 'individual' ? 'Индивидуальный'
            : (scraper.type || null),
        star: scraper.star,
        elo_average: scraper.elo_average,
        country: null,
        city: null,
        hasFinalStage: !!scraper.hasFinalStage,
        inFinal: !!scraper.inFinal,
        scheme: { qualifying, semi, final },
        standings,
        teams,
        games,
    };
}

// ===== Чтение =====
function readFiles(input) {
    const st = fs.statSync(input);
    if (st.isFile()) return [input];
    return fs.readdirSync(input)
        .filter(f => f.toLowerCase().endsWith('.json'))
        .map(f => path.join(input, f));
}

// ===== main =====
function main() {
    const opts = parseArgs();

    if (!fs.existsSync(opts.input)) {
        console.error(`❌ Путь не найден: ${opts.input}`);
        process.exit(1);
    }

    const files = readFiles(opts.input);
    console.log(`📂 Файлов: ${files.length}`);

    const byId = new Map();
    let filesRead = 0, toursSeen = 0;

    for (const file of files) {
        let data;
        try {
            data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        } catch (e) {
            console.warn(`  ⚠️  ${path.basename(file)}: ${e.message}`);
            continue;
        }
        if (!Array.isArray(data)) {
            console.warn(`  ⚠️  ${path.basename(file)}: не массив`);
            continue;
        }
        filesRead++;

        const playerLogin = getPlayerNameFromTours(data);
        data.forEach(t => {
            const id = extractTournamentId(t.url) || t.url || t.tournament;
            if (!id) return;
            toursSeen++;
            if (!byId.has(id)) byId.set(id, []);
            byId.get(id).push({ tournament: t, playerLogin });
        });
    }

    console.log(`📋 Прочитано файлов: ${filesRead}`);
    console.log(`📋 Турниров (с дублями): ${toursSeen}, уникальных: ${byId.size}`);

    const result = [];
    let totalGames = 0, totalTables = 0, dropped = 0;

    for (const [, entries] of byId) {
        // «Основным» берём турнир с наибольшим числом игр
        entries.sort((a, b) =>
            (b.tournament.games?.length || 0) - (a.tournament.games?.length || 0)
        );
        const primary = entries[0].tournament;
        const playerLogin = entries[0].playerLogin;

        // Склеиваем игры из всех файлов (дедуп по game|table)
        const mergedGames = [];
        const keys = new Set();
        for (const entry of entries) {
            for (const g of (entry.tournament.games || [])) {
                const key = `${extractNum(g.gameNumber)}|${extractNum(g.tableNumber)}`;
                if (keys.has(key)) continue;
                keys.add(key);
                mergedGames.push(g);
            }
        }

        const conv = convertTournament(
            { ...primary, games: mergedGames },
            { withStandings: opts.withStandings, _playerLogin: playerLogin }
        );

        if (conv.games.length === 0) { dropped++; continue; }

        totalGames += conv.games.length;
        conv.games.forEach(g => totalTables += g.tables.length);
        result.push(conv);
    }

    result.sort((a, b) => (b.dateStart || '').localeCompare(a.dateStart || ''));

    if (dropped) console.log(`⚠️  Пропущено турниров без валидных игр: ${dropped}`);
    console.log(`✅ Турниров в базе: ${result.length}`);
    console.log(`🎮 Игр: ${totalGames}, столов: ${totalTables}`);

    fs.writeFileSync(opts.output, JSON.stringify(result, null, 2), 'utf-8');
    console.log(`💾 Сохранено: ${opts.output}`);
    console.log(`\n💡 Откройте tournament-viewer.html и загрузите ${path.basename(opts.output)}`);
}

main();