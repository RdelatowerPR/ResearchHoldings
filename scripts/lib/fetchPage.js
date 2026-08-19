const axios = require("axios");
const zlib = require("zlib");

// blockworks.co redirects to blockworks.com today, but the .co host was the address
// for years and may outlive the redirect - try both before giving up.
const DEFAULT_URLS = [
  "https://blockworks.com/financial-disclosures",
  "https://blockworks.co/financial-disclosures",
];

const USER_AGENT = "ResearchHoldings/1.0 (+https://github.com/RdelatowerPR/ResearchHoldings)";

// HTTP 200 is not evidence that we got the page. A bot interstitial or an error
// template answers 200 with plenty of bytes and parses to nothing.
function rejectionReason(html) {
  if (typeof html !== "string") return `response was ${typeof html}, not HTML`;
  if (html.length < 2000) return `response was only ${html.length} bytes`;

  const probe = html.toLowerCase();
  if (probe.includes("just a moment") || probe.includes("enable javascript and cookies")) {
    return "response looks like a bot challenge page";
  }
  if (probe.includes("<title>404") || probe.includes("page not found")) {
    return "response looks like a 404 page";
  }
  if (!probe.includes("disclosure")) {
    return "response never mentions disclosures";
  }
  return null;
}

/**
 * Turn a response body into HTML, decompressing if it is still compressed.
 *
 * The Wayback id_ endpoint hands back the bytes as originally stored, which are often
 * gzip with no Content-Encoding header to announce it - so nothing downstream
 * decompresses them and the "page" parses to zero holdings. Sniff the magic bytes
 * rather than trusting the header.
 */
function decodeBody(data, contentEncoding) {
  if (typeof data === "string") return data;

  let buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

  try {
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      buf = zlib.gunzipSync(buf);
    } else if (contentEncoding === "br") {
      buf = zlib.brotliDecompressSync(buf);
    } else if (buf.length > 2 && buf[0] === 0x78 && [0x01, 0x9c, 0xda].includes(buf[1])) {
      buf = zlib.inflateSync(buf);
    }
  } catch {
    // Not actually compressed, or compressed in a way we can't read - use it raw
  }

  return buf.toString("utf8");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch the disclosures page, trying each candidate URL with backoff.
 * Resolves to { url, html }; throws with every failure listed if none worked.
 */
async function fetchDisclosuresPage({
  urls = DEFAULT_URLS,
  attempts = 3,
  timeout = 30000,
  log = console.log,
} = {}) {
  const failures = [];

  for (const url of urls) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        log(`Fetching ${url} (attempt ${attempt}/${attempts})...`);
        const response = await axios.get(url, {
          timeout,
          headers: { "User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml" },
        });

        const reason = rejectionReason(response.data);
        if (reason) {
          failures.push(`${url}: ${reason}`);
          log(`  rejected: ${reason}`);
        } else {
          return { url, html: response.data };
        }
      } catch (error) {
        const status = error.response?.status;
        failures.push(`${url}: ${status ? `HTTP ${status}` : error.message}`);
        log(`  failed: ${status ? `HTTP ${status}` : error.message}`);
      }

      if (attempt < attempts) await sleep(2000 * attempt);
    }
  }

  throw new Error(`Could not fetch a usable disclosures page.\n  ${failures.join("\n  ")}`);
}

module.exports = { fetchDisclosuresPage, rejectionReason, decodeBody, DEFAULT_URLS };
