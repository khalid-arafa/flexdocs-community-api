// Set deterministic test environment variables before any module loads
process.env.JWT_SECRET = "test-jwt-secret-key-for-unit-tests";
process.env.ENCRYPTION_KEY = "test-encryption-key-for-unit-tests";
process.env.NODE_ENV = "test";
