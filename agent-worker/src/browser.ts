import { chromium, type Browser, type BrowserContext } from "playwright";

export type LaunchedBrowser = {
  browser: Browser;
  context: BrowserContext;
  liveUrl: string | null;
  cleanup: () => Promise<void>;
};

const useBrowserbase = (process.env.USE_BROWSERBASE || "").toLowerCase() === "true";

async function createBrowserbaseSession(): Promise<{ id: string; connectUrl: string; liveUrl: string }> {
  const apiKey = process.env.BROWSERBASE_API_KEY!;
  const projectId = process.env.BROWSERBASE_PROJECT_ID!;
  const r = await fetch("https://api.browserbase.com/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BB-API-Key": apiKey },
    body: JSON.stringify({ projectId }),
  });
  if (!r.ok) throw new Error(`Browserbase session create failed: ${r.status} ${await r.text()}`);
  const j = (await r.json()) as { id: string; connectUrl: string };
  const liveUrl = `https://www.browserbase.com/sessions/${j.id}`;
  return { id: j.id, connectUrl: j.connectUrl, liveUrl };
}

export async function launchBrowser(): Promise<LaunchedBrowser> {
  if (useBrowserbase && process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID) {
    const sess = await createBrowserbaseSession();
    const browser = await chromium.connectOverCDP(sess.connectUrl, { timeout: 120_000 });
    const context = browser.contexts()[0] ?? (await browser.newContext());
    return {
      browser,
      context,
      liveUrl: sess.liveUrl,
      cleanup: async () => {
        try { await browser.close(); } catch {}
      },
    };
  }

  // Local headless Chromium (default)
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1366, height: 850 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  return {
    browser,
    context,
    liveUrl: null,
    cleanup: async () => {
      try { await context.close(); } catch {}
      try { await browser.close(); } catch {}
    },
  };
}
