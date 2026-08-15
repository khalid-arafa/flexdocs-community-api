const crypto = require("crypto");

// ── Signed download URLs ────────────────────────────────────────────────────
//
// A signed URL is a server-minted, time-limited, single-file grant. It lets the
// dashboard produce a shareable/openable link to a PRIVATE file without putting
// a reusable bearer token (the project or user JWT) in the URL — where it would
// leak into browser history, the Referer header and access logs.
//
// The signature binds project + file id + filename (+ requested size) + expiry,
// so it authorises exactly one file and cannot be replayed against another or
// past its deadline. It is HMAC-SHA256 over JWT_SECRET, domain-separated from
// real JWTs by a fixed context label so a storage signature can never be
// mistaken for — or forged from — a token.
const STORAGE_URL_CONTEXT = "flexdocs-storage-url-v1";

function storageUrlPayload({ projectCode, fileId, filename, size, expires }) {
  return [
    STORAGE_URL_CONTEXT,
    projectCode,
    fileId,
    filename,
    size || "",
    String(expires),
  ].join("\n");
}

function signStorageUrl({ projectCode, fileId, filename, size = "", expires }) {
  return crypto
    .createHmac("sha256", process.env.JWT_SECRET)
    .update(storageUrlPayload({ projectCode, fileId, filename, size, expires }))
    .digest("hex");
}

// Constant-time verification, expiry included. Returns a plain boolean and
// never throws on malformed input (bad hex, missing fields) — a forged link is
// simply invalid.
function verifyStorageUrlSignature({
  projectCode,
  fileId,
  filename,
  size = "",
  expires,
  signature,
}) {
  if (!signature || !expires) return false;
  const exp = Number(expires);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return false;
  const expected = signStorageUrl({
    projectCode,
    fileId,
    filename,
    size,
    expires: exp,
  });
  const expectedBuf = Buffer.from(expected, "hex");
  let providedBuf;
  try {
    providedBuf = Buffer.from(String(signature), "hex");
  } catch {
    return false;
  }
  return (
    expectedBuf.length === providedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, providedBuf)
  );
}

module.exports = { signStorageUrl, verifyStorageUrlSignature };
