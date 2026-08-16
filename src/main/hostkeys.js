'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * Ověřování identity SSH serveru.
 *
 * Bez tohohle přijme klient jakýkoliv klíč, který server pošle, a kdokoliv
 * mezi klientem a serverem se za něj může vydávat — heslo mu pak pošleme sami.
 * Proto se otisk klíče při prvním připojení ukáže uživateli a uloží, a při
 * dalších připojeních se porovnává.
 */

/** Otisk ve tvaru, jaký ukazuje OpenSSH: SHA256:base64 bez zarovnání. */
function fingerprint(keyBuffer) {
  const hash = crypto.createHash('sha256').update(keyBuffer).digest('base64');
  return `SHA256:${hash.replace(/=+$/, '')}`;
}

/**
 * Typ klíče je první položka SSH drátového formátu: 4 bajty délky (big endian)
 * a za nimi řetězec, např. "ssh-ed25519".
 */
function keyType(keyBuffer) {
  try {
    const len = keyBuffer.readUInt32BE(0);
    if (len <= 0 || len > 64 || keyBuffer.length < 4 + len) return 'neznámý';
    return keyBuffer.subarray(4, 4 + len).toString('ascii');
  } catch {
    return 'neznámý';
  }
}

/** Kanonický zápis hostitele tak, jak ho do known_hosts píše OpenSSH. */
function canonicalHost(host, port) {
  return Number(port) === 22 ? String(host) : `[${host}]:${port}`;
}

/**
 * Porovná jeden vzor z known_hosts s hostitelem. Zvládá i zahashované
 * záznamy (|1|salt|hash), které vzniknou při HashKnownHosts yes.
 */
function patternMatches(pattern, target) {
  if (pattern.startsWith('|1|')) {
    const [, , saltB64, hashB64] = pattern.split('|');
    if (!saltB64 || !hashB64) return false;
    const hmac = crypto.createHmac('sha1', Buffer.from(saltB64, 'base64'));
    hmac.update(target);
    return hmac.digest('base64') === hashB64;
  }
  if (pattern === target) return true;
  // OpenSSH povoluje ve vzorech * a ?
  if (pattern.includes('*') || pattern.includes('?')) {
    const rx = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    return rx.test(target);
  }
  return false;
}

function knownHostsFiles() {
  const dir = path.join(os.homedir(), '.ssh');
  return ['known_hosts', 'known_hosts2']
    .map((f) => path.join(dir, f))
    .filter((f) => fs.existsSync(f));
}

/**
 * Najde v ~/.ssh/known_hosts záznamy pro daného hostitele.
 * @returns {{fingerprints: string[], revoked: string[]}}
 */
function lookupKnownHosts(host, port, files = knownHostsFiles()) {
  const target = canonicalHost(host, port);
  const fingerprints = [];
  const revoked = [];

  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      let rest = line;
      let marker = null;
      if (rest.startsWith('@')) {
        const sp = rest.indexOf(' ');
        if (sp === -1) continue;
        marker = rest.slice(0, sp);
        rest = rest.slice(sp + 1).trim();
      }
      // @cert-authority podepisuje klíče certifikátem — na to tenhle
      // jednoduchý porovnávač nestačí, tak ho radši ignorujeme.
      if (marker === '@cert-authority') continue;

      const parts = rest.split(/\s+/);
      if (parts.length < 3) continue;
      const [hosts, , keyB64] = parts;

      if (!hosts.split(',').some((p) => patternMatches(p, target))) continue;

      let fp;
      try { fp = fingerprint(Buffer.from(keyB64, 'base64')); } catch { continue; }
      if (marker === '@revoked') revoked.push(fp);
      else fingerprints.push(fp);
    }
  }

  return { fingerprints, revoked };
}

/**
 * Rozhodne, co s klíčem, který server právě poslal. Vrací popis situace;
 * co se má stát dál (zeptat se, připojit, odmítnout) řeší volající.
 *
 * @param {Buffer} keyBuffer syrový veřejný klíč ze serveru
 * @param {string|null} storedFingerprint otisk uložený u relace
 * @returns {{fingerprint, type, verdict, knownFrom}}
 *   verdict: 'trusted' | 'unknown' | 'mismatch' | 'revoked'
 */
function classify(keyBuffer, { host, port, storedFingerprint }) {
  const fp = fingerprint(keyBuffer);
  const type = keyType(keyBuffer);
  const known = lookupKnownHosts(host, port);

  if (known.revoked.includes(fp)) {
    return { fingerprint: fp, type, verdict: 'revoked', knownFrom: 'known_hosts' };
  }
  if (storedFingerprint) {
    return storedFingerprint === fp
      ? { fingerprint: fp, type, verdict: 'trusted', knownFrom: 'relace' }
      : { fingerprint: fp, type, verdict: 'mismatch', knownFrom: 'relace', expected: storedFingerprint };
  }
  if (known.fingerprints.length) {
    return known.fingerprints.includes(fp)
      ? { fingerprint: fp, type, verdict: 'trusted', knownFrom: 'known_hosts' }
      : {
        fingerprint: fp, type, verdict: 'mismatch', knownFrom: 'known_hosts',
        expected: known.fingerprints[0],
      };
  }
  return { fingerprint: fp, type, verdict: 'unknown', knownFrom: null };
}

module.exports = {
  fingerprint, keyType, canonicalHost, patternMatches, lookupKnownHosts, classify,
};
