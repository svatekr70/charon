'use strict';

/**
 * Vrtochy starších FTP serverů: kódování názvů a čas v jiné zóně.
 *
 * Obojí se pozná až podle toho, co uvidí uživatel — proto se testuje proti
 * skutečnému FTP serveru, ne proti přepočtu v hlavě. Časový posun je přitom
 * zákeřný: bez něj se soubory tváří o hodiny starší a synchronizace je pak
 * přenáší pořád dokola.
 */

const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const { FtpSrv } = require('ftp-srv');
const { FtpAdapter, encodingOf } = require('../src/main/adapters/ftp');

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

const ticho = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

function volnyPort() {
  return new Promise((resolve) => {
    const s = require('net').createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function main() {
  // ================================================ volba kódování
  check('bez nastavení rozhoduje server', encodingOf({}), undefined);
  check('„auto" je totéž', encodingOf({ encoding: 'auto' }), undefined);
  check('vynucené UTF-8', encodingOf({ encoding: 'utf8' }), 'utf8');
  check('latin1 pro starší servery', encodingOf({ encoding: 'latin1' }), 'latin1');
  check('nesmysl se chová jako auto', encodingOf({ encoding: 'klingonsky' }), undefined);

  // ================================================ proti skutečnému serveru
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-ftpq-'));
  const root = path.join(tmp, 'www');
  await fsp.mkdir(root, { recursive: true });

  const cas = new Date('2026-03-01T12:00:00Z');
  await fsp.writeFile(path.join(root, 'příliš žluťoučký.txt'), 'kůň');
  await fsp.utimes(path.join(root, 'příliš žluťoučký.txt'), cas, cas);

  const port = await volnyPort();
  const server = new FtpSrv({ url: `ftp://127.0.0.1:${port}`, pasv_url: '127.0.0.1', anonymous: false, log: ticho });
  server.on('login', ({ username, password }, resolve, reject) => {
    if (username === 'test' && password === 'test') resolve({ root: tmp });
    else reject(new Error('Špatné údaje'));
  });
  await server.listen();

  const zaklad = { host: '127.0.0.1', port, username: 'test', password: 'test', protocol: 'ftp' };
  const pripoj = async (cfg) => {
    const a = new FtpAdapter();
    await a.connect({ ...zaklad, ...cfg }, {});
    return a;
  };

  // --- diakritika projde v UTF-8
  const utf = await pripoj({ encoding: 'utf8' });
  const vypis = await utf.list('/www');
  check('název s diakritikou dorazí celý', vypis.map((e) => e.name), ['příliš žluťoučký.txt']);

  // --- čas bez posunu
  const bezPosunu = vypis[0].mtime;
  truthy('čas se přečte', bezPosunu > 0, new Date(bezPosunu).toISOString());
  await utf.disconnect();

  const nulovyStat = async () => {
    const a = await pripoj({ encoding: 'utf8' });
    const st = await a.stat('/www/příliš žluťoučký.txt');
    await a.disconnect();
    return st;
  };

  // --- čas s posunem o dvě hodiny zpět
  const posunuty = await pripoj({ encoding: 'utf8', timeShiftMinutes: -120 });
  const sPosunem = (await posunuty.list('/www'))[0].mtime;
  check('posun se do výpisu promítne přesně', (bezPosunu - sPosunem) / 60000, 120);
  check('posun v minutách sedí i na adaptéru', posunuty.timeShiftMs, -120 * 60000);

  // MDTM vrací podle RFC 3659 čas v UTC — ten je správně sám o sobě a posouvat
  // ho by z opravy udělalo chybu. Proto se ho korekce nesmí dotknout.
  const bezPosunuStat = (await nulovyStat()).mtime;
  const sPosunemStat = (await posunuty.stat('/www/příliš žluťoučký.txt')).mtime;
  check('čas z MDTM zůstává nedotčený', sPosunemStat, bezPosunuStat);
  truthy('a je to skutečně jiný údaj než textový výpis', bezPosunuStat !== bezPosunu,
    `MDTM ${new Date(bezPosunuStat).toISOString()} vs. výpis ${new Date(bezPosunu).toISOString()}`);
  await posunuty.disconnect();

  // --- nulový posun nic nemění
  const nulovy = await pripoj({ encoding: 'utf8', timeShiftMinutes: 0 });
  check('bez posunu zůstává čas beze změny', (await nulovy.list('/www'))[0].mtime, bezPosunu);
  await nulovy.disconnect();

  // --- latin1 se serverem, který mluví UTF-8: název se rozsype, ale spojení drží
  // (Přesně proto je to volba a ne automatika — poznat to musí člověk.)
  const latin = await pripoj({ encoding: 'latin1' });
  const rozsypane = await latin.list('/www');
  check('spojení funguje i v latin1', rozsypane.length, 1);
  truthy('ale název už není původní', rozsypane[0].name !== 'příliš žluťoučký.txt', rozsypane[0].name);
  await latin.disconnect();

  await server.close();
  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
