const { chromium } = require('playwright');
const fs = require('fs');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

const ROLE_NAMES = {
  'red': 'Мирный',
  'sheriff': 'Шериф',
  'mafia': 'Маф',
  'don': 'Дон'
};

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
      if (currentPage > 1) {
        targetUrl.searchParams.set('page', currentPage.toString());
      }

      console.log(`\n📄 Загрузка страницы истории (стр. ${currentPage}): ${targetUrl.toString()}`);
      await page.goto(targetUrl.toString(), { waitUntil: 'networkidle', timeout: 30000 });

      const rows = await page.$$('table tbody tr');
      if (rows.length === 0) {
        console.log('⚠️ Таблица турниров не найдена или список закончился.');
        break;
      }

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

          const content = await tournamentPage.content();
          const scriptMatch = content.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/);
          
          if (!scriptMatch) {
            console.warn(`  ⚠️ Не удалось найти данные JSON для турнира.`);
            continue;
          }

          const data = JSON.parse(scriptMatch[1]);
          const serverData = data.props.pageProps.serverData;
          const gamesData = serverData.games;
          
          const tournamentInfo = serverData.tournament || {};
          const dateStart = tournamentInfo.date_start || null;
          const dateEnd = tournamentInfo.date_end || null;

          if (!gamesData) continue;

          const matchingGames = [];

          for (const game of gamesData) {
            const gameNum = game.gameNum;
            
            for (const table of game.game) {
              const tableNum = table.tableNum;
              const winCode = table.win;
              
              const playerRecord = table.table.find(p => p.login.toLowerCase() === playerName.toLowerCase());
              
              if (playerRecord) {
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

                if (isMatch) {
                  const composition = table.table.map(p => {
                    const isTarget = p.login.toLowerCase() === playerName.toLowerCase();
                    return {
                      name: p.login,
                      role: ROLE_NAMES[p.role] || p.role,
                      isYou: isTarget,
                      playType: p.type || 'n',
                      points: typeof p.points === 'number' ? p.points : 0
                    };
                  });

                  matchingGames.push({
                    gameNumber: `Игра ${gameNum}`,
                    tableNumber: `Стол ${tableNum}`,
                    role: ROLE_NAMES[roleCode] || roleCode,
                    winner: winCode === 'city' ? 'Мирные' : 'Мафия',
                    isWin: isWin,
                    composition: composition
                  });
                }
              }
            }
          }

          if (matchingGames.length > 0) {
            results.push({
              tournament: tournamentName,
              url: tournamentUrl,
              dateStart: dateStart,
              dateEnd: dateEnd,
              games: matchingGames
            });
            console.log(`  ✅ Найдено совпадений: ${matchingGames.length}`);
          }

        } catch (err) {
          console.error(`  ❌ Ошибка при обработке турнира ${tournamentName}:`, err.message);
        } finally {
          await tournamentPage.close();
        }
      }

      if (shouldContinue) {
        const nextPageBtn = await page.$('.Pagination_pagination__page___s0V8:not(.Pagination_pagination__page-selected__8gXVU)');
        if (!nextPageBtn) {
          console.log('\n🏁 Достигнут конец списка турниров (нет следующей страницы).');
          break;
        }
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

(async () => {
  console.log('🕵️ Парсер статистики gomafia.pro (Интерактивный режим)');
  console.log('=======================================================');

  try {
    const playerUrl = await question('🔗 Введите ссылку на профиль (например, https://gomafia.pro/stats/1373): ');

    console.log('\n🎭 Выберите режим поиска:');
    console.log('  1. Все победы (любая роль)');
    console.log('  2. Все поражения (любая роль)');
    console.log('  3. Мирный (все игры: победы и поражения)');
    console.log('  4. Шериф (все игры: победы и поражения)');
    console.log('  5. Маф (все игры: победы и поражения)');
    console.log('  6. Дон (все игры: победы и поражения)');
    console.log('  7. Мирные (только победы)');
    console.log('  8. Мирные (только поражения)');
    console.log('  9. Черные (только победы)');
    console.log(' 10. Черные (только поражения)');
    console.log(' 11. Все игры (все роли, просто все игры игрока)');
    
    let roleChoice = '';
    const validChoices = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'];
    while (!validChoices.includes(roleChoice)) {
      roleChoice = (await question('👉 Введите номер варианта (1-11): ')).trim();
      if (!validChoices.includes(roleChoice)) {
        console.log('❌ Неверный ввод. Пожалуйста, введите число от 1 до 11.');
      }
    }

    let targetRoles = [];
    let matchMode = 'all'; 
    let modeString = '';

    switch (roleChoice) {
      case '1': targetRoles = ['red', 'sheriff', 'mafia', 'don']; matchMode = 'win'; modeString = 'Все победы'; break;
      case '2': targetRoles = ['red', 'sheriff', 'mafia', 'don']; matchMode = 'loss'; modeString = 'Все поражения'; break;
      case '3': targetRoles = ['red']; matchMode = 'all'; modeString = 'Мирный (все игры)'; break;
      case '4': targetRoles = ['sheriff']; matchMode = 'all'; modeString = 'Шериф (все игры)'; break;
      case '5': targetRoles = ['mafia']; matchMode = 'all'; modeString = 'Маф (все игры)'; break;
      case '6': targetRoles = ['don']; matchMode = 'all'; modeString = 'Дон (все игры)'; break;
      case '7': targetRoles = ['red', 'sheriff']; matchMode = 'win'; modeString = 'Мирные-победы'; break;
      case '8': targetRoles = ['red', 'sheriff']; matchMode = 'loss'; modeString = 'Мирные-поражения'; break;
      case '9': targetRoles = ['mafia', 'don']; matchMode = 'win'; modeString = 'Черные-победы'; break;
      case '10': targetRoles = ['mafia', 'don']; matchMode = 'loss'; modeString = 'Черные-поражения'; break;
      case '11': targetRoles = ['red', 'sheriff', 'mafia', 'don']; matchMode = 'all'; modeString = 'Все игры'; break;
    }

    console.log('\n📅 Укажите диапазон турниров (1 = самый новый в списке):');
    const startInput = await question('👉 Начальный номер турнира: ');
    const endInput = await question('👉 Конечный номер турнира: ');

    rl.close();

    const startTournament = parseInt(startInput, 10);
    const endTournament = parseInt(endInput, 10);

    if (isNaN(startTournament) || isNaN(endTournament) || startTournament > endTournament || startTournament < 1) {
      console.log('❌ Ошибка: Неверный диапазон турниров.');
      return;
    }

    console.log(`\n⏳ Запуск парсинга...`);
    console.log(`Параметры: Режим=[${modeString}], Диапазон=[${startTournament}-${endTournament}]\n`);
    
    const { results, playerName } = await parsePlayerHistory(
      playerUrl, 
      targetRoles, 
      matchMode, 
      startTournament, 
      endTournament
    );
    
    const totalGamesFound = results.reduce((sum, tournament) => sum + tournament.games.length, 0);

    console.log(`\n✅ Обработка завершена!`);
    console.log(`📊 Найдено подходящих турниров: ${results.length}`);
    console.log(`🎮 Всего найдено совпадений (игр): ${totalGamesFound}`);

    if (results.length > 0) {
      const safePlayerName = playerName.replace(/[^a-zA-Zа-яА-Я0-9_-]/g, '_');
      const safeMode = modeString.replace(/\s+/g, '_').toLowerCase();
      const filename = `${safePlayerName}-${safeMode}_${startTournament}-${endTournament}.json`;
      
      fs.writeFileSync(filename, JSON.stringify(results, null, 2), 'utf-8');
      console.log(`💾 Данные успешно сохранены в файл: ${filename}`);
      
      console.log('\n📋 Краткая сводка:');
      results.forEach(t => {
        console.log(`\n🏆 ${t.tournament} (${t.dateStart} – ${t.dateEnd})`);
        console.log(`🔗 ${t.url}`);
        t.games.forEach(g => {
          const resultText = g.isWin ? '✅ Победа' : '❌ Поражение';
          console.log(`   ├─ ${g.gameNumber}, ${g.tableNumber} | Роль: ${g.role}, ${resultText}`);
        });
      });
    } else {
      console.log('⚠️ Совпадений не найдено в указанном диапазоне.');
    }

  } catch (error) {
    console.error('❌ Произошла ошибка при выполнении:', error);
    rl.close();
  }
})();