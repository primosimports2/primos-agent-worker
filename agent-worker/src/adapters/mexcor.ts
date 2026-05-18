import type { BrowserContext, Page } from "playwright";
import { runLlmAgent } from "../agent/llmAgent.js";
import { logStep, setProgress, uploadScreenshot, uploadStepScreenshot } from "../runHelpers.js";

// Bump this whenever this adapter's login logic changes. It is written into
// every preflight step so we can prove from the DB which build of the worker
// actually ran. If a failed run does NOT show this version, the Railway
// container is still on an older deploy — redeploy before debugging further.
export const MEXCOR_ADAPTER_VERSION = "2026-05-18.v4-picker-required";

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
      output: {
        phase: label,
        message,
        url: page.url(),
        screenshot_url,
        adapter_version: MEXCOR_ADAPTER_VERSION,
        ...extra,
      },
    }).catch(() => {});
  };

  await setProgress(
    runId,
    "logging_in",
    `Opening Mexcor login page (adapter ${MEXCOR_ADAPTER_VERSION})`,
  );
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

  // Encompass's canonical submit path is the HiddenSubmitButton shim wired to
  // Enter in the password field. Press Enter first, then fall back to a STRICT
  // form-scoped submit button.
  const confirmBtnEarly = page.locator(
    'button:has-text("Confirm"), input[type="submit"][value*="Confirm" i]',
  ).first();
  const passwordHidden = () =>
    page.locator('input[type="password"]').first().waitFor({ state: "hidden", timeout: 15_000 });
  const pickerVisible = () =>
    confirmBtnEarly.waitFor({ state: "visible", timeout: 15_000 });
  const urlChanged = () =>
    page.waitForURL((u) => !u.toString().includes("DashboardID=100008"), { timeout: 15_000 });

  const waitForSubmitOutcome = async () => {
    await Promise.race([
      pickerVisible().catch(() => {}),
      passwordHidden().catch(() => {}),
      urlChanged().catch(() => {}),
    ]);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  };

  const strictSubmitSelector = [
    'form:has(input[type="password"]) button[type="submit"]',
    'form:has(input[type="password"]) input[type="submit"]:not(.HiddenSubmitButton):not([tabindex="10000"])',
  ].join(", ");
  const strictSubmitInitialCount = await page
    .locator(strictSubmitSelector)
    .count()
    .catch(() => -1);

  await passField.focus();
  await passField.press("Enter");
  let strategy = "pressed_enter";
  await waitForSubmitOutcome();

  const stillVisibleAfterEnter = await page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);

  let clickedReal = false;
  let strictMatched = 0;
  if (stillVisibleAfterEnter) {
    const strictSubmit = page.locator(strictSubmitSelector);
    strictMatched = await strictSubmit.count().catch(() => 0);
    for (let i = 0; i < strictMatched; i++) {
      const cand = strictSubmit.nth(i);
      if (await cand.isVisible().catch(() => false)) {
        try {
          await cand.click({ timeout: 5_000 });
          clickedReal = true;
          break;
        } catch {
          /* try next */
        }
      }
    }
    strategy = clickedReal ? "clicked_form_submit" : "none_found";
    if (clickedReal) await waitForSubmitOutcome();
  }

  const passVisibleNow = await page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
  const pickerVisibleNow = await confirmBtnEarly.isVisible().catch(() => false);
  const validationText = await page
    .locator('text=/invalid|incorrect|locked|disabled|too many|wrong|failed|error/i')
    .first()
    .innerText({ timeout: 1_000 })
    .catch(() => "");

  await snap("submitted_login", `strategy=${strategy}`, {
    strategy,
    strict_submit_initial_count: strictSubmitInitialCount,
    strict_submit_matched_after_enter: strictMatched,
    clicked_form_submit: clickedReal,
    password_visible_after_submit: passVisibleNow,
    picker_visible_after_submit: pickerVisibleNow,
    validation_text: validationText ? validationText.slice(0, 200) : null,
  });

  // --- Account picker (Vendors / Suppliers) ---
  // Encompass renders a Kendo dialog ("Logon") with a custom combobox showing
  // the currently selected account. We MUST click the combobox to open the
  // list, pick Suppliers, then click Confirm. Skipping this leaves the worker
  // authenticated as the wrong account.
  const confirmBtn = page.locator(
    [
      'input[type="submit"][value="Confirm" i]',
      'button:has-text("Confirm")',
      '.k-window:has-text("Logon") button:has-text("Confirm")',
    ].join(", "),
  ).first();

  const pickerDetector = page.locator(
    [
      'input[type="submit"][value="Confirm" i]',
      'button:has-text("Confirm")',
      '.k-window-title:has-text("Logon")',
      'text=/multiple accounts on this site/i',
    ].join(", "),
  ).first();

  const sawPicker = await pickerDetector
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  if (!sawPicker) {
    await snap("account_picker_skipped", "No account picker detected after login", {
      picker_present: false,
    });
  } else {
    await snap("account_picker_detected", `Account picker visible — selecting ${ACCOUNT_LABEL}`, {
      picker_present: true,
    });

    // Strategy 1: native <select>
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
        /* fall through */
      }
    }

    // Strategy 2: Kendo / custom combobox
    if (!selected) {
      const triggerCandidates = [
        '.k-window:has-text("Logon") .k-dropdown-wrap',
        '.k-window:has-text("Logon") .k-dropdownlist',
        '.k-window:has-text("Logon") [aria-haspopup="listbox"]',
        '.k-window:has-text("Logon") [role="combobox"]',
        '.k-window:has-text("Logon") input[readonly]',
        '.k-dropdown-wrap',
        '.k-dropdownlist',
        '[aria-haspopup="listbox"]',
        '[role="combobox"]',
        'input[readonly]',
        '.dropdown-toggle, [data-toggle="dropdown"]',
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
          "Mexcor account picker: no visible dropdown trigger found inside the Logon dialog.",
        );
      }

      await page.waitForTimeout(500);
      await snap("picker_opened", `Clicked picker trigger — looking for ${ACCOUNT_LABEL} option`);

      const optionSelectors = [
        '.k-list-item',
        '.k-item',
        'li[role="option"]',
        '[role="option"]',
        '.dropdown-item',
        'li',
        'option',
      ].join(", ");

      const supplierOption = page
        .locator(optionSelectors)
        .filter({ hasText: new RegExp(ACCOUNT_LABEL, "i") })
        .first();

      let optionClicked = false;
      try {
        await supplierOption.waitFor({ state: "visible", timeout: 5_000 });
        await supplierOption.click({ timeout: 5_000 });
        optionClicked = true;
      } catch {
        try {
          await page
            .locator(`:visible:has-text("${ACCOUNT_LABEL}")`)
            .filter({ hasNot: page.locator('button, [role="button"], input') })
            .first()
            .click({ timeout: 5_000 });
          optionClicked = true;
        } catch {
          /* fail below */
        }
      }

      if (!optionClicked) {
        await snap("picker_option_missing", `Could not click ${ACCOUNT_LABEL} option in dropdown`);
        throw new Error(
          `Mexcor account picker: ${ACCOUNT_LABEL} option not found / not clickable in dropdown.`,
        );
      }

      await snap("picker_selected", `Selected ${ACCOUNT_LABEL} from dropdown`);
    }

    // Click Confirm and wait for the dialog to close.
    try {
      await confirmBtn.waitFor({ state: "visible", timeout: 10_000 });
      await confirmBtn.click({ timeout: 10_000 });
    } catch (err) {
      await snap("confirm_click_failed", `Failed to click Confirm: ${(err as Error).message}`);
      throw new Error("Mexcor account picker: failed to click Confirm button.");
    }
    await confirmBtn.waitFor({ state: "hidden", timeout: 20_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await snap("account_confirmed", `Confirmed ${ACCOUNT_LABEL} account`);
  }

  // --- Sanity check: still on login? ---
  const passStillVisible = await page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
  const urlLooksLoggedIn = !page.url().includes("DashboardID=100008");
  const postLoginHint = await page
    .locator(
      '[role="navigation"], nav, aside, [class*="dashboard" i], text=/Sales|Order Management|Reports/i',
    )
    .first()
    .isVisible()
    .catch(() => false);

  if (passStillVisible && !urlLooksLoggedIn && !postLoginHint) {
    await snap("login_failed", "Password field still visible and no post-login UI detected", {
      url_looks_logged_in: urlLooksLoggedIn,
      post_login_hint: postLoginHint,
    });
    throw new Error(
      `Mexcor login appears to have failed (adapter ${MEXCOR_ADAPTER_VERSION}) — still on the login form after submit. Check MEXCOR_USERNAME/MEXCOR_PASSWORD and MEXCOR_ACCOUNT_LABEL, or whether the Encompass page layout changed.`,
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
