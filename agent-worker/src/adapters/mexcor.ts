import type { BrowserContext, Locator, Page } from "playwright";
import { runLlmAgent } from "../agent/llmAgent.js";
import { logStep, setProgress, uploadScreenshot, uploadStepScreenshot } from "../runHelpers.js";

// Bump this whenever this adapter's login logic changes. It is written into
// every preflight step so we can prove from the DB which build of the worker
// actually ran. If a failed run does NOT show this version, the Railway
// container is still on an older deploy — redeploy before debugging further.
export const MEXCOR_ADAPTER_VERSION = "2026-05-19.v9-mandatory-supplier-confirm";

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

  // Encompass's canonical submit path is the HiddenSubmitButton shim wired to
  // Enter in the password field. Click selectors based on text (Login/Log in)
  // tend to match unrelated elements on this page, so we press Enter first
  // and only fall back to a STRICT form-scoped submit button.
  const confirmBtnEarly = page.locator(
    'button:has-text("Confirm"), input[type="submit"][value*="Confirm" i]',
  ).first();
  const passwordHidden = () =>
    page.locator('input[type="password"]').first().waitFor({ state: "hidden", timeout: 15_000 });
  const accountFieldEarly = page
    .locator('input[value*="Vendors" i], input[value*="Suppliers" i], input[readonly], .k-input')
    .first();
  const pickerVisible = () =>
    Promise.race([
      confirmBtnEarly.waitFor({ state: "visible", timeout: 15_000 }),
      accountFieldEarly.waitFor({ state: "visible", timeout: 15_000 }),
    ]);
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

  // Count strict form-scoped submit candidates BEFORE we try anything, so the
  // log can prove what was actually on the page.
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

  // Post-submit diagnostics — used both for logging and for the soft-fallback
  // decision below. We DO NOT print the username/password anywhere.
  const passVisibleNow = await page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
  const pickerVisibleNow = await confirmBtnEarly.isVisible().catch(() => false);
  const validationText = await page
    .locator(
      'text=/invalid|incorrect|locked|disabled|too many|wrong|failed|error/i',
    )
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


  // --- Account picker (Vendors -> Suppliers) ---
  // After login, Encompass8 shows the CURRENTLY selected account in a Kendo
  // combobox, e.g. "maxstrygler@ (Vendors (AP Contact))". There is NO visible
  // dropdown list until we click that field. We poll the whole page for any
  // element whose value/text matches "@... Vendors" and click it.
  const VENDORS_RE = /@.*vendors|vendors\s*\(/i;

  const findVendorsField = async (): Promise<Locator | null> => {
    const selects = page.locator('select:visible');
    const selectCount = await selects.count().catch(() => 0);
    for (let i = 0; i < selectCount; i++) {
      const el = selects.nth(i);
      const selectedText = await el.evaluate((node: HTMLSelectElement) => {
        const selected = node.selectedOptions?.[0];
        return selected?.textContent || node.textContent || "";
      }).catch(() => "");
      if (VENDORS_RE.test(selectedText) || /vendors/i.test(selectedText)) return el;
    }

    const inputs = page.locator('input:visible');
    const inputCount = await inputs.count().catch(() => 0);
    for (let i = 0; i < inputCount; i++) {
      const el = inputs.nth(i);
      const v = await el.inputValue().catch(() => "");
      if (v && (VENDORS_RE.test(v) || /vendors/i.test(v))) return el;
    }
    const textCandidates = page.locator(
      'span:visible, div:visible, .k-input:visible, .k-input-inner:visible, [role="combobox"]:visible',
    );
    const tCount = await textCandidates.count().catch(() => 0);
    for (let i = 0; i < Math.min(tCount, 400); i++) {
      const el = textCandidates.nth(i);
      const t = (await el.innerText().catch(() => "")) || "";
      if (VENDORS_RE.test(t) || /\bVendors\b/.test(t)) return el;
    }
    return null;
  };

  let vendorsField: Locator | null = null;
  const pollStart = Date.now();
  while (Date.now() - pollStart < 20_000) {
    vendorsField = await findVendorsField();
    if (vendorsField) break;
    await page.waitForTimeout(500);
  }

  if (!vendorsField) {
    await snap(
      "account_picker_not_found",
      "No element containing '@... Vendors' was visible — attempting blind fallback click on any Kendo combobox",
    );
    const blindTriggers = [
      '.k-dropdown-wrap',
      '.k-dropdownlist',
      '[aria-haspopup="listbox"]',
      '[role="combobox"]',
      '.k-input-inner',
    ];
    for (const sel of blindTriggers) {
      const t = page.locator(sel).first();
      if (await t.isVisible().catch(() => false)) {
        await t.click({ timeout: 3_000 }).catch(() => {});
        break;
      }
    }
  } else {
    await snap("account_picker_detected", "Found Vendors field — clicking it to open dropdown");
    const clickTargets: Locator[] = [
      vendorsField,
      vendorsField.locator(
        'xpath=ancestor::*[contains(@class,"k-dropdown") or contains(@class,"k-picker") or contains(@class,"k-dropdownlist") or @role="combobox" or @aria-haspopup="listbox"][1]',
      ),
      vendorsField.locator('xpath=ancestor::*[contains(@class,"k-widget") or contains(@class,"k-input")][1]'),
      vendorsField.locator('xpath=following-sibling::*[1]'),
    ];
    let opened = false;
    for (const t of clickTargets) {
      if (await t.isVisible().catch(() => false)) {
        try {
          await t.click({ timeout: 3_000 });
          opened = true;
          break;
        } catch {
          /* try next */
        }
      }
    }
    if (!opened) {
      await vendorsField.click({ force: true, timeout: 3_000 }).catch(() => {});
    }
  }

  await page.waitForTimeout(700);
  await snap("picker_opened", `Looking for ${ACCOUNT_LABEL} option in opened dropdown`);

  const selectSupplierFromNativeSelect = async (): Promise<boolean> => {
    const selects = page.locator('select:visible');
    const count = await selects.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const select = selects.nth(i);
      const optionData = await select.evaluate((node: HTMLSelectElement, label) => {
        const options = Array.from(node.options || []);
        const matchIndex = options.findIndex((option) =>
          (option.textContent || "").toLowerCase().includes(String(label).toLowerCase()),
        );
        if (matchIndex < 0) return null;
        return { index: matchIndex, value: options[matchIndex].value, text: options[matchIndex].textContent || "" };
      }, ACCOUNT_LABEL).catch(() => null);

      if (!optionData) continue;

      try {
        await select.selectOption({ index: optionData.index }, { timeout: 5_000 });
        await select.evaluate((node: HTMLSelectElement) => {
          node.dispatchEvent(new Event("input", { bubbles: true }));
          node.dispatchEvent(new Event("change", { bubbles: true }));
        }).catch(() => {});
        await snap("picker_selected_native_select", `Selected native option: ${optionData.text}`);
        return true;
      } catch {
        /* try next select */
      }
    }
    return false;
  };

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
    .filter({ hasText: new RegExp(`\\b${ACCOUNT_LABEL}\\b`, "i") })
    .first();

  let optionClicked = false;
  optionClicked = await selectSupplierFromNativeSelect();

  try {
    if (!optionClicked) {
      await supplierOption.waitFor({ state: "visible", timeout: 7_000 });
      await supplierOption.click({ timeout: 5_000 });
      optionClicked = true;
    }
  } catch {
    try {
      const supplierText = page.locator(`text=/\\b${ACCOUNT_LABEL}\\b/i`).first();
      await supplierText.click({ timeout: 5_000 });
      optionClicked = true;
    } catch {
      try {
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(500);
        optionClicked = true;
      } catch {
        /* fall through */
      }
    }
  }

  if (!optionClicked) {
    await snap("picker_option_missing", `Could not click ${ACCOUNT_LABEL} option after opening dropdown`);
    throw new Error(
      `Mexcor account picker: ${ACCOUNT_LABEL} option not found / not clickable in dropdown.`,
    );
  }

  await snap("picker_selected", `Selected ${ACCOUNT_LABEL} from dropdown`);

  const suppliersSelected = await page
    .locator('input:visible, span:visible, div:visible, [role="combobox"]:visible, .k-input:visible, .k-input-inner:visible')
    .filter({ hasText: new RegExp(ACCOUNT_LABEL, "i") })
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(async () => {
      const inputs = page.locator('input:visible');
      const count = await inputs.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const value = await inputs.nth(i).inputValue().catch(() => "");
        if (new RegExp(ACCOUNT_LABEL, "i").test(value)) return true;
      }
      return false;
    });

  if (!suppliersSelected) {
    await snap("picker_selection_unverified", `${ACCOUNT_LABEL} was clicked, but the account field did not visibly change`);
    throw new Error(`Mexcor account picker: clicked ${ACCOUNT_LABEL}, but could not verify it was selected.`);
  }

  const confirmSelectors = [
    'input[type="submit"][value*="Confirm" i]',
    'input[type="button"][value*="Confirm" i]',
    'button:has-text("Confirm")',
    '.k-button:has-text("Confirm")',
    '[role="button"]:has-text("Confirm")',
    'a:has-text("Confirm")',
  ].join(", ");

  const confirmButtons = page.locator(confirmSelectors);
  let confirmBtn: Locator | null = null;
  const confirmCount = await confirmButtons.count().catch(() => 0);
  for (let i = 0; i < confirmCount; i++) {
    const candidate = confirmButtons.nth(i);
    if (await candidate.isVisible().catch(() => false)) {
      confirmBtn = candidate;
      break;
    }
  }

  if (!confirmBtn) {
    await snap("confirm_button_missing", `${ACCOUNT_LABEL} selected, but Confirm button was not visible`);
    throw new Error("Mexcor account picker: Confirm button missing after selecting Suppliers account.");
  }

  try {
    await snap("confirming_account", `Clicking Confirm for ${ACCOUNT_LABEL} account`);
    await confirmBtn.click({ timeout: 10_000 });
    await page.waitForTimeout(750);
    if (await confirmBtn.isVisible().catch(() => false)) {
      await confirmBtn.evaluate((node: HTMLElement) => node.click()).catch(() => {});
    }
  } catch (err) {
    await snap("confirm_click_failed", `Failed to click Confirm: ${(err as Error).message}`);
    throw new Error("Mexcor account picker: failed to click Confirm button.");
  }
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

  const pickerStillOpen = await page
    .locator('.k-window:has-text("Logon"), text=/multiple accounts on this site/i')
    .first()
    .isVisible()
    .catch(() => false);

  if (pickerStillOpen || (await confirmBtn.isVisible().catch(() => false))) {
    await snap("confirm_not_completed", "Confirm was clicked, but the account picker is still visible");
    throw new Error("Mexcor account picker: Confirm did not complete; refusing to start the LLM before entering the portal.");
  }

  await snap("account_confirmed", `Confirmed ${ACCOUNT_LABEL} account`);

  // --- Sanity check: still on login? ---
  // Run AFTER the picker block so we don't false-positive while the dialog
  // is still open. Only fail if password field is still visible AND there is
  // no post-login UI signal.
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
      account_confirmed: true,
    });
    await snap(
      "continuing_after_account_confirm",
      "Account was confirmed; continuing even though the hidden/background password field is still detectable",
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
