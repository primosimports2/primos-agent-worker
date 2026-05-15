import type { BrowserContext, Page, Download } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { generateText, stepCountIs, tool, type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";
import { supabase } from "../supabase.js";
import { AskHumanError, setProgress, uploadScreenshot } from "../runHelpers.js";

const PROVIDER = (process.env.AGENT_PROVIDER || "openai").toLowerCase();

function buildModel(): LanguageModel {
  if (PROVIDER === "google") {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("AGENT_PROVIDER=google but GOOGLE_API_KEY is missing on the worker");
    const google = createGoogleGenerativeAI({ apiKey });
    return google(process.env.AGENT_MODEL || "gemini-2.5-pro");
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing on the worker (set it in Railway → Variables)");
  const openai = createOpenAI({ apiKey });
  return openai(process.env.AGENT_MODEL || "gpt-5.5");
}

export type AgentResult = {
  filePath: string;
  filename: string;
};

export type AgentOptions = {
  context: BrowserContext;
  runId: string;
  goal: string;
  startUrl: string;
  credentials: Record<string, string>;
  learnings: { question: string; answer: string }[];
  maxSteps?: number;
};

type ElementSnapshot = {
  ref: string;
  tag: string;
  type?: string;
  name?: string;
  text: string;
  placeholder?: string;
  role?: string;
  visible: boolean;
};

const SECRET_VALUES = new Set<string>();

function redact(text: string): string {
  let out = text;
  for (const v of SECRET_VALUES) {
    if (v && v.length > 2) out = out.split(v).join("••••");
  }
  return out;
}

async function logStep(
  runId: string,
  stepIndex: number,
  kind: string,
  fields: Record<string, unknown> = {},
) {
  try {
    await supabase.from("distributor_agent_steps").insert({
      run_id: runId,
      step_index: stepIndex,
      kind,
      ...fields,
    });
  } catch (e) {
    console.warn("logStep error", (e as Error).message);
  }
}

async function snapshotElements(page: Page): Promise<ElementSnapshot[]> {
  return page.evaluate(() => {
    const out: any[] = [];
    const sel = 'input, textarea, select, button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [contenteditable="true"]';
    const nodes = Array.from(document.querySelectorAll(sel)).slice(0, 80);
    nodes.forEach((el, i) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const visible =
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.right > 0 &&
        r.top < (window.innerHeight || 800) &&
        r.left < (window.innerWidth || 1280);
      const ariaLabel = el.getAttribute("aria-label") || "";
      const text = ((el as HTMLElement).innerText || (el as HTMLInputElement).value || ariaLabel || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
      out.push({
        ref: `e${i + 1}`,
        tag: el.tagName.toLowerCase(),
        type: (el as HTMLInputElement).type || undefined,
        name: el.getAttribute("name") || undefined,
        placeholder: el.getAttribute("placeholder") || undefined,
        role: el.getAttribute("role") || undefined,
        text,
        visible,
      });
      (el as any).__agentRef = `e${i + 1}`;
    });
    // Tag DOM via data attribute so we can locate later
    nodes.forEach((el, i) => el.setAttribute("data-agent-ref", `e${i + 1}`));
    return out;
  });
}

function summarizeElements(els: ElementSnapshot[]): string {
  return els
    .filter((e) => e.visible)
    .map((e) => {
      const bits = [e.ref, `<${e.tag}${e.type ? ` type="${e.type}"` : ""}>`];
      if (e.name) bits.push(`name="${e.name}"`);
      if (e.placeholder) bits.push(`placeholder="${e.placeholder}"`);
      if (e.role) bits.push(`role="${e.role}"`);
      if (e.text) bits.push(`"${e.text}"`);
      return bits.join(" ");
    })
    .slice(0, 60)
    .join("\n");
}

async function locator(page: Page, ref: string) {
  return page.locator(`[data-agent-ref="${ref}"]`).first();
}

export async function runLlmAgent(opts: AgentOptions): Promise<AgentResult> {
  const model = buildModel();

  for (const v of Object.values(opts.credentials)) SECRET_VALUES.add(v);

  const page = await opts.context.newPage();
  page.setDefaultTimeout(30_000);

  // Race-free download capture
  let pendingDownload: Promise<Download> | null = null;
  const armDownload = () => {
    pendingDownload = page.waitForEvent("download", { timeout: 120_000 }).catch(() => null as any);
  };
  armDownload();

  await setProgress(opts.runId, "navigating", `Opening ${opts.startUrl}`);
  await page.goto(opts.startUrl, { waitUntil: "domcontentloaded" });

  let stepIndex = 0;
  let downloadedFile: { filePath: string; filename: string } | null = null;
  const actionHistory: string[] = [];

  const credList = Object.entries(opts.credentials)
    .map(([k, v]) => `- ${k}: ${v ? "(provided — use when a corresponding field appears)" : "(missing)"}`)
    .join("\n");

  const learningsBlock = opts.learnings.length
    ? "Prior learned hints:\n" + opts.learnings.map((l) => `- Q: ${l.question}\n  A: ${l.answer}`).join("\n")
    : "";

  const systemPrompt = `You are a browser-automation agent driving a real Chromium page via Playwright.

GOAL: ${opts.goal}

You will be shown, on each step:
- A screenshot of the current viewport.
- A numbered list of visible interactable elements (each has a stable "ref" like e1, e2).
- The current URL.
- The history of your previous actions.

Available credentials (ONLY use them through the fill tool — never echo them):
${credList}

${learningsBlock}

Rules:
- Take exactly ONE action per turn by calling exactly one tool.
- Prefer interacting via element ref (click/fill) over navigate().
- After clicking something that triggers navigation/loading, the next turn will show you the new state — don't try to predict it.
- When you successfully trigger a file download (XLSX/CSV/PDF), call download_complete with a short reason.
- If the page genuinely needs human input you can't infer (security challenge, unexpected MFA, ambiguous account picker), call ask_human.
- Do NOT call done unless the goal is impossible.`;

  const tools = {
    click: tool({
      description: "Click a visible element by its ref (e.g. e3).",
      inputSchema: z.object({ ref: z.string(), reason: z.string().optional() }),
      execute: async ({ ref, reason }) => {
        const loc = await locator(page, ref);
        await loc.click({ timeout: 10_000 });
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        // Re-arm download listener in case the click triggers one
        if (!pendingDownload) armDownload();
        return { ok: true, note: reason || `clicked ${ref}` };
      },
    }),
    fill: tool({
      description: "Fill a text/email/password input by ref. Use credentialKey to fill a stored credential without exposing it.",
      inputSchema: z.object({
        ref: z.string(),
        text: z.string().optional(),
        credentialKey: z.string().optional(),
      }),
      execute: async ({ ref, text, credentialKey }) => {
        const value = credentialKey ? opts.credentials[credentialKey] : text;
        if (!value) return { ok: false, error: `No value (credentialKey=${credentialKey || "none"})` };
        const loc = await locator(page, ref);
        await loc.fill(value, { timeout: 10_000 });
        return { ok: true, note: credentialKey ? `filled ${ref} from ${credentialKey}` : `filled ${ref}` };
      },
    }),
    press: tool({
      description: "Press a key (e.g. Enter, Tab, Escape) on the focused element or page.",
      inputSchema: z.object({ key: z.string() }),
      execute: async ({ key }) => {
        await page.keyboard.press(key);
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
        return { ok: true };
      },
    }),
    navigate: tool({
      description: "Navigate to an absolute URL.",
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) => {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return { ok: true };
      },
    }),
    wait: tool({
      description: "Wait N milliseconds (max 8000) — use sparingly when a page is mid-load.",
      inputSchema: z.object({ ms: z.number().min(100).max(8000) }),
      execute: async ({ ms }) => {
        await page.waitForTimeout(ms);
        return { ok: true };
      },
    }),
    scroll: tool({
      description: "Scroll the page to a vertical percentage (0-100).",
      inputSchema: z.object({ percent: z.number().min(0).max(100) }),
      execute: async ({ percent }) => {
        await page.evaluate((p: number) => {
          const h = document.documentElement.scrollHeight - window.innerHeight;
          window.scrollTo(0, (h * p) / 100);
        }, percent);
        return { ok: true };
      },
    }),
    download_complete: tool({
      description: "Call when you have triggered the file download you were after. Provide a short reason.",
      inputSchema: z.object({ reason: z.string() }),
      execute: async ({ reason }) => {
        if (!pendingDownload) return { ok: false, error: "No download was armed" };
        const dl = await pendingDownload;
        if (!dl) return { ok: false, error: "No download fired within timeout" };
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-"));
        const filename = (dl.suggestedFilename() || `report-${Date.now()}.xlsx`).replace(/\s+/g, "_");
        const filePath = path.join(tmpDir, filename);
        await dl.saveAs(filePath);
        downloadedFile = { filePath, filename };
        return { ok: true, note: `${reason} -> ${filename}` };
      },
    }),
    ask_human: tool({
  description: "...",
  inputSchema: z.object({ question: z.string(), keywords: z.array(z.string()).optional() }),
  execute: async ({ question, keywords }): Promise<{ ok: boolean }> => {
    throw new AskHumanError(question, { url: page.url() }, keywords ?? []);
      },
    }),
  };

  const maxSteps = opts.maxSteps ?? 25;

  for (let i = 0; i < maxSteps; i++) {
    if (downloadedFile) break;
    stepIndex++;

    // Snapshot
    const els = await snapshotElements(page);
    const elementsText = summarizeElements(els);
    const url = page.url();
    const screenshot = await page.screenshot({ type: "jpeg", quality: 60 });

    await uploadScreenshot(opts.runId, page);
    await setProgress(opts.runId, "thinking", `Step ${stepIndex}: deciding next action`);

    const userMessage = `Current URL: ${url}

Visible elements:
${elementsText || "(none detected)"}

Previous actions (most recent last):
${actionHistory.slice(-8).map((a, j) => `${j + 1}. ${a}`).join("\n") || "(none)"}

Decide the single best next action toward the goal.`;

    let toolCall: { name: string; args: any } | null = null;
    let assistantText = "";
    try {
      const result = await generateText({
        model,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: userMessage },
              { type: "image", image: screenshot },
            ],
          },
        ],
        tools,
        stopWhen: stepCountIs(2),
      });

      assistantText = result.text || "";
      const calls = (result as any).toolCalls || [];
      const exec = (result as any).toolResults || [];
      if (calls[0]) toolCall = { name: calls[0].toolName, args: calls[0].input ?? calls[0].args };

      // The AI SDK already executed the tool; capture result for history
      const execResult = exec[0]?.output ?? exec[0]?.result ?? null;

      const summary = toolCall
        ? `${toolCall.name}(${redact(JSON.stringify(toolCall.args || {}))})${
            execResult ? ` -> ${redact(JSON.stringify(execResult).slice(0, 200))}` : ""
          }`
        : "(no tool call)";
      actionHistory.push(summary);

      await logStep(opts.runId, stepIndex, "action", {
        tool_name: toolCall?.name ?? null,
        tool_args: toolCall ? JSON.parse(redact(JSON.stringify(toolCall.args || {}))) : null,
        output: execResult ? JSON.parse(redact(JSON.stringify(execResult))) : null,
        reasoning: redact(assistantText).slice(0, 2000),
      });
    } catch (err) {
      if (err instanceof AskHumanError) throw err;
      const msg = (err as Error)?.message || String(err);
      await logStep(opts.runId, stepIndex, "error", { reasoning: redact(msg).slice(0, 2000) });
      // If the model misbehaves, give it one more chance
      if (i >= maxSteps - 1) throw err;
      continue;
    }

    if (!toolCall) {
      // No tool chosen — nudge with a short wait then continue
      await page.waitForTimeout(500);
    }
  }

  if (!downloadedFile) {
    throw new Error(`Agent did not produce a download within ${maxSteps} steps`);
  }
  return downloadedFile;
}
