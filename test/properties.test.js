'use strict';

/** Práva, vlastník a kontrolní součty na serveru. */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');
const { FtpAdapter } = require('../src/main/adapters/ftp');
const { remoteChmod } = require('../src/main/browse');

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

const modeOf = (p) => fs.statSync(p).mode & 0o777;

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-props-'));
  const root = path.join(tmp, 'server');
  await fsp.mkdir(path.join(root, 'www', 'sub'), { recursive: true });
  await fsp.writeFile(path.join(root, 'www', 'a.txt'), 'obsah a');
  await fsp.writeFile(path.join(root, 'www', 'sub', 'b.txt'), 'obsah b');

  const server = await startTestServer({ root, hostKeyPath: path.join(__dirname, 'fixtures', 'host_key') });
  const adapter = new SftpAdapter();
  await adapter.connect(
    { host: '127.0.0.1', port: server.port, username: 'test', password: 'test' },
    { verifyHostKey: () => true },
  );

  // ------------------------------------------------- rekurzivní práva
  // Složky a soubory dostávají jiná práva; 644 na složce by ji znepřístupnilo.
  const stats = await remoteChmod(adapter, '/www', { fileMode: 0o640, dirMode: 0o750 });
  check('spočítané soubory', stats.files, 2);
  check('spočítané složky', stats.dirs, 2);
  check('práva souboru', modeOf(path.join(root, 'www', 'a.txt')), 0o640);
  check('práva v podsložce', modeOf(path.join(root, 'www', 'sub', 'b.txt')), 0o640);
  check('práva složky', modeOf(path.join(root, 'www')), 0o750);
  check('práva podsložky', modeOf(path.join(root, 'www', 'sub')), 0o750);

  // Jen soubory, složky beze změny.
  await remoteChmod(adapter, '/www', { fileMode: 0o600, dirMode: null });
  check('jen soubory se změnily', modeOf(path.join(root, 'www', 'a.txt')), 0o600);
  check('složka zůstala', modeOf(path.join(root, 'www')), 0o750);

  // Na samotný soubor bez rekurze.
  await remoteChmod(adapter, '/www/a.txt', { fileMode: 0o644, dirMode: 0o755 });
  check('jednotlivý soubor', modeOf(path.join(root, 'www', 'a.txt')), 0o644);

  // ------------------------------------------------- kontrolní součty
  const payload = crypto.randomBytes(4096);
  await fsp.writeFile(path.join(root, 'www', 'data.bin'), payload);
  const expectSha = crypto.createHash('sha256').update(payload).digest('hex');
  const expectMd5 = crypto.createHash('md5').update(payload).digest('hex');

  // Součet se počítá příkazem v shellu, a ten u testovacího serveru vidí
  // skutečné cesty, ne ty pod jeho falešným kořenem.
  const dataPath = path.join(root, 'www', 'data.bin');
  const sha = await adapter.checksum(dataPath, 'sha256');
  check('sha256 odpovídá skutečnosti', sha.hash.toLowerCase(), expectSha);
  truthy('a hlásí, čím se počítalo', sha.tool, sha.tool);

  const md5 = await adapter.checksum(dataPath, 'md5');
  check('md5 odpovídá', md5.hash.toLowerCase(), expectMd5);

  // Název se středníkem se nesmí stát částí příkazu.
  const trickyPath = path.join(root, 'www', 'a; touch HACK');
  await fsp.writeFile(trickyPath, payload);
  const tricky = await adapter.checksum(trickyPath, 'sha256');
  check('nebezpečný název se spočítá správně', tricky.hash.toLowerCase(), expectSha);
  check('a nic navíc nevzniklo', fs.existsSync(path.join(root, 'www', 'HACK')), false);

  let missing = null;
  try { await adapter.checksum(path.join(root, 'neexistuje'), 'sha256'); } catch (e) { missing = e; }
  truthy('u chybějícího souboru se ozve', missing && /neumí spočítat/.test(missing.message));

  // ------------------------------------------------------------- FTP
  const ftp = new FtpAdapter();
  let ftpErr = null;
  try { ftp.chown('/x', 1, 1); } catch (e) { ftpErr = e; }
  truthy('změnu vlastníka FTP neumí a řekne to', ftpErr && /jen SFTP/.test(ftpErr.message));

  await adapter.disconnect();
  await server.close();
  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
