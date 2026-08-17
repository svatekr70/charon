'use strict';

/**
 * Cesta k serveru, když nevede přímo — proxy a SSH tunel.
 *
 * Testuje se proti skutečné proxy (napsané tady v testu podle RFC) a proti
 * skutečné bráně, ne proti napodobenině rozhraní. U síťového kódu je to jediný
 * způsob, jak zjistit, že se domluví i s protistranou.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const net = require('net');
const path = require('path');

const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');
const { throughProxy, buildPath } = require('../src/main/netpath');
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

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Cílový server, který jen řekne, kdo je, a spojení zavře. */
async function echoServer(name) {
  const port = await freePort();
  const server = net.createServer((sock) => { sock.end(`ahoj z ${name}`); });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { port, close: () => new Promise((r) => server.close(r)) };
}

/** Minimální SOCKS5 proxy podle RFC 1928, volitelně s heslem. */
async function socksProxy({ requireAuth = false, user = 'u', password = 'p' } = {}) {
  const port = await freePort();
  const state = { connections: 0, lastTarget: null };

  const server = net.createServer((client) => {
    state.connections += 1;
    let stage = 'greeting';

    client.on('data', (data) => {
      if (stage === 'greeting') {
        const methods = [...data.subarray(2, 2 + data[1])];
        if (requireAuth) {
          if (!methods.includes(0x02)) { client.end(Buffer.from([0x05, 0xff])); return; }
          client.write(Buffer.from([0x05, 0x02]));
          stage = 'auth';
        } else {
          client.write(Buffer.from([0x05, 0x00]));
          stage = 'request';
        }
        return;
      }

      if (stage === 'auth') {
        const ulen = data[1];
        const u = data.subarray(2, 2 + ulen).toString();
        const plen = data[2 + ulen];
        const p = data.subarray(3 + ulen, 3 + ulen + plen).toString();
        const ok = u === user && p === password;
        client.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
        if (!ok) { client.end(); return; }
        stage = 'request';
        return;
      }

      if (stage === 'request') {
        const nameLen = data[4];
        const host = data.subarray(5, 5 + nameLen).toString();
        const targetPort = data.readUInt16BE(5 + nameLen);
        state.lastTarget = `${host}:${targetPort}`;

        const upstream = net.connect({ host, port: targetPort }, () => {
          const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
          client.write(reply);
          stage = 'tunnel';
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on('error', () => {
          client.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        });
      }
    });
    client.on('error', () => {});
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { port, state, close: () => new Promise((r) => server.close(r)) };
}

/** Minimální HTTP CONNECT proxy. */
async function httpProxy() {
  const port = await freePort();
  const state = { lastTarget: null };
  const server = net.createServer((client) => {
    client.once('data', (data) => {
      const line = data.toString().split('\r\n')[0];
      const target = line.split(' ')[1] || '';
      state.lastTarget = target;
      const [host, p] = target.split(':');
      const upstream = net.connect({ host, port: Number(p) }, () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    });
    client.on('error', () => {});
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { port, state, close: () => new Promise((r) => server.close(r)) };
}

const readAll = (sock) => new Promise((resolve, reject) => {
  let out = '';
  sock.on('data', (d) => { out += d.toString(); });
  sock.on('end', () => resolve(out));
  sock.on('error', reject);
});

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-net-'));
  const target = await echoServer('cíle');

  // ================================================== bez proxy
  const direct = await throughProxy(null, '127.0.0.1', target.port);
  check('přímé spojení projde', await readAll(direct), 'ahoj z cíle');

  const none = await throughProxy({ type: 'none' }, '127.0.0.1', target.port);
  check('typ „none" je taky přímo', await readAll(none), 'ahoj z cíle');

  // ================================================== SOCKS5
  const socks = await socksProxy();
  const viaSocks = await throughProxy(
    { type: 'socks5', host: '127.0.0.1', port: socks.port }, '127.0.0.1', target.port,
  );
  check('SOCKS5 spojení projde', await readAll(viaSocks), 'ahoj z cíle');
  check('proxy dostala správný cíl', socks.state.lastTarget, `127.0.0.1:${target.port}`);

  // Jméno serveru posíláme proxy, ať si ho přeloží sama.
  const viaName = await throughProxy(
    { type: 'socks5', host: '127.0.0.1', port: socks.port }, 'localhost', target.port,
  );
  check('adresa se posílá jménem', socks.state.lastTarget, `localhost:${target.port}`);
  viaName.destroy();

  // ---------------------------------------- SOCKS5 s heslem
  const authSocks = await socksProxy({ requireAuth: true, user: 'pepa', password: 'tajne' });
  const viaAuth = await throughProxy({
    type: 'socks5', host: '127.0.0.1', port: authSocks.port, username: 'pepa', password: 'tajne',
  }, '127.0.0.1', target.port);
  check('SOCKS5 s heslem projde', await readAll(viaAuth), 'ahoj z cíle');

  let badPass = null;
  try {
    await throughProxy({
      type: 'socks5', host: '127.0.0.1', port: authSocks.port, username: 'pepa', password: 'spatne',
    }, '127.0.0.1', target.port);
  } catch (e) { badPass = e; }
  truthy('špatné heslo proxy se ohlásí', badPass && /odmítla jméno nebo heslo/.test(badPass.message));

  let noPass = null;
  try {
    await throughProxy({ type: 'socks5', host: '127.0.0.1', port: authSocks.port }, '127.0.0.1', target.port);
  } catch (e) { noPass = e; }
  truthy('chybějící heslo taky', noPass && /nenabídla použitelný/.test(noPass.message));

  // Nedostupný cíl musí skončit srozumitelně, ne tichým čekáním.
  const closedPort = await freePort();
  let refused = null;
  try {
    await throughProxy({ type: 'socks5', host: '127.0.0.1', port: socks.port }, '127.0.0.1', closedPort);
  } catch (e) { refused = e; }
  truthy('nedostupný cíl přes proxy se ohlásí', refused && /nenavázala/.test(refused.message),
    refused ? refused.message : '');

  // ================================================== HTTP CONNECT
  const http = await httpProxy();
  const viaHttp = await throughProxy(
    { type: 'http', host: '127.0.0.1', port: http.port }, '127.0.0.1', target.port,
  );
  check('HTTP CONNECT projde', await readAll(viaHttp), 'ahoj z cíle');
  check('a dostala správný cíl', http.state.lastTarget, `127.0.0.1:${target.port}`);

  let unknown = null;
  try { await throughProxy({ type: 'divne' }, '127.0.0.1', target.port); } catch (e) { unknown = e; }
  truthy('neznámý typ proxy se ohlásí', unknown && /Neznámý typ proxy/.test(unknown.message));

  // ================================================== SSH tunel
  // Brána i cíl jsou tentýž testovací SFTP server; podstatné je, že spojení
  // vede skrz něj a ne přímo.
  const serverRoot = path.join(tmp, 'server');
  await fsp.mkdir(path.join(serverRoot, 'www'), { recursive: true });
  await fsp.writeFile(path.join(serverRoot, 'www', 'a.txt'), 'za tunelem');
  const sftp = await startTestServer({
    root: serverRoot,
    hostKeyPath: hostKeyPath(),
  });

  const tunneled = new SftpAdapter();
  await tunneled.connect({
    host: '127.0.0.1',
    port: sftp.port,
    username: 'test',
    password: 'test',
    tunnelHost: '127.0.0.1',
    tunnelPort: sftp.port,
    tunnelUsername: 'test',
    tunnelPassword: 'test',
  }, { verifyHostKey: () => true, verifyTunnelHostKey: () => true });

  truthy('přes bránu se spojení otevře', tunneled.connected);
  check('a server je vidět', (await tunneled.list('/www')).map((e) => e.name), ['a.txt']);
  truthy('brána si drží úklid', typeof tunneled.cleanupPath === 'function');
  await tunneled.disconnect();
  check('po odpojení je úklid hotový', tunneled.cleanupPath, null);

  // Nedostupná brána nesmí skončit nesrozumitelně.
  const deadPort = await freePort();
  const broken = new SftpAdapter();
  let tunErr = null;
  try {
    await broken.connect({
      host: '127.0.0.1', port: sftp.port, username: 'test', password: 'test',
      tunnelHost: '127.0.0.1', tunnelPort: deadPort, tunnelUsername: 'test', tunnelPassword: 'test',
    }, { verifyHostKey: () => true, verifyTunnelHostKey: () => true });
  } catch (e) { tunErr = e; }
  await broken.disconnect().catch(() => {});
  truthy('nedostupná brána se ohlásí i s adresou', tunErr && /Brána 127\.0\.0\.1/.test(tunErr.message),
    tunErr ? tunErr.message.slice(0, 70) : '');

  // Bez ověřovací funkce se brána otevřít nesmí — ssh2 by sám o sobě přijal
  // jakýkoliv klíč a tunel by pak nechránil před ničím.
  const neoverena = new SftpAdapter();
  let keyErr = null;
  try {
    await neoverena.connect({
      host: '127.0.0.1', port: sftp.port, username: 'test', password: 'test',
      tunnelHost: '127.0.0.1', tunnelPort: sftp.port, tunnelUsername: 'test', tunnelPassword: 'test',
    }, { verifyHostKey: () => true });
  } catch (e) { keyErr = e; }
  await neoverena.disconnect().catch(() => {});
  truthy('bez ověření se klíč brány nepřijme', keyErr && /klíč brány nebyl potvrzen/.test(keyErr.message),
    keyErr ? keyErr.message.slice(0, 70) : 'spojení prošlo!');
  truthy('a je to označené jako odmítnutý klíč', keyErr && keyErr.hostKeyRejected);

  const odmitnuta = new SftpAdapter();
  let noErr = null;
  try {
    await odmitnuta.connect({
      host: '127.0.0.1', port: sftp.port, username: 'test', password: 'test',
      tunnelHost: '127.0.0.1', tunnelPort: sftp.port, tunnelUsername: 'test', tunnelPassword: 'test',
    }, { verifyHostKey: () => true, verifyTunnelHostKey: () => false });
  } catch (e) { noErr = e; }
  await odmitnuta.disconnect().catch(() => {});
  truthy('odmítnutý klíč brány spojení zastaví', noErr && /klíč brány nebyl potvrzen/.test(noErr.message),
    noErr ? noErr.message.slice(0, 70) : 'spojení prošlo!');

  // ================================================== bez nastavení
  const plain = await buildPath({ host: '127.0.0.1', port: 22 });
  check('bez brány i proxy se socket nevyrábí', plain.sock, null);
  plain.cleanup(); // nesmí spadnout

  // Úklid je jen zdvořilost vůči systému — testovací servery čekají se
  // zavřením na dožití spojení a na výsledku testu už nezáleží, takže na ně
  // nečekáme donekonečna.
  await Promise.race([
    Promise.all([sftp.close(), target.close(), socks.close(), authSocks.close(), http.close()]),
    sleep(2000),
  ]);
  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Test selhal výjimkou:', err);
  process.exit(1);
});
