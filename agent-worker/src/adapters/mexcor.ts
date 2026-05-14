import type { BrowserContext, Page } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { AskHumanError, setProgress } from "../runHelpers.js";

const LOGIN_URL = "https://encompass8.com/User/Login";
const ACCOUNT_LABEL = process.env.MEXCOR_ACCOUNT_LABEL || "Suppliers";

export type MexcorResult = {
  filePath: string;
  filename: string;
};

export async function runMexcor(
  context: BrowserContext,
  runId: string,
  learnings: { question: string; answer: string }[],
): Promise<MexcorResult> {
  const username = process.env.MEXCOR_USERNAME;
  const password = process.env.MEXCOR_PASSWORD;
  if (!username || !password) {
    throw new Error("MEXCOR_USERNAME / MEXCOR_PASSWORD missing on worker");
  }

  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  await setProgress(runId, "navigating", `Opening ${LOGIN_URL}`);
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  await setProgress(runId, "login", "Filling Mexcor credentials");
  await fillFirstVisible(page, [
    'input[name="UserName"]',
    'input[name="username"]',
    'input[type="text"]',
    'input[type="email"]',
  ], username);
  await fillFirstVisible(page, [
    'input[name="Password"]',
    'input[name="password"]',
    'input[type="password"]',
  ], password);

  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {}),
    clickFirstVisible(page, [
      'button:has-text("Sign In")',
      'button:has-text("Log In")',
      'input[type="submit"]',
      'button[type="submit"]',
    ]),
  ]);

  // Account picker — must select "Suppliers", not "Vendors". Picking the
  // wrong one bounces back to the login form in a loop.
  await setProgress(runId, "account_picker", `Selecting "${ACCOUNT_LABEL}" account`);
  const picked = await pickAccount(page, ACCOUNT_LABEL);
  if (!picked) {
    throw new AskHumanError(
      `Could not find the "${ACCOUNT_LABEL}" account on the Mexcor account picker. Which option should I click?`,
      { url: page.url(), labelTried: ACCOUNT_LABEL },
      ["mexcor", "account_picker", ACCOUNT_LABEL.toLowerCase()],
    );
  }

  // Detect bounce-back to login (means we picked the wrong account)
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  if (/login/i.test(page.url())) {
    throw new Error(
      `Mexcor bounced back to the login page after selecting "${ACCOUNT_LABEL}". Likely picked the wrong account.`,
    );
  }

  // Apply learned playbook nudges
  await applyLearnings(page, learnings, runId);

  // Navigate to the comparison sales report
  await setProgress(runId, "navigate_report", "Opening sales comparison report");
  await openReport(page);

  // Trigger export and wait for download
  await setProgress(runId, "exporting", "Exporting report as XLSX");
  const dl = await Promise.race([
    page.waitForEvent("download", { timeout: 90_000 }),
    clickExport(page).then(() => page.waitForEvent("download", { timeout: 90_000 })),
  ]);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mexcor-"));
  const filename = (dl.suggestedFilename() || `mexcor-report-${Date.now()}.xlsx`).replace(/\s+/g, "_");
  const filePath = path.join(tmpDir, filename);
  await dl.saveAs(filePath);
  await setProgress(runId, "downloaded", `Saved ${filename}`);

  return { filePath, filename };
}

async function fillFirstVisible(page: Page, selectors: string[], value: string) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.fill(value);
      return;
    }
  }
  throw new Error(`No visible input matched: ${selectors.join(", ")}`);
}

async function clickFirstVisible(page: Page, selectors: string[]) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.click();
      return;
    }
  }
  throw new Error(`No visible button matched: ${selectors.join(", ")}`);
}

async function pickAccount(page: Page, label: string): Promise<boolean> {
  // Wait briefly for the picker to render
  await page.waitForTimeout(1500);
  const variants = [
    page.getByRole("button", { name: new RegExp(label, "i") }).first(),
    page.getByRole("link", { name: new RegExp(label, "i") }).first(),
    page.getByText(new RegExp(`^\\s*${label}\\s*$`, "i")).first(),
    page.locator(`*:has-text("${label}")`).filter({ hasNot: page.locator("html") }).first(),
  ];
  for (const v of variants) {
    if (await v.isVisible().catch(() => false)) {
      await v.click({ timeout: 5000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function openReport(page: Page) {
  // Best-effort: click any nav item that looks like a sales/comparison report.
  const candidates = [
    'a:has-text("Sales Comparison")',
    'a:has-text("Comparison Report")',
    'a:has-text("Sales Report")',
    'button:has-text("Reports")',
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.click().catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    }
  }
}

async function clickExport(page: Page) {
  const candidates = [
    'button:has-text("Export")',
    'button:has-text("Download")',
    'a:has-text("Excel")',
    'button:has-text("XLSX")',
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.click().catch(() => {});
      return;
    }
  }
  throw new AskHumanError(
    "Couldn't find an Export / Download button on the Mexcor report page. What should I click?",
    { url: page.url() },
    ["mexcor", "export"],
  );
}

async function applyLearnings(
  page: Page,
  learnings: { question: string; answer: string }[],
  runId: string,
) {
  if (!learnings.length) return;
  // Lightweight heuristic: if a learning answer says "click X", try to click X.
  for (const l of learnings) {
    const m = /click\s+["']?([^"'\n.]+?)["']?(?:$|\.)/i.exec(l.answer);
    if (m) {
      const target = m[1].trim();
      const loc = page.getByText(new RegExp(target, "i")).first();
      if (await loc.isVisible().catch(() => false)) {
        await setProgress(runId, "applying_learning", `Clicked "${target}" from learned playbook`);
        await loc.click().catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      }
    }
  }
}
