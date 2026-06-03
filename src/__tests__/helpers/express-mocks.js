function mockReq(overrides = {}) {
  return {
    params: {},
    body: {},
    query: {},
    headers: {},
    cookies: {},
    method: "GET",
    protocol: "https",
    originalUrl: "/",
    path: "/",
    id: "test-request-id",
    get: jest.fn((header) => {
      const map = { host: "localhost:3000" };
      return map[header.toLowerCase()] || "";
    }),
    project: { name: "Test", code: "test", userId: "testuser", dbRules: {} },
    ...overrides,
  };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.cookie = jest.fn().mockReturnValue(res);
  return res;
}

function mockNext() {
  return jest.fn();
}

module.exports = { mockReq, mockRes, mockNext };
