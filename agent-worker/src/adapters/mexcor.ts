import type { BrowserContext, Page } from "playwright";
import { runLlmAgent } from "../agent/llmAgent.js";
import { logStep, setProgress, uploadScreenshot, uploadStepScreenshot } from "../runHelpers.js";

const LOGIN_URL =
  process.env.MEXCOR_LOGIN_URL ||
  "https://mexcor.encompass8.com/Home?DashboardID=100008&DestURL=Home%3FDashboardID%3D167349%26%26";
const ACCOUNT_LABEL = (process.env.MEXCOR_ACCOUNT_LABEL || "Suppliers").trim();

export type MexcorResult = { filePath: string; filename: string };

async function loginAndPickAccount(
  page: Page,
  username: string,
  password: string,
  runId: string,
): Promise<number> {
  let preflightStep = 0;
  const snap = async (label: string, message: string, extra: Record<string, unknown> = {}) => {
    preflightStep += 1;
    await uploadScreenshot(runId, page).catch(() => {});
    const screenshot_url = await uploadStepScreenshot(runId, page, preflightStep, label);
    await logStep(runId, preflightStep, "browser", {
      output: { phase: label, message, url: page.url(), screenshot_url, ...extra },
    }).catch(() => {});
  };

  await setProgress(runId, "logging_in", "Opening Mexcor login page");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await snap("page_loaded", `Loaded ${page.url()}`);

  // --- Username field ---
  const namedSelectors = [
    'input[name="UserName"]',
    'input[name="Username"]',
    'input[name="username"]',
    'input#UserName',
    'input#Username',
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[placeholder*="user" i]',
    'input[placeholder*="email" i]',
  ].join(", ");

  let userField = page.locator(namedSelectors).first();
  let visible = await userField
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  if (!visible) {
    const fallback = page.locator(
      'input:visible:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="submit"]):not([type="button"])',
    ).first();
    visible = await fallback
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (visible) userField = fallback;
  }

  if (!visible) {
    await snap("login_form_missing", "Could not find a username input on the page");
    throw new Error("Mexcor login form did not appear (no username input found).");
  }

  // Use pressSequentially so React-controlled inputs (with eye toggles) reliably
  // receive each keystroke — .fill() can be swallowed by some custom inputs.
  await userField.click();
  await userField.fill("");
  await userField.pressSequentially(username, { delay: 25 });

  const passField = page.locator('input[type="password"]').first();
  await passField.waitFor({ state: "visible", timeout: 15_000 });
  await passField.click();
  await passField.fill("");
  await passField.pressSequentially(password, { delay: 25 });

  // Read back what actually landed in the inputs (lengths only — never values).
  const userVal = (await userField.inputValue().catch(() => "")) || "";
  const passVal = (await passField.inputValue().catch(() => "")) || "";

  await snap("credentials_filled", "Filled username + password", {
    username_length_env: username.length,
    username_length_in_field: userVal.length,
    username_matches: userVal === username,
    password_length_env: password.length,
    password_length_in_field: passVal.length,
    password_matches_length: passVal.length === password.length,
  });

  // --- Submit: click the visible Log in button first, Enter as fallback. ---
  const loginBtn = page.locator(
    [
      'button:visible:has-text("Log in")',
      'button:visible:has-text("Login")',
      'button:visible:has-text("Sign in")',
      'input[type="submit"]:visible:not(.HiddenSubmitButton)',
      'input[type="button"][value*="Log" i]:visible',
    ].join(", "),
  ).first();

  let clicked = false;
  if (await loginBtn.count()) {
    try {
      await loginBtn.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      await loginBtn.click({ timeout: 10_000 });
      clicked = true;
    } catch {
      clicked = false;
    }
  }
  if (!clicked) {
    await passField.press("Enter").catch(() => {});
  }

  // Give the server time to respond — wait for either navigation or the error banner.
  await Promise.race([
    page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {}),
    page.waitForURL((u) => !/login/i.test(u.toString()), { timeout: 15_000 }).catch(() => {}),
    page.waitForTimeout(6_000),
  ]);
  await snap("submitted_login", "Submitted login form");

  // --- Detect Encompass8's own "Invalid UserName/Email or password" banner ---
  const errBanner = page.locator(
    'text=/Invalid\\s+UserName|Invalid\\s+Username|Invalid\\s+Email|invalid\\s+password/i',
  ).first();
  if (await errBanner.isVisible().catch(() => false)) {
    await snap("login_rejected", "Encompass8 returned 'Invalid UserName/Email or password'");
    throw new Error(
      "Mexcor rejected the credentials. Check Railway: MEXCOR_USERNAME / MEXCOR_PASSWORD may have trailing whitespace, or the password was reset on Encompass (it warns 'same on all Encompass systems'). The credentials_filled step logs the lengths we filled — compare those to what you set in Railway.",
    );
  }

  // --- Account picker (Vendors / Suppliers) ---
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
    await snap("account_picker", `Account picker visible — selecting ${ACCOUNT_LABEL}`);
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
    await snap("account_confirmed", `Confirmed ${ACCOUNT_LABEL} account`);
  }

  const stillOnLogin = await page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
  if (stillOnLogin) {
    await snap("login_failed", "Password field still visible after submit");
    throw new Error(
      "Mexcor login appears to have failed — still seeing a password field after submit.",
    );
  }

  await setProgress(runId, "authenticated", "Logged in, locating sales report");
  await snap("authenticated", "Reached post-login dashboard");
  return preflightStep;
}

export async function runMexcor(
  context: BrowserContext,
  runId: string,
  learnings: { question: string; answer: string }[],
): Promise<MexcorResult> {
  // Trim env vars — pasting into Railway often grabs trailing whitespace/newlines.
  const username = (process.env.MEXCOR_USERNAME || "").trim();
  const password = (process.env.MEXCOR_PASSWORD || "").trim();
  if (!username || !password) {
    throw new Error("MEXCOR_USERNAME / MEXCOR_PASSWORD missing on worker");
  }

  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const lastPreflightStep = await loginAndPickAccount(page, username, password, runId);

  const goal = `You are already logged into the Mexcor / Encompass8 supplier portal as the "${ACCOUNT_LABEL}" account. Do NOT try to log in again.

Your only job: find the latest sales report and download it as XLSX.

Steps:
1. Use the left sidebar — look for "Sales Execution", "Order Management", "Sales", "Reports", or "Sales Report".
2. Open the most recent / current period report (use defaults if asked for a date range).
3. Click Export / Download / Excel / XLSX. The download is captured automatically — call download_complete right after.`;

  return runLlmAgent({
    context,
    runId,
    goal,
    startUrl: page.url(),
    page,
    credentials: {},
    learnings,
    maxSteps: Number(process.env.AGENT_MAX_STEPS || 30),
    startStepIndex: lastPreflightStep,
  });
}
