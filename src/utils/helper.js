const crypto = require("crypto");
const { getToken } = require("./encryptions");

function hashProjectToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateProjectCreds(req) {
  const payload = {
    projectId: req.params.id,
    name: req.project.name,
    code: req.project.code,
  };
  const projectToken = getToken(payload);
  return {
    ...payload,
    projectToken,
    projectTokenHash: hashProjectToken(projectToken),
    url: req.protocol + "://" + req.get("host"),
  };
}

module.exports = { generateProjectCreds, hashProjectToken };
