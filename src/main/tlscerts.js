'use strict';

const tls = require('tls');

/**
 * Ověřování TLS certifikátu u FTPS.
 *
 * Doteď existoval jen přepínač „ověřovat certifikát": buď certifikát prošel
 * proti systémovým autoritám, nebo se nekontrolovalo nic. Na hostinzích
 * s vlastním certifikátem to lidi vedlo k tomu, že ověřování vypnuli úplně —
 * a tím byli na tom hůř, než kdyby si jednou potvrdili otisk.
 *
 * Tenhle modul dělá totéž co ověřování SSH klíče: nezná-li se certifikát,
 * ukáže se jeho otisk k potvrzení a uloží se k relaci.
 */

/** Údaje o certifikátu v podobě, kterou má smysl ukázat člověku. */
function describe(cert) {
  const name = (obj) => (obj && (obj.CN || obj.O || obj.OU)) || '(neuvedeno)';
  return {
    subject: name(cert.subject),
    issuer: name(cert.issuer),
    validFrom: cert.valid_from || null,
    validTo: cert.valid_to || null,
    altNames: cert.subjectaltname || null,
    // Node vrací otisk ve tvaru AA:BB:CC… — stejně jako `openssl x509
    // -fingerprint -sha256`, takže se dá porovnat okem.
    fingerprint: cert.fingerprint256 || null,
    selfSigned: Boolean(cert.subject && cert.issuer
      && JSON.stringify(cert.subject) === JSON.stringify(cert.issuer)),
  };
}

/** Přeloží důvod nedůvěry do věty, která uživateli něco řekne. */
function reasonText({ authorized, authorizationError, identityError, info }) {
  if (identityError) {
    return `Certifikát je vystavený na jiné jméno${info.altNames ? ` (platí pro: ${info.altNames})` : ''}.`;
  }
  if (!authorized) {
    const code = authorizationError && (authorizationError.code || authorizationError.message);
    if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || info.selfSigned) {
      return 'Certifikát je podepsaný sám sebou — nevydala ho žádná uznávaná autorita.';
    }
    if (code === 'CERT_HAS_EXPIRED') return 'Platnost certifikátu už vypršela.';
    if (code === 'CERT_NOT_YET_VALID') return 'Certifikát ještě není platný.';
    if (code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
      return 'Certifikát vydala autorita, kterou systém nezná.';
    }
    return `Certifikát se nepodařilo ověřit${code ? ` (${code})` : ''}.`;
  }
  return 'Certifikát neodpovídá dříve potvrzenému otisku.';
}

/**
 * Rozhodne, co s předloženým certifikátem.
 *
 * @param {object} params
 * @param {object} params.cert výstup socket.getPeerCertificate()
 * @param {boolean} params.authorized prošel řetěz proti systémovým autoritám
 * @param {Error|null} params.authorizationError důvod, proč neprošel
 * @param {Error|undefined} params.identityError nesoulad jména serveru
 * @param {string} params.storedFingerprint otisk potvrzený dřív u této relace
 * @param {boolean} params.acceptAny uživatel u relace vypnul ptaní
 * @returns {{verdict, fingerprint, reason, info, expected, refreshPin}}
 *   verdict: 'trusted' | 'unknown' | 'mismatch'
 */
function classify({
  cert, authorized, authorizationError, identityError, storedFingerprint, acceptAny = false,
}) {
  const info = describe(cert);
  const systemTrusted = Boolean(authorized) && !identityError;
  const base = { fingerprint: info.fingerprint, info };

  if (acceptAny) {
    return { ...base, verdict: 'trusted', reason: 'ověřování certifikátu je u této relace vypnuté' };
  }

  if (storedFingerprint) {
    if (storedFingerprint === info.fingerprint) {
      return { ...base, verdict: 'trusted', reason: 'otisk odpovídá dříve potvrzenému' };
    }
    // Obměna certifikátu za platný a systémem uznaný je běžná věc (obnova
    // u autority). Nemá smysl kvůli ní strašit — jen si poznamenáme nový otisk.
    if (systemTrusted) {
      return {
        ...base, verdict: 'trusted', refreshPin: true,
        reason: 'certifikát se obměnil za platný a uznávaný',
      };
    }
    return {
      ...base,
      verdict: 'mismatch',
      expected: storedFingerprint,
      reason: reasonText({ authorized, authorizationError, identityError, info }),
    };
  }

  if (systemTrusted) {
    return { ...base, verdict: 'trusted', reason: 'ověřeno proti systémovým autoritám' };
  }

  return {
    ...base,
    verdict: 'unknown',
    reason: reasonText({ authorized, authorizationError, identityError, info }),
  };
}

/**
 * Posbírá z už navázaného TLS spojení všechno, co je pro rozhodnutí potřeba.
 * Volá se dřív, než se na server pošlou přihlašovací údaje.
 */
function inspectSocket(socket, host) {
  const cert = socket.getPeerCertificate ? socket.getPeerCertificate(false) : null;
  if (!cert || !cert.fingerprint256) {
    throw new Error('Server nepředložil TLS certifikát');
  }
  return {
    cert,
    authorized: socket.authorized,
    authorizationError: socket.authorizationError || null,
    // Kontrolu jména si děláme sami — při rejectUnauthorized:false ji Node
    // nemusí uplatnit a my potřebujeme vědět, jestli sedí.
    identityError: tls.checkServerIdentity(host, cert),
  };
}

module.exports = { describe, classify, inspectSocket, reasonText };
