'use strict';

const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const SERVICE = 'FTP Cli';
const ACCOUNT = 'vault-key';

/**
 * Úložiště hesel. Hesla se do souboru s relacemi ukládají zašifrovaná
 * (AES-256-GCM) a jediný klíč leží v macOS Keychain.
 *
 * Proč ne heslo po heslu přímo v Keychain: `security add-generic-password`
 * bere heslo jako argument příkazové řádky, kde je krátce vidět v `ps`.
 * Takhle se tomu vystavíme jednou při prvním spuštění, ne při každém uložení.
 */
let cachedKey = null;

async function readKeyFromKeychain() {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w',
    ]);
    return Buffer.from(stdout.trim(), 'hex');
  } catch {
    return null;
  }
}

async function writeKeyToKeychain(key) {
  await execFileAsync('security', [
    'add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT,
    '-D', 'application key', '-w', key.toString('hex'),
  ]);
}

async function getKey() {
  if (cachedKey) return cachedKey;
  let key = await readKeyFromKeychain();
  if (!key || key.length !== 32) {
    key = crypto.randomBytes(32);
    await writeKeyToKeychain(key);
  }
  cachedKey = key;
  return key;
}

async function encrypt(plaintext) {
  if (!plaintext) return '';
  const key = await getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

async function decrypt(payload) {
  if (!payload) return '';
  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return '';
  const key = await getKey();
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Klíč v Keychain se změnil nebo je záznam poškozený.
    return '';
  }
}

module.exports = { encrypt, decrypt };
