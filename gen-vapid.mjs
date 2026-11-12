// Genera las claves VAPID. Uso: node gen-vapid.mjs
const b64u = (b) => Buffer.from(b).toString("base64url");
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
const jwk = await crypto.subtle.exportKey("jwk", privateKey);
console.log("\n=== CLAVE PÚBLICA (va en wrangler.toml → VAPID_PUBLIC y en la app → VAPID_PUB) ===\n" + b64u(pub));
console.log("\n=== CLAVE PRIVADA (secreta; pégala cuando 'wrangler secret put VAPID_PRIVATE_JWK' te la pida) ===\n" + JSON.stringify(jwk));
console.log("");
