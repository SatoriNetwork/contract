"use strict";
const fs = require("fs");
const path = require("path");

// Atomic JSON persistence: write-to-temp then rename, so a crash mid-write
// leaves the previous state on disk instead of half a file.

function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return dflt; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

module.exports = { readJson, writeJson };
