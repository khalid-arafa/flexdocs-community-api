jest.mock("../utils/logger", () => ({ log: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() }));
jest.mock("../core/config_service");
jest.mock("../core/email_service");
// Auth passthrough: authenticated admin
jest.mock("../middleware/system_auth.middleware", () => ({
  systemApiAuth: (req, _res, next) => { req.sender = { _id: "1", email: "admin@test.com" }; req.byAdmin = true; next(); },
  adminAuth: (_req, _res, next) => next(),
  superAdminAuth: (_req, _res, next) => next(),
  checkSystemApiAuth: (_req, _res, next) => next(),
}));

const request = require("supertest");
const express = require("express");
const { getMaskedEmailConfig, saveEmailConfig } = require("../core/config_service");
const { sendEmail } = require("../core/email_service");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/settings", require("../system/settings.routes"));
  return app;
}

describe("Settings Routes (email)", () => {
  afterEach(() => jest.clearAllMocks());

  it("GET /settings/email returns the masked config", async () => {
    getMaskedEmailConfig.mockResolvedValue({ source: "database", provider: "smtp", smtp: { host: "h", pass: "********" } });
    const res = await request(makeApp()).get("/settings/email");
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("smtp");
    expect(res.body.smtp.pass).toBe("********");
  });

  it("PUT /settings/email saves and returns masked config", async () => {
    saveEmailConfig.mockResolvedValue({ provider: "smtp", smtp: { host: "h", pass: "********" } });
    const res = await request(makeApp())
      .put("/settings/email")
      .send({ provider: "smtp", smtp: { host: "h", user: "u", pass: "secret" } });
    expect(res.status).toBe(200);
    expect(saveEmailConfig).toHaveBeenCalledTimes(1);
    expect(res.body.smtp.pass).toBe("********");
  });

  it("PUT /settings/email returns 400 on provider-requirement errors", async () => {
    saveEmailConfig.mockRejectedValue(new Error("Resend requires an API key"));
    const res = await request(makeApp()).put("/settings/email").send({ provider: "resend" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Resend requires/);
  });

  it("PUT /settings/email returns 400 on an invalid provider (zod)", async () => {
    const res = await request(makeApp()).put("/settings/email").send({ provider: "bogus" });
    expect(res.status).toBe(400);
    expect(saveEmailConfig).not.toHaveBeenCalled();
  });

  it("POST /settings/email/test returns 200 when the email sends", async () => {
    sendEmail.mockResolvedValue({ success: true, provider: "smtp" });
    const res = await request(makeApp()).post("/settings/email/test").send({});
    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].email).toBe("admin@test.com"); // falls back to admin email
  });

  it("POST /settings/email/test returns 400 when sending fails", async () => {
    sendEmail.mockResolvedValue({ success: false, error: "No email provider configured" });
    const res = await request(makeApp()).post("/settings/email/test").send({ to: "x@y.com" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/No email provider/);
  });
});
