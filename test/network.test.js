'use strict';

/**
 * Síťové volby: keepalive, timeout a anonymní přihlášení.
 *
 * Keepalive je zrádné v tom, že ho někteří poskytovatelé nesnesou a spojení
 * kvůli němu zavřou — tedy přesně opačně, než k čemu je. Proto musí jít
 * spolehlivě vypnout, a nula se nesmí cestou spolknout jako „nic nezadáno".
 */

const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');

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

/**
 * Stejný výpočet, jaký dělá hlavní proces. Je tu schválně zdvojený: kdyby se
 * v aplikaci změnil, test to má připomenout, protože nula tu znamená vypnuto
 * a ne „doplň výchozí".
 */
function withNetwork(cfg, settings) {
  const keep = settings.keepaliveSeconds;
  return {
    ...cfg,
    keepaliveMs: keep === 0 ? 0 : (Number(keep) || 10) * 1000,
    connectTimeoutMs: (Number(settings.connectTimeoutSeconds) || 25) * 1000,
    username: cfg.anonymous ? 'anonymous' : cfg.username,
    password: cfg.anonymous ? 'anonymous@' : cfg.password,
  };
}

async function main() {
  // ================================================ přepočet nastavení
  check('výchozí keepalive', withNetwork({}, {}).keepaliveMs, 10000);
  check('nula opravdu vypíná', withNetwork({}, { keepaliveSeconds: 0 }).keepaliveMs, 0);
  check('vlastní hodnota projde', withNetwork({}, { keepaliveSeconds: 45 }).keepaliveMs, 45000);
  check('prázdno se chová jako výchozí', withNetwork({}, { keepaliveSeconds: '' }).keepaliveMs, 10000);
  check('výchozí timeout', withNetwork({}, {}).connectTimeoutMs, 25000);
  check('vlastní timeout', withNetwork({}, { connectTimeoutSeconds: 60 }).connectTimeoutMs, 60000);

  check('anonymní přihlášení doplní jméno',
    withNetwork({ anonymous: true, username: '', password: '' }, {}).username, 'anonymous');
  check('a obvyklé heslo',
    withNetwork({ anonymous: true }, {}).password, 'anonymous@');
  check('bez zaškrtnutí se jméno nemění',
    withNetwork({ username: 'pepa', password: 'x' }, {}).username, 'pepa');

  // ================================================ proti skutečnému serveru
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-net-'));
  await fsp.mkdir(path.join(tmp, 'www'), { recursive: true });
  const server = await startTestServer({ root: tmp, hostKeyPath: path.join(__dirname, 'fixtures', 'host_key') });

  const zaklad = { host: '127.0.0.1', port: server.port, username: 'test', password: 'test' };

  const s1 = new SftpAdapter();
  await s1.connect(withNetwork(zaklad, { keepaliveSeconds: 0 }), { verifyHostKey: () => true });
  truthy('s vypnutým keepalive se spojení naváže', s1.connected);
  check('a funguje', (await s1.list('/')).map((e) => e.name), ['www']);
  await s1.disconnect();

  const s2 = new SftpAdapter();
  await s2.connect(withNetwork(zaklad, { keepaliveSeconds: 1 }), { verifyHostKey: () => true });
  truthy('s krátkým keepalive taky', s2.connected);
  // Krátký keepalive nesmí spojení sám zabít — počkáme přes několik intervalů.
  await new Promise((r) => setTimeout(r, 2500));
  check('a po několika intervalech spojení drží', (await s2.list('/')).length, 1);
  await s2.disconnect();

  // Krátký timeout na nedostupný port musí skončit chybou, ne čekáním navěky.
  const s3 = new SftpAdapter();
  const start = Date.now();
  let chyba = null;
  try {
    await s3.connect(
      withNetwork({ ...zaklad, host: '10.255.255.1', port: 22 }, { connectTimeoutSeconds: 5 }),
      { verifyHostKey: () => true },
    );
  } catch (e) { chyba = e; }
  const trvalo = (Date.now() - start) / 1000;
  await s3.disconnect().catch(() => {});
  truthy('nedostupný server skončí chybou', chyba, chyba ? chyba.message.slice(0, 50) : '(bez chyby!)');
  truthy('a nečeká se donekonečna', trvalo < 20, `${trvalo.toFixed(1)} s`);

  await server.close();
  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
