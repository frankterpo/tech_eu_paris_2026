/**
 * Lightpanda Cloud — Headless browser via CDP (Chrome DevTools Protocol)
 *
 * Uses Lightpanda's cloud WebSocket endpoint with puppeteer-core to:
 * 1. Headlessly login to cala.ai dashboard
 * 2. Extract JWT session token
 * 3. Cache token for /admin API calls (triggers, subscriptions)
 *
 * Env vars:
 *   LIGHTPANDA_TOKEN — Lightpanda cloud API token
 *   CALA_EMAIL       — Cala dashboard login email
 *   CALA_PASSWORD     — Cala dashboard login password
 *
 * Falls back gracefully when any env var is missing.
 */

let puppeteer: any = null;
try {
  puppeteer = await import('puppeteer-core');
} catch {
  // puppeteer-core not installed — all methods return graceful fallbacks
}

interface CachedJWT {
  token: string;
  expiresAt: number; // epoch ms
}

export class LightpandaClient {
  private static readonly WS_EU = 'wss://euwest.cloud.lightpanda.io/ws';
  private static readonly WS_US = 'wss://uswest.cloud.lightpanda.io/ws';
  private static readonly CALA_LOGIN_URL = 'https://app.cala.ai';
  private static readonly JWT_TTL_MS = 3_600_000; // 1 hour cache (conservative)
  private static readonly LOGIN_TIMEOUT_MS = 30_000;

  private static cachedJWT: CachedJWT | null = null;

  private static getConfig() {
    return {
      lightpandaToken: process.env.LIGHTPANDA_TOKEN || null,
      calaEmail: process.env.CALA_EMAIL || null,
      calaPassword: process.env.CALA_PASSWORD || null,
    };
  }

  static isAvailable(): boolean {
    // Available if we have a manual JWT override OR full headless config
    if (process.env.CALA_JWT) return true;
    const cfg = this.getConfig();
    return !!(puppeteer && cfg.lightpandaToken && cfg.calaEmail && cfg.calaPassword);
  }

  private static getWSEndpoint(): string {
    const token = this.getConfig().lightpandaToken;
    // Use Chrome browser for full JS compat with Cala's SPA
    return `${this.WS_EU}?browser=chrome&token=${token}`;
  }

  /**
   * Get a valid Cala JWT token.
   * Priority:
   *   1. CALA_JWT env var (manual override — paste from browser DevTools)
   *   2. Cached JWT from previous headless login
   *   3. Fresh headless login via Lightpanda cloud
   */
  static async getCalaJWT(): Promise<string | null> {
    // Priority 1: Manual JWT override (most reliable — paste from browser session)
    const manualJWT = process.env.CALA_JWT;
    if (manualJWT && manualJWT.split('.').length === 3) {
      // Cache it so downstream code sees it consistently
      if (!this.cachedJWT || this.cachedJWT.token !== manualJWT) {
        this.cacheJWT(manualJWT);
        console.log('[Lightpanda] Using CALA_JWT from env (manual override)');
      }
      return manualJWT;
    }

    if (!puppeteer || !this.getConfig().lightpandaToken || !this.getConfig().calaEmail || !this.getConfig().calaPassword) {
      console.log('[Lightpanda] Not available — missing LIGHTPANDA_TOKEN, CALA_EMAIL, or CALA_PASSWORD');
      return null;
    }

    // Priority 2: Return cached token if still valid
    if (this.cachedJWT && Date.now() < this.cachedJWT.expiresAt) {
      console.log('[Lightpanda] Using cached Cala JWT');
      return this.cachedJWT.token;
    }

    // Priority 3: Fresh headless login
    console.log('[Lightpanda] Performing headless login to Cala…');
    return this.performCalaLogin();
  }

