const path = require("path");
const Logger = require("./logger");
const fsp = require("fs/promises");
const sharp = require("sharp");
const { imageSizes } = require("../constants");

/** Reads a file, returning null when it does not exist. */
async function readIfExists(filePath) {
  try {
    return await fsp.readFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isImg(filePath) {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  return ["jpg", "jpeg", "gif", "png", "webp"].includes(ext);
}

function getDownloadableLink(doc) {
  try {
    // The filename segment is percent-encoded: file names may contain
    // non-ASCII characters (Arabic, accents), spaces, "#", "?" or "%", all of
    // which produce a broken or truncated URL when pasted in raw.
    let link = path.join(
      "projects",
      `${doc.projectCode}`,
      "storage",
      doc._id.toString(),
      encodeURIComponent(`${doc.name}.${doc.ext}`)
    );
    return link;
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return null;
  }
}

/**
 * Builds an RFC 6266 Content-Disposition value.
 *
 * HTTP header values are latin1-only: passing a name with Arabic (or any
 * codepoint above U+00FF) to res.setHeader throws ERR_INVALID_CHAR, which
 * inside an async route surfaced as an unhandled rejection and left the
 * request hanging until the client timed out — every file with a non-ASCII
 * name was effectively undownloadable. So send an ASCII-safe `filename` for
 * old clients plus `filename*` with the real UTF-8 name for everyone else.
 */
function contentDisposition(type, filename) {
  const name = String(filename).replace(/[\r\n"\\]/g, "_");
  // eslint-disable-next-line no-control-regex
  const ascii = name.replace(/[^\x20-\x7e]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Compares file names ignoring Unicode normalization differences (NFC/NFD). */
function sameFileName(a, b) {
  try {
    return String(a).normalize("NFC") === String(b).normalize("NFC");
  } catch {
    return a === b;
  }
}

async function getResizedImage(dirPath, ext, size = "medium") {
  const SIZE_MAP = imageSizes;

  try {
    const outputFile = path.join(dirPath, `${size}.${ext}`);
    // Read directly instead of checking existence first: one syscall rather
    // than two, and no window in which the file disappears between the two.
    const cached = await readIfExists(outputFile);
    if (cached) return cached;

    const originalFile = path.join(dirPath, `org.${ext}`);

    const { width } = await sharp(originalFile).metadata().catch(() => {
      throw new Error(`Original image not found: ${originalFile}`);
    });
    const targetWidth = SIZE_MAP[size];

    // Determine the final width without upscaling
    const finalWidth =
      width < SIZE_MAP.small
        ? width
        : width < SIZE_MAP.medium
        ? SIZE_MAP.small
        : width < SIZE_MAP.large
        ? SIZE_MAP.medium
        : targetWidth;
    const resolvedSize =
      Object.entries(SIZE_MAP).find(([key, val]) => val === finalWidth)?.[0] ||
      size;

    // A request for a size larger than the source resolves to a smaller
    // bucket, so the cache path has to be recomputed. Re-checking the
    // originally requested path instead meant the result was cached under the
    // requested bucket rather than the one actually produced, and every later
    // request for the resolved bucket re-ran sharp against the same source.
    const resolvedFile = path.join(dirPath, `${resolvedSize}.${ext}`);
    if (resolvedFile !== outputFile) {
      const alreadyResized = await readIfExists(resolvedFile);
      if (alreadyResized) return alreadyResized;
    }

    const buffer = await sharp(originalFile)
      .resize(finalWidth)
      .toFormat(ext, { quality: 80 }) // Optimize while preserving quality
      .toBuffer();

    await fsp.writeFile(resolvedFile, buffer); // Save resized version

    return buffer;
  } catch (error) {
    Logger.error("Error resizing image", { stack: error.stack });
    throw error;
  }
}

module.exports = {
  isImg,
  getDownloadableLink,
  getResizedImage,
  contentDisposition,
  sameFileName,
};
