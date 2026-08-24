'use strict';

/**
 * Drobné operace na serveru: kopie, odkaz, ruční čas.
 *
 * Kopie má hlavně nestahovat data zbytečně přes tenhle počítač — když server
 * pustí shell, udělá ji sám. Testuje se proti skutečnému serveru, protože
 * jediné, co se počítá, je výsledek na druhé straně.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');
const { FtpAdapter } = require('../src/main/adapters/ftp');
const { hostKeyPath } = require('./fixtures');

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

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-ops-'));
  const serverRoot = path.join(tmp, 'server');
  const www = path.join(serverRoot, 'www');
  await fsp.mkdir(www, { recursive: true });
  await fsp.writeFile(path.join(www, 'index.php'), '<?php echo "ahoj";');
  await fsp.chmod(path.join(www, 'index.php'), 0o640);

  const server = await startTestServer({ root: serverRoot, hostKeyPath: hostKeyPath() });
  const a = new SftpAdapter();
  await a.connect(
    { host: '127.0.0.1', port: server.port, username: 'test', password: 'test' },
    { verifyHostKey: () => true },
  );

  // ================================================ kopie přes shell
  // Testovací server má falešný kořen: SFTP vidí /www, ale shell skutečnou
  // cestu na disku. Je to tentýž případ jako chrootované SFTP vedle shellu
  // v běžném provozu, takže se tu dají vyzkoušet obě cesty.
  const skutecna = path.join(www, 'index.php');
  const res = await a.copy(skutecna, path.join(www, 'shell-kopie.php'));
  truthy('kopii udělal server sám', res.serverSide, JSON.stringify(res));
  check('a soubor vznikl', fs.existsSync(path.join(www, 'shell-kopie.php')), true);
  check('se zachovanými právy',
    (await fsp.stat(path.join(www, 'shell-kopie.php'))).mode & 0o777, 0o640);

  // ================================================ kopie záskokem
  const res2 = await a.copy('/www/index.php', '/www/index-kopie.php');
  check('kopie vznikla i tak', fs.existsSync(path.join(www, 'index-kopie.php')), true);
  check('a má stejný obsah',
    await fsp.readFile(path.join(www, 'index-kopie.php'), 'utf8'), '<?php echo "ahoj";');
  check('ví se, že server ji sám neudělal', res2.serverSide, false);
  truthy('a ví se proč', res2.reason && res2.reason.length > 0, res2.reason);

  // Kopie tam, kam se nedá, musí selhat srozumitelně — a zmínit oba pokusy.
  let chyba = null;
  try { await a.copy('/www/index.php', '/nikde/x.php'); } catch (e) { chyba = e; }
  truthy('nemožná kopie se ohlásí', chyba && /přes shell to taky nešlo/.test(chyba.message),
    chyba ? chyba.message.slice(0, 80) : '(bez chyby!)');

  // ================================================ odkaz
  await a.symlink('index.php', '/www/odkaz.php');
  const st = await fsp.lstat(path.join(www, 'odkaz.php'));
  check('odkaz je opravdu odkaz', st.isSymbolicLink(), true);
  check('a ukazuje, kam má', await fsp.readlink(path.join(www, 'odkaz.php')), 'index.php');
  check('ve výpisu se pozná', (await a.list('/www')).find((e) => e.name === 'odkaz.php').type, 'l');

  // ================================================ nový prázdný soubor
  await a.createFile('/www/novy.txt');
  check('soubor vznikl', fs.existsSync(path.join(www, 'novy.txt')), true);
  check('a je prázdný', (await fsp.stat(path.join(www, 'novy.txt'))).size, 0);
  check('ve výpisu je jako soubor',
    (await a.list('/www')).find((e) => e.name === 'novy.txt').type, 'f');

  // Hotovou práci nepřepisujeme — na to je nahrání nebo editace.
  await fsp.writeFile(path.join(www, 'obsazeno.txt'), 'důležitý obsah');
  let obsazeno = null;
  try { await a.createFile('/www/obsazeno.txt'); } catch (e) { obsazeno = e; }
  truthy('na obsazený název se soubor nezaloží', obsazeno, obsazeno ? obsazeno.message : '(bez chyby!)');
  check('a původní obsah zůstal',
    await fsp.readFile(path.join(www, 'obsazeno.txt'), 'utf8'), 'důležitý obsah');

  // ================================================ ruční čas
  // Adaptéry počítají v milisekundách, stejně jako `fs` — jednotky se pletou
  // snadno a chyba je vidět až jako soubor z roku 1970.
  const kdy = new Date('2020-03-01T08:30:00Z').getTime();
  await a.utimes('/www/index.php', kdy, kdy);
  check('čas se nastavil',
    Math.floor((await fsp.stat(path.join(www, 'index.php'))).mtimeMs), kdy);
  check('a je vidět ve výpisu',
    Math.floor((await a.list('/www')).find((e) => e.name === 'index.php').mtime), kdy);

  await a.disconnect();
  await server.close();

  // ================================================ co FTP neumí
  const f = new FtpAdapter();
  let ftpCopy = null;
  try { await f.copy('/a', '/b'); } catch (e) { ftpCopy = e; }
  truthy('FTP kopii odmítne a poradí', ftpCopy && /jen přes SFTP/.test(ftpCopy.message), ftpCopy && ftpCopy.message);
  let ftpLink = null;
  try { await f.symlink('a', 'b'); } catch (e) { ftpLink = e; }
  truthy('a odkaz taky', ftpLink && /jen SFTP/.test(ftpLink.message));

  await fsp.rm(tmp, { recursive: true, force: true });
  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
