const { generateSecret, generateURI, verifySync, generateSync } = require('otplib');

function createSecret() {
  return generateSecret();
}

function keyUri(email, secret) {
  return generateURI({ issuer: 'Pulsiia', label: email, secret });
}

function verifyToken(secret, token) {
  if (!secret || !token) return false;
  const result = verifySync({ secret, token: String(token).replace(/\s/g, '') });
  return result.valid === true;
}

function generateToken(secret) {
  return generateSync({ secret });
}

module.exports = { generateSecret: createSecret, keyUri, verifyToken, generateToken };
