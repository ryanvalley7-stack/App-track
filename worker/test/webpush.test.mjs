// Checks the WebCrypto implementation against an independent decryptor and
// signature check written with Node's crypto module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createDecipheriv, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { encryptPayload, vapidAuthorization, b64urlEncode } from '../src/webpush.js';

// RFC 8291 decryption, as a browser would do it.
function decrypt(body, uaECDH, authSecret) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ecdhSecret = uaECDH.computeSecret(asPublic);
  const uaPublic = uaECDH.getPublicKey();
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  assert.equal(plain.at(-1), 2, 'last-record delimiter');
  return { rs, idlen, text: plain.subarray(0, -1).toString() };
}

test('payload decrypts with the subscriber keys', async () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  const payload = JSON.stringify({ title: 'Gym Progress', body: 'Progress pic time. Day 12 streak. ✓' });
  const body = Buffer.from(await encryptPayload(payload, b64urlEncode(ua.getPublicKey()), b64urlEncode(auth)));
  const out = decrypt(body, ua, auth);
  assert.equal(out.text, payload);
  assert.equal(out.rs, 4096);
  assert.equal(out.idlen, 65);
});

test('each message uses a fresh salt and sender key', async () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const args = ['hi', b64urlEncode(ua.getPublicKey()), b64urlEncode(randomBytes(16))];
  const [a, b] = await Promise.all([encryptPayload(...args), encryptPayload(...args)]);
  assert.notDeepEqual(a.subarray(0, 86), b.subarray(0, 86));
});

test('rejects malformed subscription keys', async () => {
  await assert.rejects(encryptPayload('x', b64urlEncode(randomBytes(10)), b64urlEncode(randomBytes(16))));
});

test('VAPID header carries a valid ES256 JWT for the push service origin', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = b64urlEncode(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privateKey = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;
  const header = await vapidAuthorization('https://web.push.apple.com/QGuQyavXutnMH/abc', { publicKey, privateKey, subject: 'mailto:me@example.com' });

  const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, publicKey);
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'mailto:me@example.com');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);
  const key = createPublicKey({ key: await crypto.subtle.exportKey('jwk', pair.publicKey), format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});
