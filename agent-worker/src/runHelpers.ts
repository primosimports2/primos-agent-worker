import { supabase, SUPABASE_URL } from "./supabase.js";
import type { Page } from "playwright";

export type RunCtx = {
  runId: string;
  distributorId: string;
  workerId: string;
};

export class AskHumanError extends Error {
  question: string;
  context: Record<string, unknown>;
  keywords: string[];
  constructor(question: string, ctx: Record<string, unknown> = {}, keywords: string[] = []) {
    super(`ask_human: ${question}`);
    this.question = question;
    this.context = ctx;
    this.keywords = keywords;
  }
}

export async function setProgress(runId: string, phase: string, message?: string) {
  await supabase
    .from("distributor_agent_runs")
    .update({ progress: { phase, message: message ?? phase, ts: new Date().toISOString() } })
    .eq("id", runId);
}

export async function setBrowserLiveUrl(runId: string, url: string | null) {
  if (!url) return;
  await supabase.from("distributor_agent_runs").update({ browser_live_url: url }).eq("id", runId);
}

export async function uploadScreenshot(runId: string, page: Page) {
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false });
    const path = `${runId}/live.jpg`;
    const { error } = await supabase.storage.from("agent-runs").upload(path, buf, {
      contentType: "image/jpeg",
      upsert: true,
      cacheControl: "1",
    });
    if (error) {
      console.warn("screenshot upload error", error.message);
      return;
    }
    const pub = supabase.storage.from("agent-runs").getPublicUrl(path);
    await supabase
      .from("distributor_agent_runs")
      .update({ screenshot_url: pub.data.publicUrl })
      .eq("id", runId);
  } catch (e) {
    // page may have closed mid-shot; ignore
  }
}

export function startScreenshotLoop(runId: string, page: Page) {
  const interval = Number(process.env.SCREENSHOT_INTERVAL_MS || 2500);
  const t = setInterval(() => { void uploadScreenshot(runId, page); }, interval);
  return () => clearInterval(t);
}

export async function logStep(
  runId: string,
  stepIndex: number,
  kind: string,
  fields: Record<string, unknown> = {},
) {
  await supabase.from("distributor_agent_steps").insert({
    run_id: runId,
    step_index: stepIndex,
    kind,
    ...fields,
  });
}

export async function uploadReportFile(
  runId: string,
  distributorId: string,
  filePath: string,
  filename: string,
): Promise<string> {
  const fs = await import("node:fs/promises");
  const buf = await fs.readFile(filePath);
  const path = `${runId}/${filename}`;
  const { error } = await supabase.storage.from("agent-runs").upload(path, buf, {
    contentType:
      filename.endsWith(".xlsx")
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "application/octet-stream",
    upsert: true,
  });
  if (error) throw new Error(`Failed to upload report: ${error.message}`);
  const pub = supabase.storage.from("agent-runs").getPublicUrl(path);
  return pub.data.publicUrl;
}

export async function fetchLearnings(distributorId: string) {
  const { data } = await supabase
    .from("distributor_agent_learnings")
    .select("question,answer,situation_keywords")
    .eq("distributor_id", distributorId)
    .not("answer", "is", null)
    .order("created_at", { ascending: false })
    .limit(20);
  return data ?? [];
}

export async function pauseForHuman(runId: string, distributorId: string, err: AskHumanError) {
  await supabase.from("distributor_agent_learnings").insert({
    distributor_id: distributorId,
    run_id: runId,
    question: err.question,
    context: err.context,
    situation_keywords: err.keywords,
  });
  await supabase
    .from("distributor_agent_runs")
    .update({
      status: "awaiting_human",
      progress: { phase: "awaiting_human", message: err.question },
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId);
}

export async function callIngest(fileUrl: string, distributorId: string): Promise<{ ok: boolean; report_id?: string; error?: string }> {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/parse-distributor-report`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ file_url: fileUrl, distributor_id: distributorId }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: (j as any)?.error || `HTTP ${r.status}` };
  return { ok: true, report_id: (j as any)?.report_id };
}
