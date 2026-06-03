const express = require('express');

const validateJsonBody = (options = { limit: '50mb', extended: true }) => {
  return [
    express.json(options),
    (err, req, res, next) => {
      if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({
          message: 'Invalid json body!',
        });
      }
      next(err);
    }
  ];
};

module.exports = validateJsonBody;