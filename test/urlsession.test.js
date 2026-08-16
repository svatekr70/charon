'use strict';

/**
 * Adresa relace.
 *
 * Dvě věci tu stojí za hlídání: že se z adresy nedá vyrobit připojení jinam,
 * než kam ukazuje, a že se heslo nikdy nedostane do adresy ke zkopírování —
 * ta se často ocitne v chatu nebo v ticketu, kde už zůstane.
 */

const U = require('../src/common/urlsession');

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
const kratce = (u) => {
  const p = U.parse(u);
  return `${p.protocol}${p.ftps !== 'none' ? `/${p.ftps}` : ''} ${p.username}@${p.host}:${p.port}${p.remoteDir}`;
};

function main() {
  // ================================================ rozbor
  check('plná adresa', kratce('sftp://web@server.test:2222/var/www'), 'sftp web@server.test:2222/var/www');
  check('bez portu se doplní výchozí', kratce('sftp://web@server.test/x'), 'sftp web@server.test:22/x');
  check('FTP má jiný výchozí port', kratce('ftp://web@server.test/x'), 'ftp web@server.test:21/x');
  check('FTPS je FTP se šifrováním', kratce('ftps://web@server.test/'), 'ftp/explicit web@server.test:21');
  check('implicitní FTPS má port 990', kratce('ftpis://web@server.test/'), 'ftp/implicit web@server.test:990');
  check('bez schématu se předpokládá SFTP', kratce('web@server.test/x'), 'sftp web@server.test:22/x');
  check('bez uživatele', kratce('sftp://server.test/x'), 'sftp @server.test:22/x');
  check('bez cesty', kratce('sftp://server.test'), 'sftp @server.test:22');
  check('samotné lomítko není cesta', U.parse('sftp://server.test/').remoteDir, '');

  // ================================================ znaky v adrese
  check('procenta v cestě se přeloží', U.parse('sftp://s.test/slo%C5%BEka').remoteDir, '/složka');
  check('mezera jako %20', U.parse('sftp://s.test/a%20b').remoteDir, '/a b');
  check('uživatel s tečkou', U.parse('sftp://jan.novak@s.test/').username, 'jan.novak');
  check('zavináč v uživateli přes %40', U.parse('sftp://web%40firma@s.test/').username, 'web@firma');
  check('heslo se přečte, když ho někdo pošle', U.parse('sftp://web:tajne@s.test/').password, 'tajne');

  // ================================================ co je špatně
  const chyba = (u) => { try { U.parse(u); return null; } catch (e) { return e.message; } };
  truthy('prázdná adresa se ohlásí', /Zadejte adresu/.test(chyba('')), chyba(''));
  truthy('neznámý protokol se ohlásí i s výčtem',
    /SCP neumíme/.test(chyba('scp://s.test/x')), chyba('scp://s.test/x'));
  truthy('adresa bez serveru se ohlásí', chyba('sftp:///cesta'), chyba('sftp:///cesta'));
  truthy('naprostý nesmysl taky', chyba('http://'), chyba('http://'));

  // ================================================ sestavení zpátky
  const cfg = { protocol: 'sftp', host: 'server.test', port: 22, username: 'web', password: 'tajne' };
  check('adresa bez výchozího portu', U.format(cfg, '/var/www'), 'sftp://web@server.test/var/www');
  check('nestandardní port se uvede',
    U.format({ ...cfg, port: 2222 }, '/x'), 'sftp://web@server.test:2222/x');
  check('FTP schéma', U.format({ ...cfg, protocol: 'ftp', port: 21, ftps: 'none' }, '/x'), 'ftp://web@server.test/x');
  check('FTPS schéma', U.format({ ...cfg, protocol: 'ftp', port: 21, ftps: 'explicit' }, '/x'), 'ftps://web@server.test/x');

  // Tohle je ta podstatná kontrola.
  truthy('heslo se do adresy nikdy nedostane', !U.format(cfg, '/x').includes('tajne'), U.format(cfg, '/x'));

  check('lomítka v cestě zůstanou lomítky', U.format(cfg, '/a/b/c'), 'sftp://web@server.test/a/b/c');
  check('diakritika se zakóduje', U.format(cfg, '/složka'), 'sftp://web@server.test/slo%C5%BEka');
  check('mezera taky', U.format(cfg, '/a b'), 'sftp://web@server.test/a%20b');

  // ================================================ tam a zpátky
  const puvodni = 'sftp://web@server.test:2222/var/www/složka s mezerou';
  const tam = U.parse(puvodni);
  check('cesta přežije cestu tam a zpět', U.parse(U.format(tam, tam.remoteDir)).remoteDir, '/var/www/složka s mezerou');

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main();
