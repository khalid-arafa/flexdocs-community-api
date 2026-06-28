const { getToken } = require("../utils/encryptions");
const Logger = require("../utils/logger");
const jwt = require("jsonwebtoken");
const { tokenExpiry } = require("../constants");

const generateVerificationToken = ({ project, account, type }) => {
  try {
    const data = {
      type,
      projectCode: project.code,
      accountId: account._id.toString(),
    };
    const token = getToken(data, { expiresIn: tokenExpiry.verification });
    return token;
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return null;
  }
};

const verifyVerificationToken = (token) => {
  try {
    const obj = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
    });
    return { success: true, data: obj };
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return { success: false, message: "Your token is expired" };
    } else {
      return { success: false, message: "Your token is invalid!" };
    }
  }
};

module.exports = {
  generateVerificationToken,
  verifyVerificationToken,
};
