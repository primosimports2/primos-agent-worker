import type { BrowserContext } from "playwright";
import { runLlmAgent } from "../agent/llmAgent.js";

const LOGIN_URL = "https://encompass8.com/User/Login";
const ACCOUNT_LABEL = process.env.MEXCOR_ACCOUNT_LABEL || "Suppliers";

export type MexcorResult = { filePath: string; filename: string };

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

  const goal = `Log into the Mexcor / Encompass8 supplier portal and download the latest sales report as XLSX.

Step-by-step expectations:
1. The login page has a username field and a password field. Fill them with the provided credentials and submit (Sign In / Log In button).
2. After login an "account picker" may appear with multiple options (e.g. "Suppliers", "Vendors"). You MUST pick "${ACCOUNT_LABEL}". Picking the wrong one bounces back to the login page in a loop.
3. Navigate to the latest sales report (look for menu items like "Sales", "Sales Comparison", "Reports", "Sales Report"). Open the most recent / current period report.
4. Find an export action (Export, Download, Excel, XLSX) and trigger it. The download will be captured automatically — when you've clicked the export, call download_complete.

Notes:
- The site is built on Encompass8. Menus may be nested — click parent menus to reveal children.
- If a date range is required, use the default / most recent.`;

  return runLlmAgent({
    context,
    runId,
    goal,
    startUrl: LOGIN_URL,
    credentials: {
      MEXCOR_USERNAME: username,
      MEXCOR_PASSWORD: password,
    },
    learnings,
    maxSteps: Number(process.env.AGENT_MAX_STEPS || 30),
  });
}
