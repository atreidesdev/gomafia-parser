#!/usr/bin/env node
// run.js — универсальный консольный лаунчер для всех сценариев проекта.
//
// Запуск:
//   node run.js
//   npm run launcher         (если добавить в package.json)
//
// Позволяет выбрать любой сценарий без запоминания флагов:
//   • парсинг турниров, список, удаление, обогащение, очистка несыгранных
//   • скрейп профилей игроков (одиночно и батчем из players.txt)
//   • сбор ELO в elo-cache.json (по id / url / из results)
//   • обогащение results/*.json
//   • сборка единой базы для tournament-viewer.html
//   • готовые «пайплайны» из нескольких шагов
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const ROOT = __dirname;

// ─────────────────────────────────────────────────────────────────────
// readline + spawn helpers
// ─────────────────────────────────────────────────────────────────────

let rl = null;

function ensureRl() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return rl;
}

function closeRl() {
  if (rl) {
    try { rl.close(); } catch {}
    rl = null;
    // подстрахуемся: не оставляем stdin в «странном» состоянии
    try { process.stdin.pause(); } catch {}
  }
}

function ask(q) {
  return new Promise(resolve => ensureRl().question(q, resolve));
}

async function askDefault(q, def) {
  const a = (await ask(q)).trim();
  return a || def;
}

async function askYesNo(q, def = false) {
  const prompt = `${q} [${def ? 'Y/n' : 'y/N'}]: `;
  const a = (await ask(prompt)).trim().toLowerCase();
  if (!a) return def;
  return ['y', 'yes', 'д', 'да'].includes(a);
}

async function pause(msg = '\n— Нажмите Enter для продолжения —') {
  await ask(msg);
}

function scriptExists(name) {
  const p = path.join(ROOT, name);
  if (!fs.existsSync(p)) {
    console.error(`❌ Скрипт не найден: ${p}`);
    return false;
  }
  return true;
}

/**
 * Запускает дочерний скрипт с наследованием stdin/stdout/stderr.
 * Перед запуском закрывает внешний readline, чтобы не было
 * «двойного чтения» с одного TTY. После выхода ребёнка readline
 * будет пересоздан при следующем ask().
 */
