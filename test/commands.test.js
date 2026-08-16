'use strict';

/**
 * Vlastní příkazy — doplňování šablony a spouštění.
 *
 * Nejdůležitější je uzavírání do apostrofů. Dosazuje se název souboru, který
 * si zvolil někdo jiný než uživatel příkazu, takže se z něj nikdy nesmí stát
 * kus příkazu — jinak by stačil soubor pojmenovaný `; rm -rf ~`.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');
const { FtpAdapter } = require('../src/main/adapters/ftp');
const {
  shellQuote, expand, findPrompts, runLocal,
} = require('../src/main/commands');

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
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-cmd-'));

  // ============================================= uzavírání do apostrofů
  check('obyčejné slovo', shellQuote('soubor.txt'), "'soubor.txt'");
  check('mezera', shellQuote('muj soubor.txt'), "'muj soubor.txt'");
  check('prázdná hodnota', shellQuote(''), "''");
  check('apostrof uvnitř', shellQuote("Pepa's"), "'Pepa'\\''s'");
  check('středník ztrácí význam', shellQuote('a; rm -rf ~'), "'a; rm -rf ~'");
  check('zpětný apostrof taky', shellQuote('$(whoami)'), "'$(whoami)'");

  // ================================================= doplnění šablony
  const ctx = {
    file: '/var/www/muj soubor.txt',
    files: ['/var/www/a.txt', '/var/www/b.txt'],
    remoteDir: '/var/www',
    localDir: '/Users/kdo/projekt',
  };

  check('cesta k souboru', expand('cat !', ctx), "cat '/var/www/muj soubor.txt'");
  check('název bez cesty', expand('echo !N', ctx), "echo 'muj soubor.txt'");
  check('všechny vybrané', expand('tar czf a.tgz !&', ctx),
    "tar czf a.tgz '/var/www/a.txt' '/var/www/b.txt'");
  check('vzdálený adresář', expand('ls !/', ctx), "ls '/var/www'");
  check('lokální adresář', expand('open !\\', ctx), "open '/Users/kdo/projekt'");
  check('kombinace', expand('cp ! !/', ctx), "cp '/var/www/muj soubor.txt' '/var/www'");

  // Tohle je ta pojistka: nebezpečný název zůstane jedním argumentem.
  check('nebezpečný název neuteče',
    expand('rm !', { file: '/tmp/a.txt; rm -rf ~' }), "rm '/tmp/a.txt; rm -rf ~'");

  check('dvojitý vykřičník je jeden', expand('echo Hotovo!!', ctx), 'echo Hotovo!');
  check('a nepohltí ho dosazování', expand('echo !! ! ', ctx), "echo ! '/var/www/muj soubor.txt' ");
  check('bez souboru zbude prázdno', expand('cat !', {}), "cat ''");

  // ====================================================== dotazy
  const withPrompt = 'grep -r !?Co hledat?TODO! !/';
  check('dotaz se najde', findPrompts(withPrompt).map((p) => [p.question, p.value]),
    [['Co hledat', 'TODO']]);
  check('bez odpovědi platí výchozí', expand(withPrompt, ctx), "grep -r 'TODO' '/var/www'");
  check('s odpovědí se dosadí',
    expand(withPrompt, { ...ctx, answers: { 'Co hledat': 'FIXME' } }), "grep -r 'FIXME' '/var/www'");
  check('odpověď se taky uzavře',
    expand(withPrompt, { ...ctx, answers: { 'Co hledat': "a'b; ls" } }), "grep -r 'a'\\''b; ls' '/var/www'");
  check('bez dotazů nic nenajde', findPrompts('ls -la').length, 0);

  // ============================================ spuštění na tomhle počítači
  const local = await runLocal('echo ahoj', { cwd: tmp });
  check('lokální příkaz projde', local.code, 0);
  check('a vrátí výstup', local.output.trim(), 'ahoj');

  const failing = await runLocal('exit 3', { cwd: tmp });
  check('návratový kód se hlásí', failing.code, 3);

  const stderr = await runLocal('echo chyba 1>&2', { cwd: tmp });
  check('chybový výstup se sbírá taky', stderr.output.trim(), 'chyba');

  const chunks = [];
  await runLocal('echo prvni; echo druhy', { cwd: tmp, onData: (t, k) => chunks.push([k, t.trim()]) });
  truthy('výstup chodí průběžně', chunks.length > 0, `${chunks.length} dávek`);

  await fsp.writeFile(path.join(tmp, 'v adresari.txt'), 'obsah');
  const inDir = await runLocal(expand('cat !N', { file: path.join(tmp, 'v adresari.txt') }), { cwd: tmp });
  check('název s mezerou funguje i doopravdy', inDir.output, 'obsah');

  const cut = await runLocal('echo 12345678901234567890', { cwd: tmp, maxOutput: 5 });
  check('dlouhý výstup se ořízne', cut.truncated, true);
  check('a je vidět jen začátek', cut.output.length, 5);

  let slow = null;
  try { await runLocal('sleep 5', { cwd: tmp, timeoutMs: 400 }); } catch (e) { slow = e; }
  truthy('dlouhý příkaz se přeruší', slow && /déle než/.test(slow.message));

  // ================================================= spuštění na serveru
  const serverRoot = path.join(tmp, 'server');
  await fsp.mkdir(path.join(serverRoot, 'www'), { recursive: true });
  const server = await startTestServer({ root: serverRoot, hostKeyPath: path.join(__dirname, 'fixtures', 'host_key') });
  const adapter = new SftpAdapter();
  await adapter.connect(
    { host: '127.0.0.1', port: server.port, username: 'test', password: 'test' },
    { verifyHostKey: () => true },
  );

  const hello = await adapter.exec('echo ahoj');
  check('příkaz na serveru projde', hello.code, 0);
  check('a vrátí výstup', hello.output.trim(), 'ahoj');

  // Pracovní adresář se vkládá před příkaz — každé spuštění je jiný shell,
  // takže by se jinak běželo v domovském adresáři.
  const wwwDir = path.join(serverRoot, 'www');
  await fsp.writeFile(path.join(wwwDir, 'zdejsi.txt'), 'jsem ve www');
  const inCwd = await adapter.exec('cat zdejsi.txt', { cwd: '/www' });
  check('pracovní adresář platí', inCwd.output.trim(), 'jsem ve www');

  const noCwd = await adapter.exec('cat zdejsi.txt');
  truthy('bez pracovního adresáře se soubor nenajde', noCwd.code !== 0);

  const bad = await adapter.exec('exit 4');
  check('návratový kód ze serveru', bad.code, 4);

  const errOut = await adapter.exec('echo chyba 1>&2');
  check('chybový výstup ze serveru', errOut.output.trim(), 'chyba');

  const streamed = [];
  await adapter.exec('echo a; echo b', { onData: (t, k) => streamed.push([k, t.trim()]) });
  truthy('výstup ze serveru chodí průběžně', streamed.length > 0, `${streamed.length} dávek`);

  // Celý smysl uzavírání do apostrofů: název souboru se nesmí stát příkazem.
  await fsp.writeFile(path.join(wwwDir, 'a; touch HACKED'), 'nevinny obsah');
  const dangerous = await adapter.exec(expand('cat !N', { file: '/www/a; touch HACKED' }), { cwd: '/www' });
  check('nebezpečný název se přečte jako soubor', dangerous.output.trim(), 'nevinny obsah');
  check('a nic navíc nevzniklo', fs.existsSync(path.join(wwwDir, 'HACKED')), false);

  const cutRemote = await adapter.exec('echo 1234567890', { maxOutput: 4 });
  check('dlouhý výstup ze serveru se ořízne', cutRemote.truncated, true);

  let slowRemote = null;
  try { await adapter.exec('sleep 5', { timeoutMs: 500 }); } catch (e) { slowRemote = e; }
  truthy('dlouhý příkaz na serveru se přeruší', slowRemote && /déle než/.test(slowRemote.message));

  const ftp = new FtpAdapter();
  let ftpErr = null;
  try { ftp.exec('ls'); } catch (e) { ftpErr = e; }
  truthy('u FTP se rovnou řekne, že to nejde', ftpErr && /jen SFTP/.test(ftpErr.message));

  await adapter.disconnect();
  await server.close();
  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Test selhal výjimkou:', err);
  process.exit(1);
});
