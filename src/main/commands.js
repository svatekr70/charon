'use strict';

const { spawn } = require('child_process');

/**
 * Vlastní příkazy.
 *
 * Šablona se doplní o cesty k vybraným souborům a spustí buď na serveru
 * (přes SSH), nebo na tomhle počítači. Zástupné znaky jsou stejné jako
 * ve WinSCP, aby se zvyk nemusel přeučovat.
 */

/**
 * Uzavře hodnotu do apostrofů pro POSIX shell.
 *
 * Dosazované hodnoty uzavíráme **vždycky**, i když v nich mezera není.
 * Uživatel tak nemusí myslet na uvozovky a hlavně: název souboru se
 * středníkem nebo zpětným apostrofem se nemůže stát částí příkazu.
 */
function shellQuote(value) {
  const s = String(value ?? '');
  if (s === '') return "''";
  // Uvnitř apostrofů nemá žádný znak zvláštní význam kromě apostrofu
  // samotného — ten se musí uzavřít, vložit a otevřít znovu.
  return `'${s.split("'").join("'\\''")}'`;
}

/**
 * Zástupné znaky v šabloně:
 *
 *   !     cesta k vybranému souboru
 *   !N    název vybraného souboru bez cesty
 *   !&    všechny vybrané soubory za sebou
 *   !/    vzdálený adresář
 *   !\\    lokální adresář
 *   !?Otázka?výchozí!   zeptá se uživatele
 *   !!    samotný vykřičník
 */
const PROMPT_RE = /!\?([^?]*)\?([^!]*)!/g;

/** Najde v šabloně dotazy na uživatele. */
function findPrompts(template) {
  const out = [];
  const rx = new RegExp(PROMPT_RE.source, 'g');
  let m = rx.exec(template);
  while (m) {
    out.push({ token: m[0], question: m[1], value: m[2] });
    m = rx.exec(template);
  }
  return out;
}

/**
 * Doplní šablonu.
 *
 * @param {string} template
 * @param {object} ctx
 * @param {string} [ctx.file] cesta k souboru, kterého se spuštění týká
 * @param {string[]} [ctx.files] všechny vybrané cesty
 * @param {string} [ctx.remoteDir]
 * @param {string} [ctx.localDir]
 * @param {object} [ctx.answers] odpovědi na dotazy, klíčem je otázka
 */
function expand(template, ctx = {}) {
  const files = ctx.files || (ctx.file ? [ctx.file] : []);
  const file = ctx.file || files[0] || '';
  const name = file ? file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1) : '';
  const answers = ctx.answers || {};

  // Jeden průchod přes všechny značky najednou. Dřívější verze si vykřičníky
  // určené k zachování schovávala pod náhradní značku, jenže ta sama vykřičník
  // obsahovala a pozdější dosazování ji sebralo. Pořadí ve výběru níž je tím
  // jediným, na čem záleží: delší značky musí být před samotným „!".
  const TOKENS = /!\?([^?]*)\?([^!]*)!|!!|!N|!&|!\/|!\\|!/g;

  return template.replace(TOKENS, (match, question, fallback) => {
    if (match === '!!') return '!';
    if (match.startsWith('!?')) {
      const answer = Object.prototype.hasOwnProperty.call(answers, question) ? answers[question] : fallback;
      return shellQuote(answer);
    }
    if (match === '!N') return shellQuote(name);
    if (match === '!&') return files.map(shellQuote).join(' ');
    if (match === '!/') return shellQuote(ctx.remoteDir || '');
    if (match === '!\\') return shellQuote(ctx.localDir || '');
    return shellQuote(file);
  });
}

/** Použije šablona vůbec nějaký soubor? Podle toho se pozná, co jde spustit bez výběru. */
function usesFile(template) {
  const stripped = template.split('!!').join('').replace(PROMPT_RE, '');
  return /![N&]?/.test(stripped) && /!(?![/\\])/.test(stripped);
}

/**
 * Spustí příkaz na tomhle počítači.
 *
 * Přes shell schválně — celý smysl vlastních příkazů je, že si do nich člověk
 * napíše roury a přesměrování. Dosazované hodnoty jsou uzavřené v apostrofech,
 * takže se z názvu souboru nemůže stát kus příkazu.
 */
function runLocal(command, { cwd, onData, timeoutMs = 60000, maxOutput = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd: cwd || undefined,
      env: process.env,
    });

    let output = '';
    let truncated = false;
    let settled = false;

    const collect = (text, kind) => {
      if (output.length < maxOutput) {
        output += text;
        if (output.length >= maxOutput) { truncated = true; output = output.slice(0, maxOutput); }
      }
      if (onData) onData(text, kind);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (!settled) {
        settled = true;
        reject(new Error(`Příkaz běžel déle než ${Math.round(timeoutMs / 1000)} s a byl přerušen`));
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => collect(d.toString('utf8'), 'out'));
    child.stderr.on('data', (d) => collect(d.toString('utf8'), 'err'));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 0, signal: signal || null, output, truncated, command });
    });
  });
}

module.exports = {
  shellQuote, expand, findPrompts, usesFile, runLocal,
};
