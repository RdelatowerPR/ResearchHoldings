const fs = require("fs");
const path = require("path");

// Timestamped logging that goes to a file as well as the console.
//
// The console is the only record a GitHub Actions run keeps, and those logs age out
// after 90 days - which is why nobody could say exactly when the scraper died. The
// file is uploaded as a build artifact; the run record below is committed, so the
// history of what the collector actually did survives indefinitely.

const LOG_DIR = process.env.LOG_DIR || "logs";
const RUN_HISTORY = process.env.RUN_HISTORY || "data/run-history.jsonl";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_RUN_RECORDS = 500;

function format(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function rotateIfLarge(file) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    // A log that can't rotate is not a reason to fail the run
  }
}

function createLogger(name, { dir = LOG_DIR } = {}) {
  let stream = null;
  let file = null;

  try {
    fs.mkdirSync(path.resolve(process.cwd(), dir), { recursive: true });
    file = path.resolve(process.cwd(), dir, `${name}.log`);
    rotateIfLarge(file);
    stream = fs.createWriteStream(file, { flags: "a" });
  } catch (error) {
    console.error(`Logging to file is unavailable (${error.message}); continuing on console only.`);
  }

  const counts = { warn: 0, error: 0 };

  function write(level, args) {
    const message = args.map(format).join(" ");
    if (stream) stream.write(`${new Date().toISOString()} [${level}] ${message}\n`);
    if (level === "ERROR") console.error(message);
    else if (level === "WARN") console.warn(message);
    else console.log(message);
  }

  return {
    file,
    counts,
    info: (...args) => write("INFO", args),
    warn: (...args) => { counts.warn++; write("WARN", args); },
    error: (...args) => { counts.error++; write("ERROR", args); },
    close: () => new Promise(resolve => (stream ? stream.end(resolve) : resolve())),
  };
}

// One compact JSON line per run, committed with the data. This is the audit trail
// that answers "when did it last actually work, and what did it say at the time".
function appendRunRecord(record, { file = RUN_HISTORY } = {}) {
  try {
    const target = path.resolve(process.cwd(), file);
    fs.mkdirSync(path.dirname(target), { recursive: true });

    const line = JSON.stringify({ at: new Date().toISOString(), ...record });
    const existing = fs.existsSync(target)
      ? fs.readFileSync(target, "utf8").split("\n").filter(Boolean)
      : [];

    existing.push(line);
    fs.writeFileSync(target, existing.slice(-MAX_RUN_RECORDS).join("\n") + "\n");
    return target;
  } catch (error) {
    console.error(`Could not append the run record: ${error.message}`);
    return null;
  }
}

function readRunHistory({ file = RUN_HISTORY } = {}) {
  const target = path.resolve(process.cwd(), file);
  if (!fs.existsSync(target)) return [];
  return fs.readFileSync(target, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = { createLogger, appendRunRecord, readRunHistory };
