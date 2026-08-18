const axios = require("axios");

// CoinGecko access, with a failsafe for the key going bad.
//
// A Pro key answers on pro-api.coingecko.com behind an x-cg-pro-api-key header; the
// free endpoint is a different host that ignores it. So an expired, revoked, or
// over-quota key doesn't degrade gracefully - every request 401s and the whole price
// run returns nothing while exiting cleanly. Rather than let that happen quietly,
// the client verifies the key up front, and demotes itself to the keyless endpoint
// the moment the key is rejected, loudly, at whatever point that happens.

const PRO_BASE = "https://pro-api.coingecko.com/api/v3";
const PUBLIC_BASE = "https://api.coingecko.com/api/v3";

// Keyless is rate limited hard enough that batches get dropped; pace accordingly.
const PRO_LIMITS = { requestDelay: 250, batchSize: 100 };
const KEYLESS_LIMITS = { requestDelay: 3000, batchSize: 10 };

// CoinGecko signals a bad key as 401/403, and a Pro key sent to the free host as a
// 400 carrying error_code 10010.
function authFailureReason(error) {
  const status = error.response?.status;
  if (status === 401) return "HTTP 401 (key rejected)";
  if (status === 403) return "HTTP 403 (key forbidden or out of quota)";

  if (status === 400) {
    const body = error.response?.data;
    const text = typeof body === "string" ? body : JSON.stringify(body || {});
    if (/10010|10002|api key/i.test(text)) return `HTTP 400 (${text.slice(0, 120)})`;
  }
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class CoinGeckoClient {
  /**
   * @param {object}   options
   * @param {string}  [options.apiKey]  Pro key; absent means keyless from the start.
   * @param {object}  [options.logger]  Anything with info/warn/error.
   * @param {Function}[options.request] Injected for tests; defaults to axios.get.
   */
  constructor({ apiKey, logger = console, request = null } = {}) {
    this.logger = logger;
    this.request = request || ((url, config) => axios.get(url, config));

    this.apiKey = apiKey || null;
    this.mode = this.apiKey ? "pro" : "keyless";
    this.demotionReason = null;
    this.verified = false;
  }

  get baseUrl() {
    return this.mode === "pro" ? PRO_BASE : PUBLIC_BASE;
  }

  get headers() {
    return this.mode === "pro" ? { "x-cg-pro-api-key": this.apiKey } : {};
  }

  get limits() {
    return this.mode === "pro" ? PRO_LIMITS : KEYLESS_LIMITS;
  }

  // What gets written into the run record, so a demotion is visible in history
  get status() {
    return { mode: this.mode, verified: this.verified, demotionReason: this.demotionReason };
  }

  demote(reason) {
    if (this.mode === "keyless") return;

    this.mode = "keyless";
    this.demotionReason = reason;
    this.logger.warn(
      `COINGECKO KEY FAILED: ${reason}. Falling back to the keyless endpoint - prices will still be collected, but slowly and with dropped batches. Check whether the key expired, was revoked, or is over quota.`
    );
  }

  /**
   * Confirm the key works before the run leans on it. Returns true if usable.
   * A network blip does not demote - only an actual rejection does.
   */
  async verify() {
    if (this.mode === "keyless") {
      this.logger.warn("No COINGECKO_API_KEY set - using the keyless endpoint, expect dropped batches.");
      return false;
    }

    try {
      await this.request(`${this.baseUrl}/ping`, { headers: this.headers, timeout: 20000 });
      this.verified = true;
      this.logger.info("CoinGecko Pro key verified.");
      return true;
    } catch (error) {
      const reason = authFailureReason(error);
      if (reason) {
        this.demote(`verification failed with ${reason}`);
        return false;
      }
      // Reachability problems are not key problems - keep the key and let retries work
      this.logger.warn(`CoinGecko ping failed (${error.message}); continuing with the key anyway.`);
      return true;
    }
  }

  /**
   * GET a CoinGecko path with retries. Rate limits and server errors back off; an
   * auth failure demotes to the keyless endpoint and retries there rather than
   * failing the run.
   */
  async get(pathname, params, { maxRetries = 3 } = {}) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.request(`${this.baseUrl}${pathname}`, {
          params,
          headers: this.headers,
          timeout: 30000,
        });
      } catch (error) {
        lastError = error;

        const authReason = authFailureReason(error);
        if (authReason) {
          this.demote(`request to ${pathname} failed with ${authReason}`);
          continue; // same attempt budget, now against the free endpoint
        }

        const status = error.response?.status;
        if (status === 429 || (status >= 500 && status < 600)) {
          const delay = this.limits.requestDelay * Math.pow(2, attempt);
          this.logger.info(`Rate limited or server error on ${pathname}; waiting ${delay / 1000}s (retry ${attempt}/${maxRetries})`);
          await sleep(delay);
          continue;
        }

        throw error;
      }
    }

    throw lastError || new Error(`Failed after ${maxRetries} retries`);
  }
}

module.exports = { CoinGeckoClient, authFailureReason, PRO_BASE, PUBLIC_BASE, PRO_LIMITS, KEYLESS_LIMITS };
