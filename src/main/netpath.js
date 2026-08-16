'use strict';

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('ssh2');

/**
 * Cesta k serveru, když nevede přímo.
 *
 * Dvě věci, které se dají skládat:
 *   • proxy (SOCKS5 nebo HTTP CONNECT) — typicky firemní síť
 *   • SSH tunel přes bránu — server dostupný jen z jiného stroje
 *
 * Obojí končí obyčejným socketem, který se podstrčí SSH spojení místo toho,
 * aby si ho otevíralo samo. Platí to jen pro SFTP; FTP potřebuje kromě
 * řídicího ještě datová spojení, a ta by tudy neprošla.
 */

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Obyčejné TCP spojení.
 *
 * Socket necháváme pozastavený. Kdyby tekl, data doručená mezi jednotlivými
 * kroky handshaku by se ztratila — v tu chvíli na nich nikdo neposlouchá.
 * Rozeběhne ho až ten, komu socket předáme.
 */
function tcp(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: Number(port) }, () => {
      socket.pause();
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

/**
 * Předá socket dál.
 *
 * Během handshaku je pozastavený, aby se nic neztratilo. Po výslovném
 * pause() ho ale samotné navěšení posluchače nerozeběhne, takže to musíme
 * udělat sami — a až v dalším kole smyčky událostí, kdy už si volající
 * (typicky ssh2) posluchače navěsil.
 */
function handOff(socket) {
  setImmediate(() => socket.resume());
  return socket;
}

/** Přečte ze socketu přesně `n` bajtů, aniž by ho rozeběhla. */
function read(socket, n) {
  return new Promise((resolve, reject) => {
    const done = (fn, arg) => {
      socket.off('readable', attempt);
      socket.off('error', onError);
      socket.off('end', onEnd);
      fn(arg);
    };
    const attempt = () => {
      const chunk = socket.read(n);
      if (chunk) done(resolve, chunk);
    };
    const onError = (err) => done(reject, err);
    const onEnd = () => done(reject, new Error('Protistrana spojení zavřela'));

    socket.on('readable', attempt);
    socket.once('error', onError);
    socket.once('end', onEnd);
    attempt();
  });
}

/** Přečte, dokud nenarazí na oddělovač; zbytek vrátí zpátky do proudu. */
function readUntil(socket, delimiter) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const done = (fn, arg) => {
      socket.off('readable', attempt);
      socket.off('error', onError);
      socket.off('end', onEnd);
      fn(arg);
    };
    const attempt = () => {
      const chunk = socket.read();
      if (chunk) buf = Buffer.concat([buf, chunk]);
      const at = buf.indexOf(delimiter);
      if (at === -1) return;
      const rest = buf.subarray(at + delimiter.length);
      if (rest.length) socket.unshift(rest);
      done(resolve, buf.subarray(0, at).toString('latin1'));
    };
    const onError = (err) => done(reject, err);
    const onEnd = () => done(reject, new Error('Protistrana spojení zavřela'));

    socket.on('readable', attempt);
    socket.once('error', onError);
    socket.once('end', onEnd);
    attempt();
  });
}

/** SOCKS5 podle RFC 1928, s volitelným jménem a heslem (RFC 1929). */
async function socks5(proxy, host, port) {
  const socket = await tcp(proxy.host, proxy.port);
  const useAuth = Boolean(proxy.username);

  socket.write(Buffer.from([0x05, 1, useAuth ? 0x02 : 0x00]));
  const greeting = await read(socket, 2);
  if (greeting[0] !== 0x05) throw new Error('Proxy neodpovídá jako SOCKS5');

  if (greeting[1] === 0x02) {
    if (!useAuth) throw new Error('Proxy chce jméno a heslo, ale žádné není zadané');
    const u = Buffer.from(proxy.username, 'utf8');
    const p = Buffer.from(proxy.password || '', 'utf8');
    socket.write(Buffer.concat([
      Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p,
    ]));
    const auth = await read(socket, 2);
    if (auth[1] !== 0x00) throw new Error('Proxy odmítla jméno nebo heslo');
  } else if (greeting[1] !== 0x00) {
    throw new Error('Proxy nenabídla použitelný způsob přihlášení');
  }

  // Adresu posíláme jako jméno; překlad si udělá proxy, což je u ní žádoucí.
  const name = Buffer.from(host, 'utf8');
  const req = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, Buffer.alloc(2),
  ]);
  req.writeUInt16BE(Number(port), req.length - 2);
  socket.write(req);

  const reply = await read(socket, 4);
  if (reply[1] !== 0x00) {
    const reasons = {
      1: 'obecná chyba', 2: 'zakázáno pravidly', 3: 'síť nedostupná',
      4: 'stroj nedostupný', 5: 'spojení odmítnuto', 6: 'vypršel čas',
      7: 'nepodporovaný příkaz', 8: 'nepodporovaný typ adresy',
    };
    throw new Error(`Proxy spojení nenavázala: ${reasons[reply[1]] || `kód ${reply[1]}`}`);
  }

  // Zbytek odpovědi je navázaná adresa; potřebujeme ji jen odečíst z proudu.
  if (reply[3] === 0x01) await read(socket, 4 + 2);
  else if (reply[3] === 0x03) {
    const len = await read(socket, 1);
    await read(socket, len[0] + 2);
  } else if (reply[3] === 0x04) await read(socket, 16 + 2);

  return handOff(socket);
}

