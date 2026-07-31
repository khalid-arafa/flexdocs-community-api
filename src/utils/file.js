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
    // let link = path.join("uploads", `${doc.projectCode}`, doc._id.toString(), `${doc.name}.${doc.ext}`);
    let link = path.join(
      "projects",
      `${doc.projectCode}`,
      "storage",
      doc._id.toString(),
      `${doc.name}.${doc.ext}`
    );
    return link;
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return null;
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
};