function spawnChild(script, args = []) {
  if (!scriptExists(script)) return Promise.resolve(1);
  closeRl();
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: 'inherit',
      cwd: ROOT
    });
    child.on('close', code => {
      // небольшая пауза, чтобы TTY-буферы ребёнка «отпустили» stdin
      setTimeout(() => resolve(code || 0), 120);
    });
    child.on('error', err => {
      console.error(`❌ Ошибка запуска ${script}: ${err.message}`);
      setTimeout(() => resolve(1), 120);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// МЕНЮ
// ─────────────────────────────────────────────────────────────────────

function printHeader() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║   🏆  Gomafia Parser — универсальный лаунчер                  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
}

function printMenu() {
  console.log(`
  ── ТУРНИРЫ ──────────────────────────────────────────────────
   1. 📥 Парсить турниры                  (интерактивное меню)
   2. 📋 Список турниров в базе
   3. 🗑️  Удалить турниры из базы
   4. ✨ Обогатить ELO в базе              (--enrich-only)
   5. 🧹 Очистить несыгранные столы        (--fix-unplayed)

  ── ИГРОКИ ───────────────────────────────────────────────────
   6. 🕵️  Скрейп истории игрока / батч из players.txt

  ── ELO ──────────────────────────────────────────────────────
   7. 🌐 Собрать ELO в elo-cache.json      (buildEloCache)
   8. 📊 Обогатить ELO в results/*.json    (enrichTournaments)

  ── VIEWER ───────────────────────────────────────────────────
   9. 🔗 Слить results → tournaments-db.json  (merge-for-viewer)

  ── ПАЙПЛАЙНЫ ────────────────────────────────────────────────
  10. 🚀 С игроков: scraper → buildEloCache → enrich → merge
  11. 🚀 С турниров: tournament-parser → enrich
  12. 📊 Только ELO: buildEloCache --from-results → enrich

  ── ПРОЧЕЕ ───────────────────────────────────────────────────
  13. 📁 Показать содержимое ./results
  14. ℹ️  Справка по сценариям
   0. 🚪 Выход
`);
}

// ─────────────────────────────────────────────────────────────────────
// ХЭНДЛЕРЫ — турниры
// ─────────────────────────────────────────────────────────────────────

async function hParseTournaments() {
  await spawnChild('tournament-parser.js');
}

async function hListTournaments() {
  await spawnChild('tournament-parser.js', ['--list']);
}

async function hRemoveTournaments() {
  const raw = (await ask('ID турниров (через запятую/пробел; Enter=интерактивно): ')).trim();
  if (!raw) {
    await spawnChild('tournament-parser.js', ['--remove']);
  } else {
    const ids = raw.split(/[\s,]+/).filter(Boolean);
    await spawnChild('tournament-parser.js', ['--remove', ...ids]);
  }
}

async function hEnrichDB() {
  await spawnChild('tournament-parser.js', ['--enrich-only']);
}

async function hFixUnplayed() {
  await spawnChild('tournament-parser.js', ['--fix-unplayed']);
}

// ─────────────────────────────────────────────────────────────────────
// ХЭНДЛЕРЫ — игроки
// ─────────────────────────────────────────────────────────────────────

async function hScrapePlayers() {
  console.log('\nℹ️  Внутри scraper.js есть интерактивное меню (1–14):');
  console.log('   • одиночные режимы 1–12 — с вводом ссылки и диапазона');
  console.log('   • 13 — батч ВСЕ турниры всех игроков из players.txt (полная перезапись)');
  console.log('   • 14 — батч только НОВЫЕ турниры игроков из players.txt');
  if (!fs.existsSync(path.join(ROOT, 'players.txt'))) {
    console.log('\n⚠️ players.txt не найден — для режимов 13/14 создайте его рядом со scraper.js');
    console.log('   Формат: одна ссылка на профиль в строке, строки с # или // — комментарии');
  }
  await pause();
  await spawnChild('scraper.js');
}

// ─────────────────────────────────────────────────────────────────────
// ХЭНДЛЕРЫ — ELO
// ─────────────────────────────────────────────────────────────────────

async function hBuildElo() {
  console.log('\nИсточник задач для сбора ELO:');
  console.log('  1. По ID (диапазон/список)');
  console.log('  2. По ссылкам на профили');
  console.log('  3. Из ./results  (--from-results)');
  const src = (await askDefault('Выбор [3]: ', '3')).trim();

  const args = [];
  if (src === '1') {
    const spec = (await ask('Список ID (напр. 1-10000,5,7000-7500): ')).trim();
    if (!spec) { console.log('⚠️ Пустой список — отмена.'); return; }
    args.push('--ids', spec);
  } else if (src === '2') {
    const urls = (await ask('URLs через запятую: ')).trim();
    if (!urls) { console.log('⚠️ Пустой список — отмена.'); return; }
    args.push('--urls', urls);
  } else {
    const dir = (await askDefault('Папка (Enter = ./results): ', './results')).trim();
    if (!fs.existsSync(path.join(ROOT, dir))) {
      console.log(`⚠️ Папка не существует: ${dir}`);
      if (!(await askYesNo('Продолжить всё равно?', false))) return;
    }
    args.push('--from-results', dir);
  }

  if (await askYesNo('Перезаписать существующих в кэше? (--force)', false)) {
    args.push('--force');
  }
  const concStr = (await ask('Параллельность (Enter = 5): ')).trim();
  if (concStr && !isNaN(+concStr)) args.push('--concurrency', concStr);

  const delayStr = (await ask('Задержка мс (Enter = 200): ')).trim();
  if (delayStr && !isNaN(+delayStr)) args.push('--delay', delayStr);

  await spawnChild('buildEloCache.js', args);
}

async function hEnrichResults() {
  if (!fs.existsSync(path.join(ROOT, 'results'))) {
    console.log('❌ Папка ./results не существует.');
    return;
  }
  console.log('\nℹ️  enrichTournaments.js обрабатывает ./results/*.json');
  console.log('   и пишет рядом файлы *_enriched.json с ELO игроков и averageElo столов.');
  if (!(await askYesNo('Запустить?', true))) return;
  await spawnChild('enrichTournaments.js');
}

// ─────────────────────────────────────────────────────────────────────
// ХЭНДЛЕРЫ — merge для viewer
// ─────────────────────────────────────────────────────────────────────

async function hMerge() {
  const input  = (await askDefault('Вход (папка или файл, Enter=./results): ', './results')).trim();
  const output = (await askDefault('Выход (Enter=tournaments-db.json): ', 'tournaments-db.json')).trim();
  const withStandings = await askYesNo('Включить таблицы результатов? (--with-standings)', false);

  if (!fs.existsSync(path.join(ROOT, input))) {
    console.log(`⚠️ Путь не найден: ${input}`);
    return;
  }

  const args = ['-i', input, '-o', output];
  if (withStandings) args.push('--with-standings');

  await spawnChild('merge-for-viewer.js', args);
}

// ─────────────────────────────────────────────────────────────────────
// ХЭНДЛЕРЫ — пайплайны
// ─────────────────────────────────────────────────────────────────────

async function hPipelinePlayers() {
  console.log('\n🚀 Пайплайн с игроков:');
  console.log('   Шаг 1. scraper.js  — интерактивно выберите режим (13/14 для батча)');
  console.log('   Шаг 2. buildEloCache --from-results ./results');
  console.log('   Шаг 3. enrichTournaments.js  (обогащение results/*.json)');
  console.log('   Шаг 4. merge-for-viewer -i ./results -o tournaments-db.json');
  if (!(await askYesNo('\nПродолжить?', true))) return;

  if (!fs.existsSync(path.join(ROOT, 'results'))) {
    fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
  }

  console.log('\n═══ ШАГ 1/4: Скрейп игроков ═══');
  await spawnChild('scraper.js');

  console.log('\n═══ ШАГ 2/4: Сбор ELO из results ═══');
  await spawnChild('buildEloCache.js', ['--from-results', './results']);

  console.log('\n═══ ШАГ 3/4: Обогащение results/*.json ═══');
  await spawnChild('enrichTournaments.js');

  console.log('\n═══ ШАГ 4/4: Слияние в tournaments-db.json ═══');
  await spawnChild('merge-for-viewer.js', ['-i', './results', '-o', 'tournaments-db.json']);

  console.log('\n✅ Пайплайн завершён.');
  console.log('   💡 Откройте tournament-viewer.html и загрузите tournaments-db.json');
}

async function hPipelineTournaments() {
  console.log('\n🚀 Пайплайн с турниров:');
  console.log('   Шаг 1. tournament-parser.js — интерактивно введите ID/URL турниров');
  console.log('   Шаг 2. tournament-parser.js --enrich-only — добавить ELO в базу');
  if (!(await askYesNo('\nПродолжить?', true))) return;

  console.log('\n═══ ШАГ 1/2: Парсинг турниров ═══');
  await spawnChild('tournament-parser.js');

  console.log('\n═══ ШАГ 2/2: Обогащение ELO ═══');
  await spawnChild('tournament-parser.js', ['--enrich-only']);

  console.log('\n✅ Готово. База сохранена в tournaments-db.json');
}

async function hPipelineEloOnly() {
  const dir = (await askDefault('Папка с результатами (Enter=./results): ', './results')).trim();
  if (!fs.existsSync(path.join(ROOT, dir))) {
    console.log(`⚠️ Папка не существует: ${dir}`);
    return;
  }
  const force = await askYesNo('Перезаписать существующих в кэше?', false);

  console.log('\n═══ ШАГ 1/2: Сбор ELO в elo-cache.json ═══');
  const args = ['--from-results', dir];
  if (force) args.push('--force');
  await spawnChild('buildEloCache.js', args);

  console.log('\n═══ ШАГ 2/2: Обогащение results/*.json ═══');
  await spawnChild('enrichTournaments.js');

  console.log('\n✅ Готово.');
}

// ─────────────────────────────────────────────────────────────────────
// ХЭНДЛЕРЫ — утилиты
// ─────────────────────────────────────────────────────────────────────

async function hShowResults() {
  const dir = path.join(ROOT, 'results');
  if (!fs.existsSync(dir)) {
    console.log('📭 Папка ./results не существует.');
    return;
  }
  const files = fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.json') && !f.includes('_enriched'));

  if (!files.length) {
    console.log('📭 В ./results нет JSON-файлов.');
    return;
  }

  console.log(`\n📂 results/: ${files.length} файлов\n`);
  let totalTournaments = 0;
  let totalGames = 0;
  for (const f of files) {
    const full = path.join(dir, f);
    const size = (fs.statSync(full).size / 1024).toFixed(1);
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf-8'));
      if (!Array.isArray(data)) {
        console.log(`  • ${f} — ⚠️ не массив (${size} KB)`);
        continue;
      }
      let games = 0;
      data.forEach(t => { games += (t.games || []).length; });
      totalTournaments += data.length;
      totalGames += games;
      console.log(`  • ${f} — ${data.length} турниров, ${games} игр (${size} KB)`);
    } catch (e) {
      console.log(`  • ${f} — ⚠️ ошибка чтения: ${e.message} (${size} KB)`);
    }
  }
  console.log(`\n📊 Итого: ${totalTournaments} турниров, ${totalGames} игр`);
}

