const crypto = require("crypto");

// Legacy AES-256-CBC, kept only for backward-compat reads during migration:
// password hashes written before bcrypt (see ./password) and stored secrets
// written before AES-GCM (see ./secrets). CBC provides no integrity, which is
// exactly why nothing new should be written with it.
//
// Note the key derivation is deliberately preserved bug-for-bug: sha256 →
// base64 → first 32 CHARACTERS. Changing it would make every existing
// ciphertext undecryptable.
function legacyKey() {
  return crypto
    .createHash("sha256")
    .update(String(process.env.ENCRYPTION_KEY))
    .digest("base64")
    .substr(0, 32);
}

// legacy AES encrypt (kept only for backward-compat reads during migration)
function encryptLegacy(text) {
  let key = legacyKey();

  let iv = crypto.randomBytes(16);
  let cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(key), iv);
  let encrypted = cipher.update(text);

  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

// legacy AES decrypt
function decryptLegacy(text) {
  let key = legacyKey();
  let textParts = text.split(":");
  let iv = Buffer.from(textParts.shift(), "hex");
  let encryptedText = Buffer.from(textParts.join(":"), "hex");
  let decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(key), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

module.exports = { encryptLegacy, decryptLegacy };
