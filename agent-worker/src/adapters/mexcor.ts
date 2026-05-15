import type { BrowserContext, Page } from "playwright";
import { runLlmAgent } from "../agent/llmAgent.js";
import { setProgress } from "../runHelpers.js";

const LOGIN_URL = "https://encompass8.com/User/Login";
const ACCOUNT_LABEL = process.env.MEXCOR_ACCOUNT_LABEL || "Suppliers";

export type MexcorResult = { filePath: string; filename: string };

async function loginAndPickAccount(
  page: Page,
  username: string,
  password: string,
  runId: string,
): Promise<void> {
  await setProgress(runId, "logging_in", "Opening Mexcor login page");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  const userField = page.locator(
    [
      'input[name="UserName"]',
      'input[name="Username"]',
      'input[name="username"]',
      'input[type="email"]',
      'input[autocomplete="username"]',
      'input[placeholder*="user" i]',
      'input[placeholder*="email" i]',
    ].join(", "),
  ).first();
  await userField.waitFor({ state: "visible", timeout: 30_000 });
  await userField.fill(username);

  const passField = page.locator('input[type="password"]').first();
  await passField.waitFor({ state: "visible", timeout: 15_000 });
  await passField.fill(password);

  await setProgress(runId, "logging_in", "Submitting credentials");
  const loginBtn = page.locator(
    [
      'button:has-text("Log in")',
      'button:has-text("Login")',
      'button:has-text("Sign in")',
      'input[type="submit"]',
    ].join(", "),
  ).first();
  if (await loginBtn.count()) {
    await loginBtn.click({ timeout: 10_000 });
  } else {
    await passField.press("Enter");
  }

  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

  const pickerSelect = page.locator(
    'select:has(option:text-matches("Suppliers|Vendors", "i"))',
  ).first();
  const confirmBtn = page.locator(
    'button:has-text("Confirm"), input[type="submit"][value*="Confirm" i]',
  ).first();

  const sawPicker = await pickerSelect
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  if (sawPicker) {
    await setProgress(runId, "selecting_account", `Selecting ${ACCOUNT_LABEL} account`);

    try {
       await pickerSelect.selectOption({ label: ACCOUNT_LABEL }, { timeout: 5_000 });
    } catch {
      try {
        await pickerSelect.selectOption(
   { label: new RegExp(ACCOUNT_LABEL, "i") } as any,
   { timeout: 5_000 },
 );
      } catch {
        await pickerSelect.click({ timeout: 5_000 }).catch(() => {});
        const opt = page
          .locator(`option, li, [role="option"]`)
          .filter({ hasText: new RegExp(ACCOUNT_LABEL, "i") })
          .first();
        await opt.click({ timeout: 5_000 });
      }
    }

    await confirmBtn.waitFor({ state: "visible", timeout: 10_000 });
    await confirmBtn.click({ timeout: 10_000 });

    await pickerSelect.waitFor({ state: "hidden", timeout: 20_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  }

  const stillOnLogin = await page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
  if (stillOnLogin) {
    throw new Error(
      "Mexcor login appears to have failed — still seeing a password field after submit. Check MEXCOR_USERNAME/MEXCOR_PASSWORD and MEXCOR_ACCOUNT_LABEL.",
    );
  }

  await setProgress(runId, "authenticated", "Logged in, locating sales report");
}

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
  await loginAndPickAccount(page, username, password, runId);

  const goal = `You are already logged into the Mexcor / Encompass8 supplier portal as the "${ACCOUNT_LABEL}" account. Do NOT try to log in again — the username/password fields will not appear, and if they do, it means the session was lost (call ask_human instead of refilling).

Your only job: find the latest sales report and download it as XLSX.

Steps:
1. Navigate using the left sidebar / top menu. Look for items like "Sales", "Sales Comparison", "Reports", "Sales Report", or "Order Management".
2. Open the most recent / current period report (use defaults if a date range is requested).
3. Find an export action (Export, Download, Excel, XLSX) and click it. The download will be captured automatically — call download_complete right after you trigger it.`;

  return runLlmAgent({
    context,
    runId,
    goal,
    startUrl: page.url(),
    page,
    credentials: {},
    learnings,
    maxSteps: Number(process.env.AGENT_MAX_STEPS || 30),
  });
}
