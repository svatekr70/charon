// Ověření dekodéru WinSCP hesel proti dokumentovanému formátu.
// Sestavíme uložený řetězec přesně tak, jak ho tvoří WinSCP, a dekódujeme zpět.
const {
  decryptPassword, parseWinscpFile, unescapeWinscp, repairMojibake,
} = require('../src/main/winscp-import.js');
const fs = require('fs');

const MAGIC = 0xa3;
const FLAG = 0xff;
const enc = (v) => (((~v & 0xff) ^ MAGIC) & 0xff).toString(16).toUpperCase().padStart(2, '0');

function winscpEncrypt(password, username, host, padLen = 5) {
  const payload = Buffer.from(`${username}${host}${password}`, 'utf8');
  const out = [enc(FLAG), enc(0x00), enc(payload.length), enc(padLen)];
  for (let i = 0; i < padLen; i++) out.push(enc((i * 37 + 11) & 0xff)); // libovolná výplň
  for (const b of payload) out.push(enc(b));
  return out.join('');
}

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

check('ASCII heslo', decryptPassword(winscpEncrypt('Tajne123!', 'root', 'example.com'), 'root', 'example.com'), 'Tajne123!');
check('prazdna vypln', decryptPassword(winscpEncrypt('abc', 'u', 'h', 0), 'u', 'h'), 'abc');
check('UTF-8 heslo', decryptPassword(winscpEncrypt('heslíčko-ěščř', 'jan', 'server.cz'), 'jan', 'server.cz'), 'heslíčko-ěščř');
check('dlouhe heslo', decryptPassword(winscpEncrypt('x'.repeat(60), 'a', 'b'), 'a', 'b'), 'x'.repeat(60));
check('spatny klic -> null', decryptPassword(winscpEncrypt('abc', 'root', 'a.cz'), 'jiny', 'b.cz'), null);
check('prazdny vstup', decryptPassword('', 'u', 'h'), '');

// Starý formát bez FLAG: první bajt je rovnou délka, klíč se nepoužívá.
function legacyEncrypt(password, padLen = 3) {
  const payload = Buffer.from(password, 'utf8');
  const out = [enc(payload.length), enc(padLen)];
  for (let i = 0; i < padLen; i++) out.push(enc(i + 7));
  for (const b of payload) out.push(enc(b));
  return out.join('');
}
check('stary format bez klice', decryptPassword(legacyEncrypt('legacy'), 'kdokoliv', 'kdekoliv'), 'legacy');

// --- test parsování celého INI ---
const ini = `[Configuration\\Security]
UseMasterPassword=0

[Sessions\\Default%20Settings]
HostName=

[Sessions\\produkce%20web]
HostName=web.example.com
UserName=deploy
PortNumber=2222
FSProtocol=2
RemoteDirectory=/var/www/html
Password=${winscpEncrypt('S3cret!', 'deploy', 'web.example.com')}

[Sessions\\klienti/starej%20ftp]
HostName=ftp.klient.cz
UserName=admin
PortNumber=21
FSProtocol=5
Ftps=3
Password=${winscpEncrypt('ftpheslo', 'admin', 'ftp.klient.cz')}

[Sessions\\klic%20jen]
HostName=git.example.com
UserName=git
FSProtocol=2
PublicKeyFile=C%3A%5CUsers%5Cjan%5Ckey.ppk
`;
const p = require('path').join(require('os').tmpdir(), 'winscp-test.ini');
fs.writeFileSync(p, ini);
const r = parseWinscpFile(p);
console.log('\n--- INI parse ---');
console.log(JSON.stringify(r, null, 2));
check('pocet relaci', r.total, 3);
check('nazev se slozkou', r.sessions.find(s => s.host === 'ftp.klient.cz').name, 'klienti/starej ftp');
check('sftp heslo', r.sessions.find(s => s.host === 'web.example.com').password, 'S3cret!');
check('ftp heslo', r.sessions.find(s => s.host === 'ftp.klient.cz').password, 'ftpheslo');
check('ftps rezim', r.sessions.find(s => s.host === 'ftp.klient.cz').ftps, 'explicit');
check('cesta ke klici', r.sessions.find(s => s.host === 'git.example.com').privateKeyPath, 'C:\\Users\\jan\\key.ppk');
check('default port sftp', r.sessions.find(s => s.host === 'git.example.com').port, 22);

// --- test parsování .reg ---
const reg = `Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\\Software\\Martin Prikryl\\WinSCP 2\\Sessions\\reg%20relace]
"HostName"="reg.example.com"
"UserName"="petr"
"PortNumber"=dword:0000232a
"FSProtocol"=dword:00000002
"Password"="${winscpEncrypt('regheslo', 'petr', 'reg.example.com')}"
`;
const p2 = p.replace('WinSCP.ini', 'winscp.reg');
fs.writeFileSync(p2, reg);
const r2 = parseWinscpFile(p2);
console.log('\n--- REG parse ---');
console.log(JSON.stringify(r2, null, 2));
check('reg format', r2.format, 'reg');
check('reg heslo', r2.sessions[0].password, 'regheslo');
check('reg port (0x232a=9002)', r2.sessions[0].port, 9002);

// ============ diakritika v názvech
// WinSCP escapuje neanglické znaky jako %XX — jsou to bajty UTF-8, takže se
// musí posbírat a přečíst najednou. Znak po znaku z „Š" vznikne „Å ".
check('escapovaná diakritika se přečte celá',
  unescapeWinscp('%C5%A0%C3%A1rka Dvorsk%C3%A1'), 'Šárka Dvorská');
check('značka pořadí bajtů se zahodí', unescapeWinscp('%EF%BB%BFPraha'), 'Praha');
check('text bez escapování projde beze změny', unescapeWinscp('Ollero'), 'Ollero');
check('escapované ASCII taky', unescapeWinscp('a%2Db'), 'a-b');

// ============ náprava už uložených názvů
check('rozsypaný název se opraví', repairMojibake('ï»¿BlaÅ¾o'), 'Blažo');
check('a zdravý zůstane', repairMojibake('Testovací'), 'Testovací');
check('anglický taky', repairMojibake('EverFLOW'), 'EverFLOW');
check('prázdný vstup nespadne', repairMojibake(''), '');
check('undefined taky ne', repairMojibake(undefined), undefined);

console.log(`\n${pass} prošlo, ${fail} selhalo`);
process.exit(fail ? 1 : 0);
