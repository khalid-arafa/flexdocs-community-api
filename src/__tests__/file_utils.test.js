/**
 * Tests for the storage file helpers.
 *
 * getResizedImage runs against real sharp and a real temp directory: the bug
 * it guards is entirely about which filename the resized copy lands under, so
 * mocking the filesystem would test nothing.
 */

jest.mock("../utils/logger", () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");

const {
  isImg,
  getDownloadableLink,
  getResizedImage,
  contentDisposition,
  sameFileName,
} = require("../utils/file");
const { imageSizes } = require("../constants");

let workDir;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "flexdocs-file-utils-"));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Writes an `org.<ext>` of the given width into a fresh directory. */
async function seedImage(name, width, ext = "jpg") {
  const dir = path.join(workDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const image = sharp({
    create: {
      width,
      height: Math.max(1, Math.round(width * 0.6)),
      channels: 3,
      background: "#4488cc",
    },
  });
  await (ext === "png" ? image.png() : image.jpeg()).toFile(
    path.join(dir, `org.${ext}`)
  );
  return dir;
}

describe("getResizedImage", () => {
  // The download route reads back `${size}.${ext}` straight after calling
  // this, so the cache file has to be named after the REQUESTED size. Naming
  // it after whichever bucket matched the computed width meant a "small"
  // request against an 800–1199px source wrote medium.jpg and the route then
  // served a path that was never written — no thumbnail for most images.
  it.each([250, 640, 800, 900, 1000, 1199, 1200, 1920, 2400])(
    "caches under the requested size for a %ipx-wide source",
    async (width) => {
      const dir = await seedImage(`w${width}`, width);
      await getResizedImage(dir, "jpg", "small");
      expect(fs.existsSync(path.join(dir, "small.jpg"))).toBe(true);
    }
  );

  it("does not upscale a source narrower than the requested size", async () => {
    const dir = await seedImage("narrow", 120);
    await getResizedImage(dir, "jpg", "large");
    const { width } = await sharp(path.join(dir, "large.jpg")).metadata();
    expect(width).toBe(120);
  });

  it("resizes down to the requested bucket width", async () => {
    const dir = await seedImage("wide", 2000);
    await getResizedImage(dir, "jpg", "small");
    const { width } = await sharp(path.join(dir, "small.jpg")).metadata();
    expect(width).toBe(imageSizes.small);
  });

  it("reuses the cached copy instead of re-encoding", async () => {
    const dir = await seedImage("cached", 900);
    await getResizedImage(dir, "jpg", "small");
    const cachePath = path.join(dir, "small.jpg");
    fs.writeFileSync(cachePath, "sentinel");
    const buffer = await getResizedImage(dir, "jpg", "small");
    expect(buffer.toString()).toBe("sentinel");
  });

  it("throws when the original is missing", async () => {
    const dir = path.join(workDir, "empty");
    fs.mkdirSync(dir, { recursive: true });
    await expect(getResizedImage(dir, "jpg", "small")).rejects.toThrow();
  });
});

describe("contentDisposition", () => {
  it("keeps an ASCII name in the plain filename parameter", () => {
    expect(contentDisposition("attachment", "report.pdf")).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`
    );
  });

  it("never emits a byte a header cannot carry", () => {
    const value = contentDisposition("inline", "تقرير التكلفة.pdf");
    // Latin-1 only: anything above U+00FF makes res.setHeader throw.
    expect([...value].every((char) => char.charCodeAt(0) <= 0xff)).toBe(true);
    expect(value).toContain(
      `filename*=UTF-8''${encodeURIComponent("تقرير التكلفة.pdf")}`
    );
  });

  it("strips quotes and newlines that would break out of the header", () => {
    const value = contentDisposition("attachment", 'a"b\r\nc.txt');
    expect(value).not.toMatch(/[\r\n]/);
    expect(value).toContain('filename="a_b__c.txt"');
  });
});

describe("sameFileName", () => {
  it("matches names differing only in unicode normalization", () => {
    const name = "تقرير.pdf";
    expect(sameFileName(name.normalize("NFC"), name.normalize("NFD"))).toBe(true);
  });

  it("still rejects a different name", () => {
    expect(sameFileName("a.pdf", "b.pdf")).toBe(false);
  });
});

describe("getDownloadableLink", () => {
  it("percent-encodes the name segment", () => {
    const link = getDownloadableLink({
      projectCode: "ikal",
      _id: "abc123",
      name: "تقرير التكلفة",
      ext: "pdf",
    });
    expect(link).toBe(
      `projects/ikal/storage/abc123/${encodeURIComponent("تقرير التكلفة.pdf")}`
    );
  });
});

describe("isImg", () => {
  it.each(["photo.jpg", "photo.JPEG", "a.png", "b.gif", "c.webp"])(
    "recognises %s",
    (name) => expect(isImg(name)).toBe(true)
  );

  it.each(["doc.pdf", "archive.zip", "notes.txt"])(
    "rejects %s",
    (name) => expect(isImg(name)).toBe(false)
  );
});
