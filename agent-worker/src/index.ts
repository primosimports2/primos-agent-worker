import os from "node:os";
import { supabase } from "./supabase.js";
import { launchBrowser } from "./browser.js";
import {
  AskHumanError,
  callIngest,
  fetchLearnings,
  pauseForHuman,
  setBrowserLiveUrl,
  setProgress,
  startScreenshotLoop,
  uploadReportFile,
} from "./runHelpers.js";
import { runMexcor } from "./adapters/mexcor.js";

const WORKER_ID = process.env.WORKER_ID || `worker-${os.hostname()}-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);

type Run = {
  id: string;
  distributor_id: string;
  status: string;
  goal: string | null;
  checkpoint: Record<string, unknown> | null;
};

type Distributor = {
  id: string;
  name: string;
  agent_adapter?: string | null;
};

async function claimNextRun(): Promise<Run | null> {
  const { data, error } = await supabase.rpc("claim_next_distributor_agent_run", {
    _worker_id: WORKER_ID,
  });
  if (error) {
    console.error("claim error", error.message);
    return null;
  }
  const rows = (data as Run[]) ?? [];
  return rows[0] ?? null;
}

async function processRun(run: Run) {
  console.log(`[${run.id}] claimed`);
  await setProgress(run.id, "starting", "Worker picked up the run");

  const { data: dist, error } = await supabase
    .from("distributors")
    .select("id,name,agent_adapter")
    .eq("id", run.distributor_id)
    .maybeSingle();
  if (error || !dist) {
    await fail(run.id, `Distributor not found: ${error?.message ?? run.distributor_id}`);
    return;
  }
  const distributor = dist as Distributor;

  const adapterKey = (distributor.agent_adapter || distributor.name || "").toLowerCase();

  let stopScreenshots: (() => void) | null = null;
  let cleanupBrowser: (() => Promise<void>) | null = null;

  try {
    await setProgress(run.id, "launching_browser", "Starting Chromium");
    const launched = await launchBrowser();
    cleanupBrowser = launched.cleanup;
    if (launched.liveUrl) await setBrowserLiveUrl(run.id, launched.liveUrl);

    const learnings = await fetchLearnings(distributor.id);

    let result: { filePath: string; filename: string };

    // Open a placeholder page so the screenshot loop has something to render
    const tempPage = await launched.context.newPage();
    stopScreenshots = startScreenshotLoop(run.id, tempPage);
    await tempPage.goto("about:blank");

    if (adapterKey.includes("mexcor") || adapterKey.includes("encompass")) {
      // Screenshot the actual adapter page once it opens its own page
      result = await runMexcor(launched.context, run.id, learnings);
    } else {
      throw new Error(`No adapter implemented for distributor "${distributor.name}". Add one in agent-worker/src/adapters.`);
    }

    if (stopScreenshots) { stopScreenshots(); stopScreenshots = null; }

    await setProgress(run.id, "uploading_report", `Uploading ${result.filename}`);
    const fileUrl = await uploadReportFile(run.id, distributor.id, result.filePath, result.filename);
    await supabase.from("distributor_agent_runs").update({ file_url: fileUrl }).eq("id", run.id);

    await setProgress(run.id, "ingesting", "Parsing and ingesting the report");
    const ingest = await callIngest(fileUrl, distributor.id);
    if (!ingest.ok) throw new Error(`Ingestion failed: ${ingest.error}`);

    await supabase
      .from("distributor_agent_runs")
      .update({
        status: "success",
        finished_at: new Date().toISOString(),
        result: { status: "ok", report_id: ingest.report_id, file_url: fileUrl },
        checkpoint: { ...(run.checkpoint || {}), ingested: true, report_id: ingest.report_id },
        progress: { phase: "done", message: "Report downloaded and ingested" },
      })
      .eq("id", run.id);

    console.log(`[${run.id}] success`);
  } catch (err) {
    if (err instanceof AskHumanError) {
      console.log(`[${run.id}] awaiting human: ${err.question}`);
      await pauseForHuman(run.id, distributor.id, err);
    } else {
      const msg = (err as Error)?.message || String(err);
      console.error(`[${run.id}] error`, msg);
      await fail(run.id, msg);
    }
  } finally {
    if (stopScreenshots) stopScreenshots();
    if (cleanupBrowser) await cleanupBrowser();
  }
}

async function fail(runId: string, message: string) {
  await supabase
    .from("distributor_agent_runs")
    .update({
      status: "error",
      error: message,
      finished_at: new Date().toISOString(),
      progress: { phase: "error", message },
    })
    .eq("id", runId);
}

async function loop() {
  console.log(`[worker] ${WORKER_ID} starting (poll=${POLL_INTERVAL_MS}ms)`);
  // Simple heartbeat loop: claim and process one run at a time
  // to keep memory + Chromium usage small per container.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const run = await claimNextRun();
      if (run) {
        await processRun(run);
      } else {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    } catch (e) {
      console.error("[worker] loop error", e);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}

loop().catch((e) => {
  console.error("[worker] fatal", e);
  process.exit(1);
});
