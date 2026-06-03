const path = require("path");
const Logger = require("./logger");
const fs = require("fs");
const sharp = require("sharp");
const { imageSizes } = require("../constants");

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
    if (fs.existsSync(outputFile)) return fs.readFileSync(outputFile);

    const originalFile = path.join(dirPath, `org.${ext}`);
    if (!fs.existsSync(originalFile))
      throw new Error(`Original image not found: ${originalFile}`);

    const { width } = await sharp(originalFile).metadata();
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
    size =
      Object.entries(SIZE_MAP).find(([key, val]) => val === finalWidth)?.[0] ||
      size;
    if (fs.existsSync(outputFile)) return fs.readFileSync(outputFile);

    const buffer = await sharp(originalFile)
      .resize(finalWidth)
      .toFormat(ext, { quality: 80 }) // Optimize while preserving quality
      .toBuffer();

    fs.writeFileSync(outputFile, buffer); // Save resized version

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
