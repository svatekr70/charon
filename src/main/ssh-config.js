'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Čtení `~/.ssh/config`.
 *
 * Kdo na Macu pracuje se servery, má je popsané tady — včetně uživatelů,
 * klíčů a bran. Import z WinSCP dává smysl pro přechod z Windows, tohle je
 * přirozenější zdroj pro každý další den.
 *
 * Napodobujeme pravidla OpenSSH v rozsahu, který je k něčemu:
 *   • klíčová slova jsou bez ohledu na velikost písmen, oddělovač mezera i `=`
 *   • bloky `Host` se vyhodnocují popořadě a **první nalezená hodnota platí**
 *     (proto `Host *` na konci souboru funguje jako výchozí nastavení)
 *   • vzory se zástupnými znaky nejsou servery, ale šablony — samy o sobě se
 *     neimportují, jen přispívají nastavením
 *   • `Include` se načítá včetně hvězdičky v názvu, do rozumné hloubky
 *
 * Bloky `Match` neumíme; jejich podmínky (uživatel, síť, výsledek příkazu)
 * nejde vyhodnotit bez kontextu skutečného spojení, takže se přeskakují.
 */

const MAX_INCLUDE_DEPTH = 5;

function expandHome(p, home = os.homedir()) {
  if (!p) return p;
  if (p === '~') return home;
  return p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

/** Odstraní uvozovky, kterými se ve configu obalují hodnoty s mezerami. */
function unquote(v) {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Rozloží soubor na bloky.
 *
 * @returns {Array<{patterns: string[], settings: object, from: string}>}
 */
function parse(text, from = '') {
  const blocks = [];
  let current = null;
  let skipping = false;      // uvnitř bloku Match, kterému nerozumíme

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;

    // „Klíč hodnota" i „Klíč=hodnota"
    const m = line.match(/^([A-Za-z][A-Za-z0-9-]*)\s*=?\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = unquote(m[2]);

    if (key === 'host') {
      skipping = false;
      current = { patterns: value.split(/\s+/).filter(Boolean), settings: {}, from };
      blocks.push(current);
      continue;
    }
    if (key === 'match') {
      skipping = true;
      current = null;
      continue;
    }
    if (skipping) continue;

    if (!current) {
      // Nastavení před prvním Host platí globálně, jako by stálo v `Host *`.
      current = { patterns: ['*'], settings: {}, from };
      blocks.push(current);
    }
    // První hodnota vyhrává, tak si tu pozdější nepřepisujeme.
    if (current.settings[key] === undefined) current.settings[key] = value;
  }

  return blocks;
}

/** Načte soubor i s tím, co k sobě přibírá přes Include. */
function load(file, depth = 0, seen = new Set()) {
  const full = expandHome(file);
  if (depth > MAX_INCLUDE_DEPTH || seen.has(full)) return [];
  seen.add(full);

  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    return [];
  }

  const blocks = parse(text, full);
  const out = [];
  for (const block of blocks) {
    out.push(block);
    if (!block.settings.include) continue;
    for (const pattern of block.settings.include.split(/\s+/).filter(Boolean)) {
      for (const inc of resolveInclude(pattern, path.dirname(full))) {
        out.push(...load(inc, depth + 1, seen));
      }
    }
  }
  return out;
}

/** Cesty, na které ukazuje Include — včetně jednoduché hvězdičky v názvu. */
function resolveInclude(pattern, baseDir) {
  const p = expandHome(pattern);
  const abs = path.isAbsolute(p) ? p : path.join(baseDir, p);
  if (!abs.includes('*') && !abs.includes('?')) return [abs];

  const dir = path.dirname(abs);
  const name = path.basename(abs);
  const rx = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  try {
    return fs.readdirSync(dir).filter((f) => rx.test(f)).sort().map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Odpovídá alias vzoru z `Host`? Zástupné znaky jako v OpenSSH. */
function matches(pattern, alias) {
  if (pattern.startsWith('!')) return false;   // negace řešíme zvlášť
  const rx = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return rx.test(alias);
}

/** Platí blok pro tenhle alias? Vykřičník před vzorem ho vylučuje. */
function blockApplies(block, alias) {
  const negated = block.patterns.filter((p) => p.startsWith('!'));
  if (negated.some((p) => matches(p.slice(1), alias))) return false;
  return block.patterns.some((p) => !p.startsWith('!') && matches(p, alias));
}

/** Výsledné nastavení pro daný alias — první nalezená hodnota vyhrává. */
function settingsFor(blocks, alias) {
  const out = {};
  for (const block of blocks) {
    if (!blockApplies(block, alias)) continue;
    for (const [k, v] of Object.entries(block.settings)) {
      if (out[k] === undefined) out[k] = v;
    }
  }
  return out;
}

/** `uzivatel@stroj:port` z ProxyJump; port i uživatel jsou nepovinné. */
function parseJump(value) {
  const first = String(value || '').split(',')[0].trim();
  if (!first || first.toLowerCase() === 'none') return null;
  const m = first.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
  if (!m) return null;
  return { username: m[1] || '', host: m[2], port: Number(m[3]) || 22 };
}

/**
 * Relace k importu.
 *
 * @param {Array} blocks bloky z parse/load
 * @param {object} [opts]
 * @param {string} [opts.defaultUser] uživatel, když ho config neuvádí
 * @returns {Array} objekty ve stejném tvaru, jaký očekává import z WinSCP
 */
function toSessions(blocks, { defaultUser = os.userInfo().username } = {}) {
  const aliases = [];
  for (const block of blocks) {
    for (const p of block.patterns) {
      // Vzor není server, ale šablona — nastavení z něj se použije, sám se ale
      // neimportuje. Stejně tak alias, který jinde vylučujeme.
      if (p.startsWith('!') || p.includes('*') || p.includes('?')) continue;
      if (!aliases.includes(p)) aliases.push(p);
    }
  }

  return aliases.map((alias) => {
    const cfg = settingsFor(blocks, alias);
    const jump = parseJump(cfg.proxyjump);
    const key = cfg.identityfile ? expandHome(cfg.identityfile.split(/\s+/)[0]) : '';
    const poznamky = [];
    if (key) poznamky.push(`klíč ${path.basename(key)}`);
    if (jump) poznamky.push(`přes bránu ${jump.host}`);
    if (cfg.proxycommand) poznamky.push('ProxyCommand se nepřenáší');

    return {
      name: alias,
      protocol: 'sftp',
      host: cfg.hostname || alias,
      port: Number(cfg.port) || 22,
      username: cfg.user || defaultUser,
      privateKeyPath: key,
      remoteDir: '',
      // Pole, na která se dívá dialog importu.
      supported: true,
      rawProtocol: 'sftp',
      passwordFailed: false,
      note: poznamky.join(', '),
      tunnelHost: jump ? jump.host : '',
      tunnelPort: jump ? jump.port : 22,
      tunnelUsername: jump ? (jump.username || cfg.user || defaultUser) : '',
    };
  });
}

/** Výchozí umístění konfigurace OpenSSH. */
function defaultPath(home = os.homedir()) {
  return path.join(home, '.ssh', 'config');
}

/** Načte konfiguraci a rovnou z ní udělá relace. */
function read(file = defaultPath(), opts = {}) {
  const blocks = load(file);
  return { file: expandHome(file), sessions: toSessions(blocks, opts), total: blocks.length };
}

module.exports = {
  parse, load, toSessions, settingsFor, parseJump, matches, defaultPath, read, expandHome,
};
