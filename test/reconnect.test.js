'use strict';

/**
 * Automatické obnovení spojení.
 *
 * Spadlá linka nebo restartovaný server nesmí znamenat, že uživatel přijde
 * o rozdělanou frontu a musí klikat na připojení sám. Testuje se proti
 * skutečnému serveru, který se opravdu vypne a zase zapne — jinak by se
 * nedalo poznat, jestli se adaptér o výpadku vůbec dozví.
 */

const fsp = require('fs').promises;
const net = require('net');
const os = require('os');
const path = require('path');

const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');
const { Session } = require('../src/main/session');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Počká, až podmínka platí — ať test nestojí na pevně odhadnutém čase. */
async function until(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-rc-'));
  const serverRoot = path.join(tmp, 'server');
  await fsp.mkdir(path.join(serverRoot, 'www'), { recursive: true });
  await fsp.writeFile(path.join(serverRoot, 'www', 'a.txt'), 'obsah');

  const klicServeru = hostKeyPath();
  const port = await freePort();
  const start = () => startTestServer({ root: serverRoot, hostKeyPath: klicServeru, port });

  let server = await start();

  const events = [];
  const logs = [];
  const config = {
    name: 'Zkouška', protocol: 'sftp', host: '127.0.0.1', port, username: 'test', password: 'test',
  };

  const openAdapter = async () => {
    const a = new SftpAdapter();
    await a.connect(config, { verifyHostKey: () => true });
    return a;
  };

  const session = new Session({
    id: 's1',
    config,
    siteId: 'site-1',
    deps: {
      openAdapter,
      send: (channel, msg) => events.push({ channel, status: msg.payload && msg.payload.status }),
      askConflict: async () => ({ action: 'overwrite' }),
      askEditOverwrite: async () => ({ action: 'skip' }),
      log: (level, text) => logs.push(`${level}: ${text}`),
      settings: () => ({ maxConcurrent: 2, speedLimitKb: 0, tempName: false }),
    },
  });

  await session.connect(await openAdapter(), '/');
  check('po připojení je relace připojená', session.status, 'connected');
  check('klíč pro frontu je uložená relace', session.persistKey, 'site-1');

  // ============================ 1. výpadek se pozná a spustí obnovení
  // Server vypneme celý, ať se spojení opravdu přeruší.
  // Klienta ukončíme jako první: ssh2 server čeká se zavřením na to, až
  // všechna spojení skončí, takže obráceně by se close() nedočkal.
  session.browse.client.client.end();
  await sleep(200);
  await server.close();

  truthy('výpadek se pozná', await until(() => session.status !== 'connected', 5000),
    `stav=${session.status}`);
  truthy('a rovnou se zkouší obnovit', session.reconnecting || session.status === 'connecting');
  truthy('uživatel se o výpadku dozví', logs.some((l) => /spojení skončilo/.test(l)),
    logs[logs.length - 1] || '');

  // Než server naběhne, musí okno vidět stav „připojuji" — jinak by to
  // vypadalo, že se neděje nic.
  truthy('okno dostane stav připojování',
    await until(() => events.some((e) => e.channel === 'conn' && e.status === 'connecting'), 6000));

  // ============================ 2. jakmile je server zpátky, naváže se
  server = await start();
  truthy('po návratu serveru se spojení obnoví',
    await until(() => session.status === 'connected', 20000), `stav=${session.status}`);
  check('a dá se zase procházet', (await session.requireBrowse().list('/www')).map((e) => e.name), ['a.txt']);
  truthy('a je to vidět v protokolu', logs.some((l) => /spojení obnoveno/.test(l)));
  truthy('obnovování skončilo', !session.reconnecting);

  // ============================ 3. zásoba spojení pro přenosy se zahodí
  // Spojení z mrtvé zásoby by po výpadku byla taky mrtvá.
  const pool = session.transferPool();
  const pujceny = await pool.acquire();
  pool.release(pujceny);
  truthy('zásoba spojení existuje', session.pool === pool);

  session.browse.client.client.end();
  truthy('výpadek zásobu zahodí',
    await until(() => session.pool === null || session.pool !== pool, 6000));
  truthy('a spojení se obnoví i podruhé',
    await until(() => session.status === 'connected', 20000), `stav=${session.status}`);

  // ============================ 4. vlastní zavření se neobnovuje
  // Příznak nastavíme dřív, než spojení zabijeme — jinak by se relace začala
  // obnovovat sama a do dalšího bodu by nám do toho mluvila.
  session.closing = true;
  session.browse.client.client.end();
  await sleep(200);
  await server.close();

  const predtim = logs.length;
  check('při zavírání se neobnovuje', await session.reconnect({ attempts: [10] }), false);
  check('a mlčí se o tom', logs.length, predtim);
  session.closing = false;

  // ============================ 5. dva pokusy naráz se nepřekrývají
  const soubezne = await Promise.all([
    session.reconnect({ attempts: [10, 10] }),
    session.reconnect({ attempts: [10, 10] }),
  ]);
  check('souběžné obnovení se nespustí dvakrát', soubezne, [false, false]);
  check('po marných pokusech je relace odpojená', session.status, 'disconnected');
  truthy('a řekne se to nahlas', logs.some((l) => /nepodařilo obnovit/.test(l)));
  truthy('počítadlo pokusů sedí',
    logs.filter((l) => /pokus o obnovení 1\/2/.test(l)).length === 1,
    `pokusů: ${logs.filter((l) => /pokus o obnovení/.test(l)).length}`);

  session.closing = true;
  await session.close().catch(() => {});
  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
