// Lightweight request schema validation middleware
// Usage: validate({ email: { required: true, type: "string", match: /regex/ } })

function validate(schema) {
  return (req, res, next) => {
    const errors = [];
    for (const [field, rules] of Object.entries(schema)) {
      const value = req.body[field];

      if (rules.required && (value === undefined || value === null || value === "")) {
        errors.push(`${field} is required`);
        continue;
      }

      // skip further checks if field is optional and not provided
      if (value === undefined || value === null) continue;

      if (rules.type && typeof value !== rules.type) {
        errors.push(`${field} must be of type ${rules.type}`);
      }

      if (rules.match && typeof value === "string" && !rules.match.test(value)) {
        errors.push(rules.message || `${field} is invalid`);
      }

      if (rules.maxLength && typeof value === "string" && value.length > rules.maxLength) {
        errors.push(`${field} must not exceed ${rules.maxLength} characters`);
      }

      if (rules.minLength && typeof value === "string" && value.length < rules.minLength) {
        errors.push(`${field} must be at least ${rules.minLength} characters`);
      }

      if (rules.max && typeof value === "number" && value > rules.max) {
        errors.push(`${field} must not exceed ${rules.max}`);
      }
    }

    if (errors.length) {
      return res.status(400).json({ message: errors[0], errors });
    }
    next();
  };
}

module.exports = { validate };
