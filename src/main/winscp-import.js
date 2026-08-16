'use strict';

const fs = require('fs');

/**
 * Import uložených relací z WinSCP.
 *
 * WinSCP hesla nešifruje, jen obfuskuje — reverzibilním algoritmem, jehož
 * "klíčem" je řetězec UserName + HostName. Tenhle modul ho umí rozbalit zpět,
 * takže se dají relace přenést včetně hesel.
 *
 * Podporované vstupy:
 *   • WinSCP.ini              (portable režim nebo Options → Preferences → Storage → INI)
 *   • export konfigurace      (WinSCP: Tools → Export/Backup Configuration)
 *   • .reg soubor             (regedit → export HKCU\Software\Martin Prikryl\WinSCP 2)
 *
 * Výjimka: pokud má WinSCP nastavené Master Password, hesla jsou navíc
 * zašifrovaná AES a takhle je vytáhnout nejde — to hlásíme volajícímu.
 */

const PW_FLAG = 0xff;
const PW_MAGIC = 0xa3;
const HEX = '0123456789ABCDEF';

function decryptPassword(stored, username, hostname) {
  if (!stored) return '';
  const s = String(stored).toUpperCase().replace(/[^0-9A-F]/g, '');
  const state = { s, pos: 0 };

  const next = () => {
    if (state.pos + 1 >= state.s.length) return 0;
    const hi = HEX.indexOf(state.s[state.pos]);
    const lo = HEX.indexOf(state.s[state.pos + 1]);
    state.pos += 2;
    return ~(((hi << 4) + lo) ^ PW_MAGIC) & 0xff;
  };

  const flag = next();
  let length;
  if (flag === PW_FLAG) {
    next(); // rezervovaný bajt
    length = next();
  } else {
    length = flag;
  }

  // Pozor: `state.pos += next() * 2` by nefungovalo — JS přečte state.pos
  // dřív, než next() stihne posunout pozici, a inkrement by se ztratil.
  const padding = next();
  state.pos += padding * 2; // náhodná výplň na začátku

  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) bytes[i] = next();
  let out = bytes.toString('utf8');

  if (flag === PW_FLAG) {
    const key = `${username}${hostname}`;
    // Kontrolní prefix — když nesedí, heslo patří jinému hostu/uživateli
    // nebo je zašifrované master heslem.
    if (!out.startsWith(key)) return null;
    out = out.slice(key.length);
  }
  return out;
}

/** WinSCP escapuje v názvech relací i v hodnotách znaky jako %XX. */
function unescapeWinscp(value) {
  if (typeof value !== 'string' || !value.includes('%')) return value;
  return value.replace(/%([0-9A-Fa-f]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// ---------------------------------------------------------------- parsování

function parseIni(text) {
  const sections = new Map();
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = /^\[(.*)\]$/.exec(line);
    if (header) {
      current = {};
      sections.set(header[1], current);
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    current[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return sections;
}

function parseReg(text) {
  const sections = new Map();
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';')) continue;
    const header = /^\[(.*)\]$/.exec(line);
    if (header) {
      // Zajímá nás jen část cesty za "WinSCP 2\"
      const m = /Martin Prikryl\\WinSCP 2\\(.*)$/i.exec(header[1]);
      current = {};
      sections.set(m ? m[1] : header[1], current);
      continue;
    }
    if (!current) continue;
    const kv = /^"([^"]*)"=(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    let value;
    if (rawValue.startsWith('dword:')) {
      value = String(parseInt(rawValue.slice(6), 16));
    } else if (rawValue.startsWith('"')) {
      value = rawValue.slice(1, rawValue.lastIndexOf('"')).replace(/\\\\/g, '\\').replace(/\\"/g, '"');
    } else {
      continue; // binární/hex hodnoty nepotřebujeme
    }
    current[key] = value;
  }
  return sections;
}

// ------------------------------------------------------------ mapování polí

// TFSProtocol z WinSCP: 0=SCP, 1=SFTP s fallbackem na SCP, 2=SFTP,
// 5=FTP, 6=WebDAV, 7=S3. Hodnoty 3 a 4 jsou historické a nepoužívají se.
const FS_PROTOCOL = { 0: 'scp', 1: 'sftp', 2: 'sftp', 5: 'ftp', 6: 'webdav', 7: 's3' };

// TFtps: 0=žádné, 1=implicitní, 2=explicitní SSL, 3=explicitní TLS
const FTPS_MODE = { 0: 'none', 1: 'implicit', 2: 'explicit', 3: 'explicit' };

function mapSession(name, values) {
  const host = unescapeWinscp(values.HostName || '');
  const username = unescapeWinscp(values.UserName || '');
  const fsRaw = values.FSProtocol !== undefined ? Number(values.FSProtocol) : null;
  const port = values.PortNumber !== undefined ? Number(values.PortNumber) : null;

  // FSProtocol se do konfigurace neukládá, když má výchozí hodnotu (SFTP).
  // Port 21 / 990 je pak spolehlivější vodítko než výchozí hodnota.
  let protocol = fsRaw !== null ? (FS_PROTOCOL[fsRaw] || 'sftp') : (port === 21 || port === 990 ? 'ftp' : 'sftp');

  const ftps = FTPS_MODE[Number(values.Ftps || 0)] || 'none';

  const decrypted = values.Password ? decryptPassword(values.Password, username, host) : '';
  const passphrase = values.Passphrase ? decryptPassword(values.Passphrase, username, host) : '';

  return {
    name: unescapeWinscp(name),
    host,
    username,
    port: port || (protocol === 'ftp' ? (ftps === 'implicit' ? 990 : 21) : 22),
    protocol,
    ftps: protocol === 'ftp' ? ftps : 'none',
    password: decrypted || '',
    passphrase: passphrase || '',
    passwordFailed: Boolean(values.Password) && decrypted === null,
    privateKeyPath: unescapeWinscp(values.PublicKeyFile || ''),
    remoteDir: unescapeWinscp(values.RemoteDirectory || ''),
    localDir: unescapeWinscp(values.LocalDirectory || ''),
    // Protokoly, které tenhle klient neumí, projdou importem, ale označíme je.
    supported: protocol === 'sftp' || protocol === 'ftp',
    rawProtocol: protocol,
  };
}

/**
 * Načte soubor a vrátí přehled nalezených relací.
 * @returns {{sessions: Array, masterPassword: boolean, format: string, total: number}}
 */
function parseWinscpFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  const isReg = /^\s*Windows Registry Editor/i.test(text) || /HKEY_CURRENT_USER/i.test(text);
  const sections = isReg ? parseReg(text) : parseIni(text);

  const security = sections.get('Configuration\\Security') || {};
  const masterPassword = String(security.UseMasterPassword || '0') === '1';

  const sessions = [];
  for (const [key, values] of sections) {
    const m = /^Sessions\\(.+)$/.exec(key);
    if (!m) continue;
    if (m[1] === 'Default%20Settings') continue;
    if (!values.HostName) continue; // složky bez hostitele nejsou relace
    sessions.push(mapSession(m[1], values));
  }

  sessions.sort((a, b) => a.name.localeCompare(b.name, 'cs'));

  return {
    sessions,
    masterPassword,
    format: isReg ? 'reg' : 'ini',
    total: sessions.length,
  };
}

module.exports = { parseWinscpFile, decryptPassword, unescapeWinscp };
