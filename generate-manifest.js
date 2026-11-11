const fs = require('fs');
const path = require('path');

const resultsDir = path.join(__dirname, 'results');
if (!fs.existsSync(resultsDir)) { console.log('Нет папки results/'); process.exit(0); }

const files = fs.readdirSync(resultsDir)
    .filter(f => f.endsWith('.json') && f !== 'index.json')
    .map(f => {
        const stat = fs.statSync(path.join(resultsDir, f));
        // "PlayerName-все_игры_all.json" → "PlayerName"
        const m = f.match(/^(.+?)-/);
        const playerName = m ? m[1].replace(/_/g, ' ') : f.replace('.json', '');
        return { filename: f, playerName, size: stat.size, modified: stat.mtime.toISOString() };
    })
    .sort((a, b) => a.playerName.localeCompare(b.playerName));

fs.writeFileSync(
    path.join(resultsDir, 'index.json'),
    JSON.stringify({ generated: new Date().toISOString(), files }, null, 2)
);
console.log(`📋 Манифест: ${files.length} файлов → results/index.json`);