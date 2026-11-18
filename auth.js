// auth.js — единая точка авторизации на gomafia.pro
// Источники кредов (по приоритету):
//   1) --login=X --password=Y (CLI)
//   2) .env файл рядом со скриптами (GOMAFIA_LOGIN=... / GOMAFIA_PASSWORD=...)
//   3) process.env (GOMAFIA_LOGIN / GOMAFIA_PASSWORD)
//   4) интерактивный ввод (при первом обращении)
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const BASE_URL = 'https://gomafia.pro';
const LOGIN_PATH = '/login';

let cached = null;
let promptedOnce = false;

// ---------- загрузка .env (без зависимостей) ----------
(function loadDotEnv() {
    try {
        const p = path.join(__dirname, '.env');
        if (!fs.existsSync(p)) return;
        const content = fs.readFileSync(p, 'utf-8');
        for (const line of content.split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
            if (!m) continue;
            const key = m[1];
            let val = m[2].trim();
            if ((val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            if (!process.env[key]) process.env[key] = val;
        }
    } catch { /* ignore */ }
})();

function parseCliCreds(argv) {
    const out = { login: null, password: null };
    for (const a of argv) {
        if (a.startsWith('--login=')) out.login = a.slice('--login='.length);
        else if (a.startsWith('--password=')) out.password = a.slice('--password='.length);
    }
    return out;
}

function getCredentials() {
    if (cached && cached.login && cached.password) return cached;

    const fromArgs = parseCliCreds(process.argv.slice(2));
    const login = fromArgs.login || process.env.GOMAFIA_LOGIN || null;
    const password = fromArgs.password || process.env.GOMAFIA_PASSWORD || null;

    if (login && password) cached = { login, password };
    return { login, password };
}

function hasCredentials() {
    const c = getCredentials();
    return Boolean(c.login && c.password);
}

function setCredentials(login, password) {
    cached = { login, password };
}

async function promptCredentials() {
    if (promptedOnce) {
        const c = getCredentials();
        if (c.login && c.password) return c;
    }
    promptedOnce = true;

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(r => rl.question(q, r));
    try {
        console.log('\n🔐 Требуется авторизация на gomafia.pro');
        console.log('   (креды можно задать заранее: --login=X --password=Y,');
        console.log('    env GOMAFIA_LOGIN / GOMAFIA_PASSWORD, или .env файл)\n');
        const login = (await ask('   Логин: ')).trim();
        const password = (await ask('   Пароль: ')).trim();
        if (!login || !password) throw new Error('Логин и пароль обязательны');
        setCredentials(login, password);
        return getCredentials();
    } finally {
        try { rl.close(); } catch { /* noop */ }
    }
}

function isLoginUrl(url) {
    try {
        const u = new URL(url);
        return u.pathname === LOGIN_PATH || u.pathname === LOGIN_PATH + '/';
    } catch {
        return String(url).includes(LOGIN_PATH);
    }
}

async function login(page, credentials) {
    const creds = credentials || getCredentials();
    if (!creds.login || !creds.password) throw new Error('Нет логина/пароля');

    if (!isLoginUrl(page.url())) return true;

    console.log(`🔐 Вход как «${creds.login}»...`);

    const loginSelectors = [
        'input[placeholder="Введите никнейм"]',
        'input[placeholder*="никнейм" i]',
        'input[type="text"]',
        'input[name="login"]',
        'input[name="username"]'
    ];
    const pwdSelectors = ['input[type="password"]'];

    let loginInput = null;
    for (const sel of loginSelectors) {
        loginInput = await page.$(sel);
        if (loginInput) break;
    }
    if (!loginInput) throw new Error('Поле «Никнейм» не найдено на /login');

    let pwdInput = null;
    for (const sel of pwdSelectors) {
        pwdInput = await page.$(sel);
        if (pwdInput) break;
    }
    if (!pwdInput) throw new Error('Поле «Пароль» не найдено на /login');

    await loginInput.fill(creds.login);
    await pwdInput.fill(creds.password);

    const btnSelectors = [
        'button:has-text("Авторизоваться")',
        'button:has-text("Войти")',
        'button[type="submit"]',
        '.login_auth__button__jjG6c'
    ];
    let clicked = false;
    for (const sel of btnSelectors) {
        const btn = await page.$(sel);
        if (btn) { await btn.click(); clicked = true; break; }
    }
    if (!clicked) throw new Error('Кнопка «Авторизоваться» не найдена');

    try {
        await page.waitForURL((u) => !String(u).includes('/login'), { timeout: 15000 });
    } catch {
        const errText = await page.evaluate(() => {
            const nodes = document.querySelectorAll(
                '[class*="error" i], [class*="notification" i], [class*="toast" i], [role="alert"]'
            );
            for (const n of nodes) {
                const t = (n.textContent || '').trim();
                if (t && t.length < 300) return t;
            }
            return '';
        }).catch(() => '');
        throw new Error(
            `Авторизация не удалась${errText ? `: ${errText}` : ' — остались на /login'}`
        );
    }

    await page.waitForTimeout(500);
    console.log('✅ Авторизация успешна');
    return true;
}

async function ensureLoggedIn(context, page) {
    const ownPage = !page;
    const workPage = page || await context.newPage();
    try {
        await workPage.goto(`${BASE_URL}${LOGIN_PATH}`, {
            waitUntil: 'networkidle', timeout: 30000
        });
        await workPage.waitForTimeout(600);

        if (!isLoginUrl(workPage.url())) return true;

        if (!hasCredentials()) await promptCredentials();
        await login(workPage);
        return true;
    } finally {
        if (ownPage) await workPage.close();
    }
}

module.exports = {
    BASE_URL,
    LOGIN_PATH,
    getCredentials,
    setCredentials,
    hasCredentials,
    promptCredentials,
    login,
    ensureLoggedIn,
    isLoginUrl
};