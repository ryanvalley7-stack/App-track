// Generates a VAPID key pair for Web Push. Run: npm run vapid
// Set both values as Worker secrets. Never commit the private key.
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
);
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const pub = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', publicKey)));
const priv = (await crypto.subtle.exportKey('jwk', privateKey)).d;

console.log(`VAPID_PUBLIC_KEY=${pub}`);
console.log(`VAPID_PRIVATE_KEY=${priv}`);
console.log('\nKeep the private key secret: paste it into `npx wrangler secret put VAPID_PRIVATE_KEY`, never into a file in this repo.');
