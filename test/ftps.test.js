'use strict';

/**
 * Ověřování TLS certifikátu u FTPS.
 *
 * Nejdůležitější test v tomhle souboru je ten, že se při nepotvrzeném
 * certifikátu na server **nepošlou přihlašovací údaje** — jinak by celé
 * ověřování bylo k ničemu, protože heslo by u podvrženého serveru už bylo.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');

const { FtpSrv } = require('ftp-srv');
const { FtpAdapter } = require('../src/main/adapters/ftp');
const tlscerts = require('../src/main/tlscerts');

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const truthy = (label, v) => check(label, Boolean(v), true);

const FIXTURES = path.join(__dirname, 'fixtures');
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** FTPS server s vlastnoručně podepsaným certifikátem. Počítá pokusy o login. */
async function startFtps(root, certName) {
  const port = await freePort();
  const server = new FtpSrv({
    url: `ftp://127.0.0.1:${port}`,
    pasv_url: '127.0.0.1',
    anonymous: false,
    tls: {
      key: fs.readFileSync(path.join(FIXTURES, `${certName}_key.pem`)),
      cert: fs.readFileSync(path.join(FIXTURES, `${certName}_cert.pem`)),
    },
    log: quiet,
  });
  const state = { logins: [] };
  server.on('login', ({ username, password }, resolve, reject) => {
    state.logins.push({ username, password });
    if (username === 'test' && password === 'tajneheslo') resolve({ root });
    else reject(new Error('Špatné údaje'));
  });
  await server.listen();
  return { port, server, state };
}

