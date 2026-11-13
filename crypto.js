// Temporary encrypted-note format. Keys and passphrases are never persisted here.
// This protects stored/mirrored note contents, not a compromised browser or app release.
export const NOTE_ENCRYPTION_VERSION = 1;
export const NOTE_KDF_ITERATIONS = 600000;
export const MAX_NOTE_PLAINTEXT_BYTES = 30000;
export const MAX_NOTE_CIPHERTEXT_BYTES = MAX_NOTE_PLAINTEXT_BYTES + 16;
const MAX_DATA_BASE64 = Math.ceil(MAX_NOTE_CIPHERTEXT_BYTES / 3) * 4;
const SUBJECT = /^note:[A-Za-z0-9][A-Za-z0-9._:-]{0,194}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export class NoteCryptoError extends Error {
  constructor(code, message) { super(message); this.name = 'NoteCryptoError'; this.code = code; }
}
const failure = (code, message) => new NoteCryptoError(code, message);
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const b64 = bytes => { let text = ''; for (const b of bytes) text += String.fromCharCode(b); return btoa(text); };
function bytes(text) {
  const raw = atob(text), out = Uint8Array.from(raw, c => c.charCodeAt(0));
  if (b64(out) !== text) throw failure('INVALID_ENVELOPE', 'The encrypted note format is invalid.');
  return out;
}
function decodedLength(text) {
  return text.length / 4 * 3 - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0);
}
function subjectBytes(subjectId) {
  if (typeof subjectId !== 'string' || !SUBJECT.test(subjectId)) throw failure('INVALID_SUBJECT', 'The note identity is invalid.');
  return encoder.encode('shared-intelligence/encrypted-note/v1/' + subjectId);
}
function webCrypto() {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== 'function')
    throw failure('CRYPTO_UNAVAILABLE', 'Encrypted notes require a supported browser and HTTPS.');
  return globalThis.crypto;
}
function passphraseBytes(passphrase, creating) {
  if (typeof passphrase !== 'string' || passphrase.length > 1024 || passphrase.length < (creating ? 12 : 1))
    throw failure('PASSPHRASE_REQUIRED', creating ? 'Use an encryption passphrase of at least 12 characters.' : 'Enter the encryption passphrase.');
  return encoder.encode(passphrase);
}
function cleanContent(input) {
  if (!object(input) || Object.keys(input).some(k => !['title', 'body', 'tags', 'color'].includes(k)))
    throw failure('INVALID_CONTENT', 'The encrypted note content is invalid.');
  const content = { title: input.title ?? '', body: input.body ?? '', tags: input.tags ?? [], color: input.color ?? '' };
  if (typeof content.title !== 'string' || content.title.length > 140 ||
      typeof content.body !== 'string' || content.body.length > 19000 ||
      typeof content.color !== 'string' || content.color.length > 32 ||
      !Array.isArray(content.tags) || content.tags.length > 20 ||
      content.tags.some(t => typeof t !== 'string' || !t.length || t.length > 80))
    throw failure('INVALID_CONTENT', 'The note exceeds an encrypted-note field limit.');
  return { ...content, tags: [...content.tags] };
}

/** Pure validation, safe to use before asking Web Crypto to process untrusted data. */
export function validateEnvelope(envelope) {
  const errors = [];
  if (!object(envelope)) return ['encrypted note must be an object'];
  const keys = ['v', 'kdf', 'iterations', 'cipher', 'salt', 'iv', 'data'];
  if (Object.keys(envelope).some(k => !keys.includes(k))) errors.push('unknown encrypted-note field');
  if (envelope.v !== 1 || envelope.kdf !== 'PBKDF2-SHA256' || envelope.iterations !== NOTE_KDF_ITERATIONS || envelope.cipher !== 'AES-256-GCM')
    errors.push('unsupported encrypted-note version or algorithm');
  for (const [key, min, max] of [['salt', 16, 16], ['iv', 12, 12], ['data', 16, MAX_NOTE_CIPHERTEXT_BYTES]]) {
    const value = envelope[key];
    const maxChars = key === 'data' ? MAX_DATA_BASE64 : Math.ceil(max / 3) * 4;
    if (typeof value !== 'string' || value.length > maxChars || !BASE64.test(value) || !value.length ||
        decodedLength(value) < min || decodedLength(value) > max) errors.push('invalid encrypted-note ' + key);
    else { try { bytes(value); } catch { errors.push('invalid encrypted-note ' + key); } }
  }
  return errors;
}
async function derive(crypto, passphrase, salt, usage) {
  const material = await crypto.subtle.importKey('raw', passphrase, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: NOTE_KDF_ITERATIONS }, material,
    { name: 'AES-GCM', length: 256 }, false, [usage]);
}

/** Encrypt title/body/tags/colour together. The stable note subject is authenticated. */
export async function encryptNote(content, passphrase, subjectId) {
  const crypto = webCrypto(), aad = subjectBytes(subjectId);
  const plaintext = encoder.encode(JSON.stringify(cleanContent(content)));
  let secret;
  try {
    if (plaintext.length > MAX_NOTE_PLAINTEXT_BYTES)
      throw failure('NOTE_TOO_LARGE', 'This note is too large to encrypt as one record. Shorten it before saving.');
    secret = passphraseBytes(passphrase, true);
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await derive(crypto, secret, salt, 'encrypt');
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext);
    return { v: 1, kdf: 'PBKDF2-SHA256', iterations: NOTE_KDF_ITERATIONS, cipher: 'AES-256-GCM', salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(encrypted)) };
  } finally { secret?.fill(0); plaintext.fill(0); }
}

/** Wrong passphrase, changed ciphertext and a mismatched note subject all fail closed. */
export async function decryptNote(envelope, passphrase, subjectId) {
  if (validateEnvelope(envelope).length) throw failure('INVALID_ENVELOPE', 'This encrypted note has an unsupported or invalid format.');
  const crypto = webCrypto(), aad = subjectBytes(subjectId), secret = passphraseBytes(passphrase, false);
  let plaintext;
  try {
    const key = await derive(crypto, secret, bytes(envelope.salt), 'decrypt');
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(envelope.iv), additionalData: aad, tagLength: 128 }, key, bytes(envelope.data)));
    return cleanContent(JSON.parse(decoder.decode(plaintext)));
  } catch {
    throw failure('DECRYPT_FAILED', 'Could not unlock this note. Check the passphrase; the saved note may also be damaged.');
  } finally { secret.fill(0); plaintext?.fill(0); }
}

export const isEncryptedNote = item => object(item?.encrypted);