function hHelp() {
  console.log(`
ℹ️  СЦЕНАРИИ И ФЛАГИ

📥 tournament-parser.js
   • node tournament-parser.js                 — интерактивное меню
   • node tournament-parser.js 2659 2760 …     — прямой скрейп ID/URL
   • node tournament-parser.js --file list.txt — из файла
   • node tournament-parser.js --auto          — tournaments.txt рядом со скриптом
   • … --force                                 — перезаписать существующие
   • … --list                                  — список турниров в базе
   • … --remove 2659 2760 / --remove=2659,2760 — удалить из базы
   • … --enrich-only                           — только обогатить ELO
   • … --fix-unplayed                          — очистить несыгранные столы

🌐 buildEloCache.js
   • --from-results ./results                  — собрать ELO всех игроков из results
   • --ids 1-10000,5,7000-7500                 — по диапазонам ID
   • --urls "https://gomafia.pro/stats/616,…"  — по ссылкам
   • --from-id 1 --to-id 10000                 — по непрерывному диапазону
   • --force                                   — перезаписать существующих
   • --concurrency N --delay MS                — управление нагрузкой

📊 enrichTournaments.js
   • Читает ./results/*.json, добавляет ELO игрокам и averageElo столам
   • Пишет рядом файлы *_enriched.json (не перезаписывает исходные)

🔗 merge-for-viewer.js
   • -i DIR|FILE  -o FILE  --with-standings
   • Собирает единую базу для tournament-viewer.html

🕵️  scraper.js
   • Интерактивно: режимы 1–12 (одиночно), 13/14 (батч из players.txt)

⚙️  Переменные окружения
   • ELO_CACHE=/path/elo-cache.json
   • TOURNAMENTS_DB=/path/tournaments-db.json
   • PLAYERS_FILE=/path/players.txt
   • DEBUG_LH=1  (подробный отладочный вывод ЛХ в scraper.js)
`);
}