function opensslFingerprint(certName) {
  return execFileSync('openssl', [
    'x509', '-in', path.join(FIXTURES, `${certName}_cert.pem`), '-noout', '-fingerprint', '-sha256',
  ], { encoding: 'utf8' }).trim().split('=')[1];
}

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ftpcli-ftps-'));
  const root = path.join(tmp, 'server');
  await fsp.mkdir(path.join(root, 'www'), { recursive: true });
  await fsp.writeFile(path.join(root, 'www', 'index.html'), '<h1>tls</h1>');

  const expected = opensslFingerprint('ftps');
  const otherFingerprint = opensslFingerprint('ftps2');

  const { port, server, state } = await startFtps(root, 'ftps');
  console.log(`Testovací FTPS server na portu ${port}\n`);

  const base = {
    host: '127.0.0.1', port, username: 'test', password: 'tajneheslo',
    protocol: 'ftp', ftps: 'explicit',
  };

  // =============================================== 1. bez potvrzení = konec
  const a1 = new FtpAdapter();
  let err1 = null;
  try { await a1.connect(base); } catch (e) { err1 = e; }
  await a1.disconnect().catch(() => {});

  truthy('nepotvrzený certifikát spojení neotevře', err1 && err1.certRejected);
  check('spojení zůstalo zavřené', a1.connected, false);
  // Tohle je jádro věci: heslo se nesmělo dostat ven.
  check('přihlašovací údaje se neodeslaly', state.logins.length, 0);
  truthy('chyba nese popis certifikátu', err1 && err1.certInfo && err1.certInfo.fingerprint);
  check('otisk odpovídá openssl', err1.certInfo.fingerprint, expected);
  check('verdikt u neznámého certifikátu', err1.certInfo.verdict, 'unknown');
  truthy('důvod zmiňuje podpis sebou samým', /sám sebou/.test(err1.certInfo.reason));
  check('rozpozná self-signed', err1.certInfo.info.selfSigned, true);
  check('vydavatel z certifikátu', err1.certInfo.info.issuer, 'localhost');

  // ==================================== 2. odmítnutí uživatelem = taky konec
  const a2 = new FtpAdapter();
  let err2 = null;
  try { await a2.connect(base, { verifyCertificate: () => false }); } catch (e) { err2 = e; }
  await a2.disconnect().catch(() => {});
  truthy('odmítnutí uživatelem spojení neotevře', err2 && err2.certRejected);
  check('ani teď se údaje neodeslaly', state.logins.length, 0);

  // ============================================== 3. potvrzení pustí dovnitř
  let askedWith = null;
  const a3 = new FtpAdapter();
  await a3.connect(base, {
    verifyCertificate: (info) => { askedWith = info; return true; },
  });
  truthy('po potvrzení se spojení otevře', a3.connected);
  check('teprve teď se přihlásíme', state.logins.length, 1);
  check('server dostal správné heslo', state.logins[0].password, 'tajneheslo');
  truthy('dotaz obsahoval otisk', askedWith && askedWith.fingerprint === expected);
  check('výpis přes TLS funguje', (await a3.list('/www')).map((e) => e.name), ['index.html']);
  await a3.disconnect();

  // ================================== 4. uložený otisk se už neptá (pinning)
  let asked4 = 0;
  const a4 = new FtpAdapter();
  await a4.connect({ ...base, tlsFingerprint: expected }, {
    verifyCertificate: () => { asked4 += 1; return false; },
  });
  truthy('se známým otiskem se spojení otevře', a4.connected);
  check('se známým otiskem se aplikace neptá', asked4, 0);
  check('potvrzený certifikát je k dispozici', a4.certificate.verdict, 'trusted');
  await a4.disconnect();

  // ============================================= 5. jiný otisk = nesoulad
  let seen5 = null;
  const a5 = new FtpAdapter();
  let err5 = null;
  try {
    await a5.connect({ ...base, tlsFingerprint: otherFingerprint }, {
      verifyCertificate: (info) => { seen5 = info; return false; },
    });
  } catch (e) { err5 = e; }
  await a5.disconnect().catch(() => {});
  truthy('nesouhlasný otisk spojení neotevře', err5 && err5.certRejected);
  check('verdikt je nesoulad', seen5.verdict, 'mismatch');
  check('nesoulad hlásí očekávaný otisk', seen5.expected, otherFingerprint);
  check('nesoulad hlásí i skutečný otisk', seen5.fingerprint, expected);

  // ======================== 6. vypnuté ověřování bere cokoliv (únikový východ)
  let asked6 = 0;
  const a6 = new FtpAdapter();
  await a6.connect({ ...base, rejectUnauthorized: false }, {
    verifyCertificate: () => { asked6 += 1; return false; },
  });
  truthy('s vypnutým ověřováním se připojí', a6.connected);
  check('s vypnutým ověřováním se neptá', asked6, 0);
  await a6.disconnect();

  // ============================================ 7. nešifrované FTP beze změny
  const plainRoot = path.join(tmp, 'plain');
  await fsp.mkdir(path.join(plainRoot, 'www'), { recursive: true });
  const plainPort = await freePort();
  const plain = new FtpSrv({
    url: `ftp://127.0.0.1:${plainPort}`, pasv_url: '127.0.0.1', anonymous: false, log: quiet,
  });
  plain.on('login', (d, resolve) => resolve({ root: plainRoot }));
  await plain.listen();
  const a7 = new FtpAdapter();
  await a7.connect({ ...base, port: plainPort, ftps: 'none' });
  truthy('obyčejné FTP se připojí bez řešení certifikátu', a7.connected);
  check('u nešifrovaného spojení není certifikát', a7.certificate, null);
  await a7.disconnect();
  await plain.close();

  // ================================================== 8. rozhodovací tabulka
  const fakeCert = {
    fingerprint256: 'AA:BB', subject: { CN: 'a' }, issuer: { CN: 'b' },
    valid_from: 'Jan 1 00:00:00 2026 GMT', valid_to: 'Jan 1 00:00:00 2036 GMT',
  };
  const decide = (o) => tlscerts.classify({
    cert: fakeCert, authorized: false, authorizationError: null, identityError: undefined, ...o,
  });

  check('platný podle systému = důvěryhodný',
    decide({ authorized: true }).verdict, 'trusted');
  check('platný, ale jiné jméno = neznámý',
    decide({ authorized: true, identityError: new Error('jméno') }).verdict, 'unknown');
  check('uložený otisk sedí = důvěryhodný',
    decide({ storedFingerprint: 'AA:BB' }).verdict, 'trusted');
  check('uložený otisk nesedí = nesoulad',
    decide({ storedFingerprint: 'CC:DD' }).verdict, 'mismatch');
  // Obnova certifikátu u uznávané autority se nemá tvářit jako útok.
  const renewed = decide({ storedFingerprint: 'CC:DD', authorized: true });
  check('obnova za platný certifikát = důvěryhodný', renewed.verdict, 'trusted');
  check('obnova si vyžádá srovnání otisku', renewed.refreshPin, true);
  check('vypnuté ověřování bere vše', decide({ acceptAny: true }).verdict, 'trusted');
  check('prošlá platnost se pozná',
    decide({ authorizationError: { code: 'CERT_HAS_EXPIRED' } }).reason,
    'Platnost certifikátu už vypršela.');

  await server.close();
  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Test selhal výjimkou:', err);
  process.exit(1);
});
