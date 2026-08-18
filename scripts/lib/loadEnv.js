const fs = require("fs");
const path = require("path");

// Minimal .env reader, so a local run picks up API keys the same way CI does without
// pulling in a dependency. Anything already in the environment wins, which keeps CI
// secrets authoritative over a stray checked-out file.
function loadEnv(file = ".env") {
  const target = path.resolve(process.cwd(), file);
  if (!fs.existsSync(target)) return;

  for (const line of fs.readFileSync(target, "utf8").split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;

    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;

    const [, name, rawValue] = match;
    if (name in process.env) continue;

    process.env[name] = rawValue.replace(/^(['"])(.*)\1$/, "$2");
  }
}

module.exports = { loadEnv };
