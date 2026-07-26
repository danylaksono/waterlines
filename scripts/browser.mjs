/**
 * browser.mjs
 *
 * Minimal Chrome DevTools Protocol driver - enough to load a page, capture its
 * console, evaluate expressions and take screenshots, with no npm dependency.
 * Used by `scripts/smoke.mjs`.
 *
 * Node 21+ ships a global `WebSocket`, which is the only thing CDP needs on
 * top of `fetch`.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

/** @returns {string} path to a Chromium-family browser */
export function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    'No Chrome/Edge found. Set CHROME_PATH to a Chromium-family executable.'
  );
}

/**
 * Launch a headless browser and connect to it.
 *
 * @param {Object} [options]
 * @param {number} [options.width=1440]
 * @param {number} [options.height=900]
 * @param {boolean} [options.headless=true]
 * @returns {Promise<Browser>}
 */
export async function launch(options = {}) {
  const { width = 1440, height = 900, headless = true, gpu = false } = options;
  const profile = await mkdtemp(join(tmpdir(), 'waterlines-chrome-'));
  const port = 9222 + Math.floor(Math.random() * 500);

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    'about:blank',
  ];
  if (gpu) {
    // Real GPU rasterisation. Numbers measured this way are representative of
    // what a user sees; SwiftShader numbers are a pessimistic lower bound.
    args.unshift('--ignore-gpu-blocklist', '--enable-gpu-rasterization');
  } else {
    // MapLibre needs WebGL; SwiftShader supplies it without a real GPU.
    args.unshift('--enable-unsafe-swiftshader', '--use-angle=swiftshader');
  }
  if (headless) args.unshift('--headless=new');

  const child = spawn(findChrome(), args, { stdio: 'ignore' });
  const target = await waitForTarget(port);
  const browser = new Browser(child, profile, port, target);
  await browser.connect();
  return browser;
}

class Browser {
  constructor(child, profile, port, target) {
    this.child = child;
    this.profile = profile;
    this.port = port;
    this.target = target;
    this.messages = [];
    this.errors = [];
    this._id = 0;
    this._pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });

    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        this.messages.push({
          type: msg.params.type,
          text: msg.params.args.map(describe).join(' '),
        });
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.errors.push(d.exception?.description || d.text);
      } else if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry;
        if (e.level === 'error') this.errors.push(`${e.source}: ${e.text}`);
      }
    });

    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Page.enable');
  }

  /**
   * @param {string} method
   * @param {Object} [params]
   * @param {number} [timeoutMs=300000] generous by default: profiling a slow
   *   render can block the page for a long time on a software rasteriser
   */
  send(method, params = {}, timeoutMs = 300000) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  /** @param {string} url */
  async goto(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"', 30000);
  }

  /**
   * Evaluate an expression in the page and return its JSON value.
   *
   * @param {string} expression
   * @param {boolean} [awaitPromise=true]
   */
  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text
      );
    }
    return result.result.value;
  }

  /**
   * Poll an expression until it is truthy.
   *
   * @param {string} expression
   * @param {number} [timeoutMs=20000]
   * @param {number} [intervalMs=100]
   */
  async waitFor(expression, timeoutMs = 20000, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let value = false;
      try {
        value = await this.evaluate(`!!(${expression})`, false);
      } catch {
        /* the page may still be navigating */
      }
      if (value) return true;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for: ${expression}`);
      }
      await sleep(intervalMs);
    }
  }

  /** @param {string} path where to write the PNG */
  async screenshot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, Buffer.from(data, 'base64'));
    return path;
  }

  async close() {
    try { this.ws?.close(); } catch { /* already gone */ }
    this.child.kill();
    await rm(this.profile, { recursive: true, force: true }).catch(() => {});
  }
}

async function waitForTarget(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('Chrome did not expose a debug target');
    await sleep(150);
  }
}

function describe(arg) {
  if (arg.value !== undefined) return String(arg.value);
  if (arg.description) return arg.description;
  return arg.type;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { sleep };
