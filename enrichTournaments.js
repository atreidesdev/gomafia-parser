const fs = require('fs');
const path = require('path');
const eloCache = require('./eloCache');

function enrichDirectory(dir) {
  const cache = eloCache.load();
  const playersCount = Object.keys(cache.players).length;
  console.log(`📚 Загружено игроков из базы elo-cache.json: ${playersCount}`);

  if (!fs.existsSync(dir)) {
    console.error(`❌ Папка не найдена: ${dir}`);
    return;
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('_enriched'));
  if (files.length === 0) {
    console.log('⚠️ В папке результатов не найдено JSON-файлов.');
    return;
  }

  for (const file of files) {
    const filePath = path.join(dir, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      console.error(`⚠️ Ошибка чтения файла ${file}:`, e.message);
      continue;
    }

    if (!Array.isArray(data)) continue;

    let totalGamesUpdated = 0;

    for (const t of data) {
      if (!Array.isArray(t.games)) continue;
      for (const g of t.games) {
        if (!Array.isArray(g.composition)) continue;

        let eloSum = 0;
        let eloCount = 0;

        for (const p of g.composition) {
          if (!p || !p.name) continue;
          const cached = eloCache.get(cache, p.name);
          if (cached && cached.elo != null) {
            p.elo = cached.elo;
            eloSum += cached.elo;
            eloCount++;
          }
        }

        // Вычисляем среднее ELO стола по игрокам, у которых есть ELO в базе
        if (eloCount > 0) {
          g.averageElo = Math.round(eloSum / eloCount);
        } else {
          g.averageElo = null;
        }
        totalGamesUpdated++;
      }
    }

    // Сохраняем обновленный файл (можно перезаписывать исходный или сохранять с суффиксом)
    const outPath = path.join(dir, file.replace('.json', '_enriched.json'));
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`✅ Файл обработан: ${file} -> сохранён как ${path.basename(outPath)} (обработано игр: ${totalGamesUpdated})`);
  }
}

enrichDirectory(path.join(__dirname, 'results'));