// ─────────────────────────────────────────────────────────────────────
// DISPATCH + MAIN
// ─────────────────────────────────────────────────────────────────────

async function dispatch(choice) {
  switch (choice) {
    case '0': return 'exit';
    case '1': await hParseTournaments(); break;
    case '2': await hListTournaments(); break;
    case '3': await hRemoveTournaments(); break;
    case '4': await hEnrichDB(); break;
    case '5': await hFixUnplayed(); break;
    case '6': await hScrapePlayers(); break;
    case '7': await hBuildElo(); break;
    case '8': await hEnrichResults(); break;
    case '9': await hMerge(); break;
    case '10': await hPipelinePlayers(); break;
    case '11': await hPipelineTournaments(); break;
    case '12': await hPipelineEloOnly(); break;
    case '13': await hShowResults(); break;
    case '14': hHelp(); break;
    default:   console.log(`❓ Неизвестный пункт: ${choice}`);
  }
}

async function main() {
  // Быстрые CLI-флаги (можно использовать в скриптах/CI)
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    hHelp();
    return;
  }
  if (argv.includes('--status')) {
    printHeader();
    await hShowResults();
    return;
  }

  while (true) {
    printHeader();
    printMenu();
    let choice = '';
    try {
      choice = (await ask('👉 Выбор: ')).trim() || '0';
    } catch {
      break;
    }
    try {
      const handled = await dispatch(choice);
      if (handled === 'exit') break;
      // после любого сценария — пауза, чтобы успеть прочитать вывод
      await pause();
    } catch (e) {
      console.error(`❌ ${e.message}`);
      await pause();
    }
  }
  closeRl();
  console.log('👋 До встречи!');
}

main().catch(err => {
  console.error('❌ Фатальная ошибка:', err);
  closeRl();
  process.exit(1);
});