import type { BrowserContext, Page } from "playwright";
import { runLlmAgent } from "../agent/llmAgent.js";
import { logStep, setProgress, uploadScreenshot, uploadStepScreenshot } from "../runHelpers.js";

const LOGIN_URL =
  process.env.MEXCOR_LOGIN_URL ||
  "https://mexcor.encompass8.com/Home?DashboardID=100008&DestURL=Home%3FDashboardID%3D167349%26%26";
const ACCOUNT_LABEL = process.env.MEXCOR_ACCOUNT_LABEL || "Suppliers";

export type MexcorResult = { filePath: string; filename: string };

/**
 * Deterministically log into Encompass8 / Mexcor and pick the right account.
 * Each phase logs a preflight step with a screenshot so the UI shows a
 * thumbnail strip of where login broke (if it did).
 */
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

  // --- Find username field. Try named selectors first, then fall back to the
  // first visible non-password text input on the page. ---
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
    // Fallback: first visible text-like input that is NOT a password field.
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
    throw new Error(
      "Mexcor login form did not appear (no username input found). Check screenshots — the page may be showing a maintenance page, captcha, or has changed structure.",
    );
  }

  await userField.fill(username);
  const passField = page.locator('input[type="password"]').first();
  await passField.waitFor({ state: "visible", timeout: 15_000 });
  await passField.fill(password);
  await snap("credentials_filled", "Filled username + password");

  // Encompass renders a hidden <input type="submit" class="HiddenSubmitButton"
  // tabindex="10000"/> off-viewport as an Enter-key shim. We must exclude it
  // and target the REAL visible Login button (or just press Enter, which is
  // exactly what the shim is there to handle).
  const loginCandidates = page.locator(
    [
      'button:has-text("Log in")',
      'button:has-text("Login")',
      'button:has-text("Sign in")',
      'a:has-text("Log in")',
      'a:has-text("Login")',
      'input[type="submit"]:not(.HiddenSubmitButton):not([tabindex="10000"])',
    ].join(", "),
  );
  let clicked = false;
  const candidateCount = await loginCandidates.count();
  for (let i = 0; i < candidateCount; i++) {
    const cand = loginCandidates.nth(i);
    if (await cand.isVisible().catch(() => false)) {
      try {
        await cand.click({ timeout: 5_000 });
        clicked = true;
        break;
      } catch {
        // try next candidate
      }
    }
  }
  if (!clicked) {
    // Fall back to Enter on the password field — triggers the HiddenSubmitButton.
    await passField.press("Enter");
  }
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await snap("submitted_login", clicked ? "Clicked visible Login button" : "Pressed Enter to submit form");

  // --- Account picker (Vendors / Suppliers) ---
  // Encompass renders this as a custom combobox: a visible trigger (showing the
  // currently selected account like "Vendors (AP Contact)") that must be CLICKED
  // to reveal the list of accounts. A hidden native <select> may also exist.
  const confirmBtn = page.locator(
    'button:has-text("Confirm"), input[type="submit"][value*="Confirm" i]',
  ).first();

  // Detect the picker by looking for either the Confirm button OR a visible
  // element containing "Vendors" / account text inside the Logon dialog.
  const sawPicker = await confirmBtn
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  if (sawPicker) {
    await snap("account_picker", `Account picker visible — selecting ${ACCOUNT_LABEL}`);

    // Strategy 1: try the native <select> path (in case Encompass serves a real select).
    const nativeSelect = page.locator(
      'select:has(option:text-matches("Suppliers|Vendors", "i"))',
    ).first();
    let selected = false;
    if (await nativeSelect.count()) {
      try {
        await nativeSelect.selectOption({ label: new RegExp(ACCOUNT_LABEL, "i") } as any, {
          timeout: 3_000,
        });
        selected = true;
      } catch {
        // fall through to combobox path
      }
    }

    // Strategy 2: custom combobox — click the visible trigger, then pick option.
    if (!selected) {
      const triggerCandidates = [
        '[role="combobox"]',
        'input[readonly]',
        'div.k-dropdown, span.k-dropdown, span.k-dropdown-wrap', // Kendo UI (common in Encompass)
        '.dropdown-toggle, [data-toggle="dropdown"]',
        // last-ditch: any visible element in the dialog containing "Vendors"
        'text=/Vendors/i',
      ];

      let triggerClicked = false;
      for (const sel of triggerCandidates) {
        const trig = page.locator(sel).first();
        if (await trig.isVisible().catch(() => false)) {
          try {
            await trig.click({ timeout: 3_000 });
            triggerClicked = true;
            break;
          } catch {
            /* try next */
          }
        }
      }

      if (!triggerClicked) {
        await snap("picker_trigger_missing", "Could not find a visible combobox trigger");
        throw new Error(
          "Could not open Mexcor account picker — no visible trigger found. See screenshot.",
        );
      }

      await page.waitForTimeout(500);
      await snap("picker_opened", "Clicked picker trigger — looking for Suppliers option");

      const suppliersOption = page
        .locator('[role="option"], li, .k-list-item, .dropdown-item, option')
        .filter({ hasText: new RegExp(ACCOUNT_LABEL, "i") })
        .filter({ has: page.locator(':scope:visible') })
        .first();

      // Fallback locator if the :visible filter doesn't match
      const suppliersOptionLoose = page
        .locator(`:visible:has-text("${ACCOUNT_LABEL}")`)
        .filter({ hasNot: page.locator('button, [role="button"]') })
        .first();

      try {
        await suppliersOption.waitFor({ state: "visible", timeout: 5_000 });
        await suppliersOption.click({ timeout: 5_000 });
      } catch {
        await suppliersOptionLoose.click({ timeout: 5_000 });
      }
      await snap("picker_selected", `Selected ${ACCOUNT_LABEL} from dropdown`);
    }

    await confirmBtn.waitFor({ state: "visible", timeout: 10_000 });
    await confirmBtn.click({ timeout: 10_000 });
    await confirmBtn.waitFor({ state: "hidden", timeout: 20_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await snap("account_confirmed", `Confirmed ${ACCOUNT_LABEL} account`);
  }

  // --- Sanity check: still on login? ---
  const stillOnLogin = await page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
  if (stillOnLogin) {
    await snap("login_failed", "Password field still visible after submit");
    throw new Error(
      "Mexcor login appears to have failed — still seeing a password field after submit. Check MEXCOR_USERNAME/MEXCOR_PASSWORD and MEXCOR_ACCOUNT_LABEL.",
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
  const username = process.env.MEXCOR_USERNAME;
  const password = process.env.MEXCOR_PASSWORD;
  if (!username || !password) {
    throw new Error("MEXCOR_USERNAME / MEXCOR_PASSWORD missing on worker");
  }

  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const lastPreflightStep = await loginAndPickAccount(page, username, password, runId);

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
    startStepIndex: lastPreflightStep,
  });
}
