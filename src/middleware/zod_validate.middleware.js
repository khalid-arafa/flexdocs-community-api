/**
 * Express middleware that validates req.body against a Zod schema.
 * Returns 400 with { message, errors } on failure.
 *
 * Usage: router.post("/path", zodValidate(mySchema), handler)
 */
function zodValidate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.issues.map(
        (issue) =>
          (issue.path.length ? `${issue.path.join(".")}: ` : "") + issue.message,
      );
      return res.status(400).json({
        message: errors[0],
        errors,
      });
    }
    req.body = result.data;
    next();
  };
}

module.exports = { zodValidate };