  /**
   * Headlessly login to Cala dashboard and extract JWT.
   * Flow:
   * 1. Navigate to app.cala.ai
   * 2. Wait for login form
   * 3. Enter email + password
   * 4. Submit and wait for dashboard
   * 5. Extract JWT from cookies / localStorage / network
   */
  private static async performCalaLogin(): Promise<string | null> {
    if (!puppeteer) {
      console.warn('[Lightpanda] puppeteer-core not installed');
      return null;
    }

    const cfg = this.getConfig();
    let browser: any = null;

    try {
      console.log('[Lightpanda] Connecting to cloud browser…');
      browser = await puppeteer.default.connect({
        browserWSEndpoint: this.getWSEndpoint(),
      });

      const context = await browser.createBrowserContext();
      const page = await context.newPage();

      // Set reasonable viewport + user agent
      await page.setViewport({ width: 1280, height: 800 });
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

      // Intercept network to capture JWT from API responses
      let capturedJWT: string | null = null;
      await page.setRequestInterception(true);
      page.on('request', (req: any) => req.continue());
      page.on('response', async (res: any) => {
        try {
          const url = res.url();
          // Cala may return JWT in auth response headers or body
          if (url.includes('auth') || url.includes('login') || url.includes('token') || url.includes('session')) {
            const headers = res.headers();
            // Check Authorization header
            const authHeader = headers['authorization'] || headers['x-auth-token'] || '';
            if (authHeader.includes('Bearer ')) {
              capturedJWT = authHeader.replace('Bearer ', '');
            }
            // Check response body for token
            if (!capturedJWT && res.status() === 200) {
              try {
                const body = await res.json();
                if (body.token) capturedJWT = body.token;
                if (body.access_token) capturedJWT = body.access_token;
                if (body.jwt) capturedJWT = body.jwt;
                if (body.data?.token) capturedJWT = body.data.token;
                if (body.data?.access_token) capturedJWT = body.data.access_token;
              } catch {
                // Not JSON — skip
              }
            }
          }
        } catch {
          // Ignore response parsing errors
        }
      });

      // Navigate to Cala login
      console.log('[Lightpanda] Navigating to Cala…');
      await page.goto(this.CALA_LOGIN_URL, {
        waitUntil: 'networkidle2',
        timeout: this.LOGIN_TIMEOUT_MS,
      });

      // Wait for login form — try common selectors
      const emailSelectors = [
        'input[type="email"]',
        'input[name="email"]',
        'input[placeholder*="email" i]',
        'input[placeholder*="Email" i]',
        '#email',
        '[data-testid="email-input"]',
      ];
      const passwordSelectors = [
        'input[type="password"]',
        'input[name="password"]',
        '#password',
        '[data-testid="password-input"]',
      ];

      let emailInput = null;
      for (const sel of emailSelectors) {
        emailInput = await page.$(sel);
        if (emailInput) break;
      }

      if (!emailInput) {
        // Maybe it's a redirect-based auth (OAuth) — check if we're already logged in
        console.log('[Lightpanda] No email input found — checking if already authenticated…');
        const jwt = await this.extractJWTFromPage(page);
        if (jwt) {
          this.cacheJWT(jwt);
          await page.close();
          await context.close();
          await browser.disconnect();
          return jwt;
        }
        console.warn('[Lightpanda] Cannot find login form');
        await page.close();
        await context.close();
        await browser.disconnect();
        return null;
      }

      // Type email
      console.log('[Lightpanda] Filling login form…');
      await emailInput.click({ clickCount: 3 }); // Select all
      await emailInput.type(cfg.calaEmail!, { delay: 30 });

      // Type password
      let passwordInput = null;
      for (const sel of passwordSelectors) {
        passwordInput = await page.$(sel);
        if (passwordInput) break;
      }

      if (!passwordInput) {
        // Some SPAs show password after email — wait
        await page.waitForSelector('input[type="password"]', { timeout: 5000 }).catch(() => {});
        passwordInput = await page.$('input[type="password"]');
      }

      if (passwordInput) {
        await passwordInput.click({ clickCount: 3 });
        await passwordInput.type(cfg.calaPassword!, { delay: 30 });
      }

      // Submit — try button click, then Enter key
      const submitSelectors = [
        'button[type="submit"]',
        'button:has-text("Log in")',
        'button:has-text("Sign in")',
        'button:has-text("Login")',
        '[data-testid="login-button"]',
      ];

      let submitted = false;
      for (const sel of submitSelectors) {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          submitted = true;
          break;
        }
      }
      if (!submitted && passwordInput) {
        await passwordInput.press('Enter');
      }

      // Wait for navigation / dashboard load
      console.log('[Lightpanda] Waiting for authentication…');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});

      // Wait a bit more for SPA to settle
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Check captured JWT from network interception
      if (capturedJWT) {
        console.log('[Lightpanda] JWT captured from network response');
        this.cacheJWT(capturedJWT);
        await page.close();
        await context.close();
        await browser.disconnect();
        return capturedJWT;
      }

      // Extract JWT from page (cookies, localStorage, sessionStorage)
      const jwt = await this.extractJWTFromPage(page);
      if (jwt) {
        console.log('[Lightpanda] JWT extracted from page storage');
        this.cacheJWT(jwt);
        await page.close();
        await context.close();
        await browser.disconnect();
        return jwt;
      }

      console.warn('[Lightpanda] Login completed but no JWT found — check Cala auth flow');
      await page.close();
      await context.close();
      await browser.disconnect();
      return null;
    } catch (err: any) {
      console.error(`[Lightpanda] Login failed: ${err.message}`);
      if (browser) await browser.disconnect().catch(() => {});
      return null;
    }
  }

  /**
   * Extract JWT from page cookies, localStorage, sessionStorage.
   */
  private static async extractJWTFromPage(page: any): Promise<string | null> {
    try {
      // Check cookies
      const cookies = await page.cookies();
      for (const cookie of cookies) {
        const name = cookie.name.toLowerCase();
        if (name.includes('token') || name.includes('jwt') || name.includes('auth') || name.includes('session')) {
          const val = cookie.value;
          // JWT is typically a long base64-ish string with dots
          if (val.length > 30 && (val.includes('.') || val.match(/^[A-Za-z0-9_-]+$/))) {
            console.log(`[Lightpanda] Found JWT in cookie: ${cookie.name}`);
            return val;
          }
        }
      }

      // Check localStorage and sessionStorage
      const storageToken = await page.evaluate(() => {
        const storage = { ...localStorage, ...sessionStorage };
        for (const [key, val] of Object.entries(storage)) {
          const k = (key as string).toLowerCase();
          if (k.includes('token') || k.includes('jwt') || k.includes('auth') || k.includes('access')) {
            const v = val as string;
            if (v && v.length > 30) return v;
          }
        }
        // Check for Supabase auth (common for SaaS apps)
        for (const [key, val] of Object.entries(storage)) {
          if ((key as string).startsWith('sb-') && (key as string).includes('auth-token')) {
            try {
              const parsed = JSON.parse(val as string);
              return parsed.access_token || parsed.token || null;
            } catch {
              return val;
            }
          }
        }
        return null;
      });

      if (storageToken) return storageToken;

      return null;
    } catch {
      return null;
    }
  }

  private static cacheJWT(token: string) {
    this.cachedJWT = {
      token,
      expiresAt: Date.now() + this.JWT_TTL_MS,
    };
    console.log(`[Lightpanda] JWT cached (valid for ${this.JWT_TTL_MS / 60_000} min)`);
  }

  /**
   * Clear cached JWT (e.g., on 401 from Cala /admin).
   */
  static clearJWTCache() {
    this.cachedJWT = null;
    console.log('[Lightpanda] JWT cache cleared');
  }

  /**
   * Generic headless page scrape — navigate to URL, extract content.
   * Used as a more reliable alternative to fetch for JS-heavy pages.
   */
  static async scrapeUrl(url: string, opts: {
    waitSelector?: string;
    extractScript?: string;
    timeout?: number;
  } = {}): Promise<{ content: string | null; title: string | null }> {
    if (!puppeteer || !this.getConfig().lightpandaToken) {
      return { content: null, title: null };
    }

    let browser: any = null;
    try {
      browser = await puppeteer.default.connect({
        browserWSEndpoint: this.getWSEndpoint(),
      });
      const context = await browser.createBrowserContext();
      const page = await context.newPage();

      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: opts.timeout || 15000,
      });

      if (opts.waitSelector) {
        await page.waitForSelector(opts.waitSelector, { timeout: 5000 }).catch(() => {});
      }

      const title = await page.title();
      const content = opts.extractScript
        ? await page.evaluate(opts.extractScript)
        : await page.evaluate(() => document.body.innerText?.slice(0, 5000) || '');

      await page.close();
      await context.close();
      await browser.disconnect();

      return { content, title };
    } catch (err: any) {
      console.warn(`[Lightpanda] Scrape failed: ${err.message}`);
      if (browser) await browser.disconnect().catch(() => {});
      return { content: null, title: null };
    }
  }
}
