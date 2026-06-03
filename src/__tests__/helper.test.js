jest.mock("../utils/logger", () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

const { hashProjectToken, generateProjectCreds } = require("../utils/helper");
const { mockReq } = require("./helpers/express-mocks");

describe("helper.js", () => {
  describe("hashProjectToken", () => {
    it("should return a 64-character hex string (SHA-256)", () => {
      const hash = hashProjectToken("some-token");
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("should produce deterministic output for the same input", () => {
      const h1 = hashProjectToken("token-abc");
      const h2 = hashProjectToken("token-abc");
      expect(h1).toBe(h2);
    });

    it("should produce different hashes for different inputs", () => {
      const h1 = hashProjectToken("token-a");
      const h2 = hashProjectToken("token-b");
      expect(h1).not.toBe(h2);
    });

    it("should handle empty string input", () => {
      const hash = hashProjectToken("");
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("generateProjectCreds", () => {
    it("should return an object with all expected keys", () => {
      const req = mockReq({
        params: { id: "proj123" },
        project: { name: "MyProject", code: "myproj" },
      });
      const creds = generateProjectCreds(req);
      expect(creds).toHaveProperty("projectId", "proj123");
      expect(creds).toHaveProperty("name", "MyProject");
      expect(creds).toHaveProperty("code", "myproj");
      expect(creds).toHaveProperty("projectToken");
      expect(creds).toHaveProperty("projectTokenHash");
      expect(creds).toHaveProperty("url");
    });

    it("should have projectToken as a valid JWT", () => {
      const req = mockReq({
        params: { id: "p1" },
        project: { name: "P", code: "p" },
      });
      const creds = generateProjectCreds(req);
      expect(creds.projectToken.split(".")).toHaveLength(3);
    });

    it("should have projectTokenHash equal to SHA-256 of projectToken", () => {
      const req = mockReq({
        params: { id: "p1" },
        project: { name: "P", code: "p" },
      });
      const creds = generateProjectCreds(req);
      expect(creds.projectTokenHash).toBe(hashProjectToken(creds.projectToken));
    });

    it("should build url from req.protocol and req.get('host')", () => {
      const req = mockReq({
        params: { id: "p1" },
        project: { name: "P", code: "p" },
      });
      const creds = generateProjectCreds(req);
      expect(creds.url).toBe("https://localhost:3000");
    });
  });
});
