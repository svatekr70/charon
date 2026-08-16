'use strict';

/**
 * Záznam komunikace se serverem.
 *
 * Log je k ničemu, když v něm chybí to podstatné — a nebezpečný, když je v něm
 * heslo. Soubory se posílají do ticketů a zůstávají v nich roky, takže se
 * hlídá hlavně to maskování.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { SessionLog, zamaskuj } = require('../src/main/sessionlog');

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const truthy = (label, v, note = '') => {
  const ok = Boolean(v);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${note ? `  (${note})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ================================================ maskování
  check('heslo z PASS se schová', zamaskuj('> PASS tajneheslo'), '> PASS ***');
  check('i bez šipky', zamaskuj('PASS tajne'), 'PASS ***');
  check('malými písmeny taky', zamaskuj('pass tajne'), 'pass ***');
  check('heslo v adrese se schová', zamaskuj('sftp://web:tajne@server.test/x'), 'sftp://web:***@server.test/x');
  check('uživatel zůstane čitelný', zamaskuj('> USER web'), '> USER web');
  check('běžný řádek se nemění', zamaskuj('< 226 Transfer complete'), '< 226 Transfer complete');
  truthy('v maskovaném řádku heslo opravdu není', !zamaskuj('PASS tajne').includes('tajne'));

  // ================================================ zápis
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-log-'));
  const log = new SessionLog(dir);

  log.write('Web', 'tohle se zahodit má');
  check('vypnutý záznam nic nevytvoří', (await fsp.readdir(dir)).length, 0);

  log.setEnabled(true);
  log.write('Web', '> USER web');
  log.write('Web', '< 331 Password required');
  log.write('Web', '> PASS tajne');
  await sleep(150);

  const soubory = await fsp.readdir(dir);
  check('vznikl jeden soubor', soubory.length, 1);
  truthy('pojmenovaný podle dne', /^charon-\d{8}\.log$/.test(soubory[0]), soubory[0]);

  const obsah = await fsp.readFile(path.join(dir, soubory[0]), 'utf8');
  check('zapsaly se tři řádky', obsah.trim().split('\n').length, 3);
  truthy('je v nich vidět, která relace mluví', obsah.includes('[Web]'));
  truthy('a čas', /^\d{2}:\d{2}:\d{2}\.\d{3}/.test(obsah));
  truthy('heslo v souboru není', !obsah.includes('tajne'), obsah.split('\n')[2]);
  truthy('ale je poznat, že se přihlašovalo', obsah.includes('PASS ***'));

  // ================================================ víceřádkové zprávy
  log.write('Web', 'první řádek\ndruhý řádek\n\nčtvrtý');
  await sleep(150);
  const obsah2 = await fsp.readFile(path.join(dir, soubory[0]), 'utf8');
  check('víceřádková zpráva se rozepíše po řádcích', obsah2.trim().split('\n').length, 6);
  truthy('a prázdné řádky se zahodí', !obsah2.includes('] \n'));

  // ================================================ vypnutí
  log.setEnabled(false);
  log.write('Web', 'tohle už tam být nemá');
  await sleep(100);
  const obsah3 = await fsp.readFile(path.join(dir, soubory[0]), 'utf8');
  check('po vypnutí se nic nepřipisuje', obsah3, obsah2);

  // ================================================ přerostlý soubor
  const velky = new SessionLog(dir, { maxBytes: 200 });
  velky.setEnabled(true);
  for (let i = 0; i < 40; i += 1) velky.write('Web', `řádek číslo ${i} s nějakým textem navíc`);
  await sleep(200);
  velky.close();
  const poRotaci = await fsp.readdir(dir);
  truthy('přerostlý log se odloží stranou', poRotaci.some((f) => f.endsWith('.log.1')), poRotaci.join(', '));

  log.close();
  await fsp.rm(dir, { recursive: true, force: true });
  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
