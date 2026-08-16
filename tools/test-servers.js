'use strict';

/**
 * Dva testovací servery pro ruční zkoušení Charona.
 *
 * Jeden SFTP a jeden FTP, aby šly zkusit obě větve — chovají se každý jinak
 * (FTP nemá shell, hlásí čas jen na minuty, neumí změnu vlastníka). Data leží
 * v `test-data/` vedle projektu a zůstávají mezi spuštěními.
 *
 *   npm run servers
 *
 * Servery poslouchají jen na 127.0.0.1 a mají pevné testovací údaje, takže
 * nemají co dělat nikde jinde než na vývojovém stroji.
 */

const fs = require('fs');
const path = require('path');

const { FtpSrv } = require('ftp-srv');
const { startTestServer } = require('../test/sftp-server');

const ROOT = path.join(__dirname, '..', 'test-data');
const SFTP_PORT = 2222;
const FTP_PORT = 2121;
const USER = 'test';
const PASSWORD = 'test';

/** Ukázkový web, ať je s čím pracovat. Existující soubory nepřepisujeme. */
function seed(root, jmeno) {
  const write = (rel, content) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (!fs.existsSync(full)) fs.writeFileSync(full, content);
  };

  write('www/index.php', `<?php\n// ${jmeno}\necho "Vítejte na ${jmeno}";\n`);
  write('www/style.css', 'body { font: 16px/1.5 system-ui; margin: 2rem; }\n');
  write('www/.htaccess', 'RewriteEngine On\n');
  write('www/README.md', `# ${jmeno}\n\nTestovací obsah pro Charona.\n`);
  write('www/assets/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"/>\n');
  write('www/logs/app.log', 'záznam '.repeat(500));
  write('www/logs/stare/2025.log', 'starý záznam\n');
  write('www/vendor/balik/index.js', 'module.exports = {};\n');
}

async function startSftp() {
  const root = path.join(ROOT, 'sftp');
  fs.mkdirSync(root, { recursive: true });
  seed(root, 'SFTP server');

  const s = await startTestServer({
    root,
    hostKeyPath: path.join(__dirname, '..', 'test', 'fixtures', 'host_key'),
    user: USER,
    password: PASSWORD,
    port: SFTP_PORT,
  });
  return { name: 'SFTP', port: s.port, root, close: s.close };
}

async function startFtp() {
  const root = path.join(ROOT, 'ftp');
  fs.mkdirSync(root, { recursive: true });
  seed(root, 'FTP server');

  const server = new FtpSrv({
    url: `ftp://127.0.0.1:${FTP_PORT}`,
    pasv_url: '127.0.0.1',
    anonymous: false,
    log: {
      trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; },
    },
  });
  server.on('login', ({ username, password }, resolve, reject) => {
    if (username === USER && password === PASSWORD) resolve({ root });
    else reject(new Error('Špatné přihlašovací údaje'));
  });
  await server.listen();
  return { name: 'FTP', port: FTP_PORT, root, close: () => server.close() };
}

async function main() {
  const servers = [await startSftp(), await startFtp()];

  console.log('\nTestovací servery běží:\n');
  for (const s of servers) {
    console.log(`  ${s.name.padEnd(5)} 127.0.0.1:${s.port}   ${USER} / ${PASSWORD}`);
    console.log(`        data: ${s.root}`);
  }
  console.log('\nVzdálený adresář: /www');
  console.log('Ukončíte je Ctrl+C.\n');

  const stop = async () => {
    console.log('\nZastavuji…');
    await Promise.all(servers.map((s) => Promise.resolve(s.close()).catch(() => {})));
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error('Servery se nepodařilo spustit:', err.message);
  process.exit(1);
});
