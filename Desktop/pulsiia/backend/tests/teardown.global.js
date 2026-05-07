'use strict';

const fs = require('node:fs');

module.exports = async () => {
  // Nettoyage des clés temporaires
  if (global.__TEST_KEYS_DIR__) {
    fs.rmSync(global.__TEST_KEYS_DIR__, { recursive: true, force: true });
  }
};
