'use strict';

/**
 * Klíče a certifikáty pro testovací servery.
 *
 * Vyrábějí se za běhu, ne aby ležely v repozitáři. Jsou to sice klíče
 * k serverům na `127.0.0.1`, které existují jen po dobu jednoho testu, ale
 * privátní klíč ve veřejném repozitáři nemá co dělat — hlídače tajemství to
 * hlásí, lidi to mate a jednou by se podle toho vzoru uložil klíč, na kterém
 * záleží.
 *
 * Vyrobené soubory se schovají do dočasné složky a při dalším spuštění se
 * použijí znovu; generování dvou certifikátů a klíče stojí kolem vteřiny
 * a není důvod ho platit u každého testu zvlášť. Smazat je jde kdykoliv —
 * příště se udělají nové.
 *
 * Používá `ssh-keygen` a `openssl`, které jsou na macOS v systému. Test na
 * otisk certifikátu volá `openssl` stejně tak, takže tím nepřibyla závislost.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(os.tmpdir(), 'charon-test-fixtures');

/** Vytvoří soubor, jen když chybí. Zápis jde přes dočasné jméno. */
function jednou(cil, vyrob) {
  if (fs.existsSync(cil)) return cil;
  fs.mkdirSync(DIR, { recursive: true });
  const rozdelano = `${cil}.${process.pid}.tmp`;
  vyrob(rozdelano);
  // Přejmenování je atomické: souběžný běh buď uvidí hotový soubor, nebo si
  // vyrobí vlastní a přepíše ten náš toutéž věcí.
  fs.renameSync(rozdelano, cil);
  return cil;
}

function nastroj(prikaz, argumenty) {
  try {
    execFileSync(prikaz, argumenty, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    const duvod = err.stderr ? String(err.stderr).trim().split('\n').pop() : err.message;
    throw new Error(`Testovací klíče se nepodařilo vyrobit — ${prikaz} skončil chybou: ${duvod}`);
  }
}

/**
 * Klíč serveru pro testovací SFTP.
 *
 * Ed25519 v OpenSSH formátu, protože přesně tomu `ssh2` rozumí bez řečí.
 */
function hostKeyPath() {
  const cil = path.join(DIR, 'host_key');
  if (fs.existsSync(cil)) return cil;
  fs.mkdirSync(DIR, { recursive: true });
  const rozdelano = `${cil}.${process.pid}.tmp`;
  // ssh-keygen si dělá i soubor s veřejnou částí a odmítá psát přes existující.
  for (const f of [rozdelano, `${rozdelano}.pub`]) fs.rmSync(f, { force: true });
  nastroj('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'charon-test', '-f', rozdelano]);
  fs.renameSync(rozdelano, cil);
  fs.renameSync(`${rozdelano}.pub`, `${cil}.pub`);
  return cil;
}

/**
 * Vlastnoručně podepsaný certifikát pro testovací FTPS.
 *
 * @param {string} jmeno rozlišuje víc certifikátů; test na výměnu certifikátu
 *   potřebuje dva různé, aby se otisk opravdu změnil.
 */
function certPaths(jmeno = 'ftps') {
  const key = path.join(DIR, `${jmeno}_key.pem`);
  const cert = path.join(DIR, `${jmeno}_cert.pem`);
  if (fs.existsSync(key) && fs.existsSync(cert)) return { key, cert };

  fs.mkdirSync(DIR, { recursive: true });
  const kTmp = `${key}.${process.pid}.tmp`;
  const cTmp = `${cert}.${process.pid}.tmp`;
  nastroj('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
    '-keyout', kTmp, '-out', cTmp,
    '-subj', '/CN=localhost/O=Charon Test',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  fs.renameSync(kTmp, key);
  fs.renameSync(cTmp, cert);
  return { key, cert };
}

/** Smaže vyrobené soubory; příští spuštění si udělá nové. */
async function forget() {
  await fsp.rm(DIR, { recursive: true, force: true });
}

module.exports = {
  DIR, hostKeyPath, certPaths, forget, jednou,
};