/** HTTP CONNECT — jednodušší varianta, běžná u firemních proxy. */
async function httpConnect(proxy, host, port) {
  const socket = await tcp(proxy.host, proxy.port);
  const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
  if (proxy.username) {
    const auth = Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
    lines.push(`Proxy-Authorization: Basic ${auth}`);
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);

  // Cokoliv za prázdným řádkem už patří tunelu, ne hlavičce.
  const head = await readUntil(socket, '\r\n\r\n');

  const status = Number((head.split('\r\n')[0] || '').split(' ')[1]);
  if (status !== 200) throw new Error(`Proxy spojení nenavázala: ${head.split('\r\n')[0]}`);
  return handOff(socket);
}

/** Spojení k cíli přes proxy, nebo přímé když žádná není. */
async function throughProxy(proxy, host, port) {
  if (!proxy || !proxy.type || proxy.type === 'none') return tcp(host, port).then(handOff);
  if (proxy.type === 'socks5') return socks5(proxy, host, port);
  if (proxy.type === 'http') return httpConnect(proxy, host, port);
  throw new Error(`Neznámý typ proxy: ${proxy.type}`);
}

/**
 * Otevře SSH spojení k bráně a z něj protáhne spojení na cílový server.
 * Vrací proud, který se chová jako socket, a funkci na uklizení brány.
 */
function openTunnel(tunnel, targetHost, targetPort, sock) {
  return new Promise((resolve, reject) => {
    const jump = new Client();
    let settled = false;
    let keyRejected = null;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { jump.end(); } catch { /* už zavřený */ }
      // Odmítnutý klíč hlásí knihovna obecným selháním handshaku; nahradíme
      // ho tím, co se opravdu stalo.
      const text = keyRejected || err.message;
      reject(Object.assign(new Error(`Brána ${tunnel.host}: ${text}`),
        keyRejected ? { hostKeyRejected: true } : {}));
    };

    jump.on('ready', () => {
      jump.forwardOut('127.0.0.1', 0, targetHost, Number(targetPort), (err, stream) => {
        if (err) { fail(err); return; }
        settled = true;
        resolve({ stream, close: () => { try { jump.end(); } catch { /* už zavřený */ } } });
      });
    });
    jump.on('error', fail);

    const opts = {
      host: tunnel.host,
      port: Number(tunnel.port) || 22,
      username: tunnel.username,
      readyTimeout: 25000,
      // Bránu ověřujeme stejně přísně jako cíl — je to stroj, kterým jde
      // všechno ostatní, takže na ní záleží nejvíc. Bez ověřovací funkce
      // spojení neotevřeme: ssh2 by bez ní přijal jakýkoliv klíč a celý
      // tunel by pak nechránil před ničím.
      hostVerifier: (key, verify) => {
        Promise.resolve()
          .then(() => (tunnel.verifyHostKey
            ? tunnel.verifyHostKey({ keyBuffer: key })
            : false))
          .then((ok) => {
            if (!ok) keyRejected = keyRejected || 'klíč brány nebyl potvrzen';
            verify(Boolean(ok));
          })
          .catch((err) => { keyRejected = err.message; verify(false); });
      },
    };
    if (tunnel.privateKeyPath) {
      try {
        opts.privateKey = fs.readFileSync(expandHome(tunnel.privateKeyPath));
      } catch (err) { fail(err); return; }
      if (tunnel.passphrase) opts.passphrase = tunnel.passphrase;
    }
    if (tunnel.password) opts.password = tunnel.password;
    if (sock) opts.sock = sock;

    jump.connect(opts);
  });
}

/**
 * Sestaví spojení podle konfigurace relace.
 *
 * @returns {Promise<{sock: object|null, cleanup: Function}>} `sock` je null,
 *   když se má jít přímo — pak si spojení otevře knihovna sama.
 */
async function buildPath(cfg) {
  const useProxy = cfg.proxyType && cfg.proxyType !== 'none';
  const useTunnel = Boolean(cfg.tunnelHost);
  if (!useProxy && !useTunnel) return { sock: null, cleanup: () => {} };

  const proxy = useProxy ? {
    type: cfg.proxyType,
    host: cfg.proxyHost,
    port: cfg.proxyPort,
    username: cfg.proxyUsername,
    password: cfg.proxyPassword,
  } : null;

  if (!useTunnel) {
    const sock = await throughProxy(proxy, cfg.host, Number(cfg.port) || 22);
    return { sock, cleanup: () => { try { sock.destroy(); } catch { /* už zavřený */ } } };
  }

  // Proxy vede k bráně, brána k cíli.
  const jumpSock = proxy
    ? await throughProxy(proxy, cfg.tunnelHost, Number(cfg.tunnelPort) || 22)
    : null;

  const tunnel = await openTunnel({
    host: cfg.tunnelHost,
    port: cfg.tunnelPort,
    username: cfg.tunnelUsername,
    password: cfg.tunnelPassword,
    privateKeyPath: cfg.tunnelKeyPath,
    passphrase: cfg.tunnelPassphrase,
    verifyHostKey: cfg.verifyTunnelHostKey,
  }, cfg.host, Number(cfg.port) || 22, jumpSock);

  return {
    sock: tunnel.stream,
    cleanup: () => {
      tunnel.close();
      if (jumpSock) { try { jumpSock.destroy(); } catch { /* už zavřený */ } }
    },
  };
}

module.exports = {
  buildPath, throughProxy, socks5, httpConnect, openTunnel, read, readUntil, tcp, handOff,
};
