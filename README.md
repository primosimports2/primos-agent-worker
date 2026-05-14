# Primos Agent Worker

External Node + Playwright worker that runs the distributor portal automations
(Mexcor / Encompass8 today, more to come). It replaces the in-Edge-Function
Stagehand setup, which couldn't run reliably inside Supabase's Deno runtime.

## How it works

1. The Lovable app calls the `run-distributor-agent` Edge Function.
2. That function inserts a row into `distributor_agent_runs` with `status='queued'`
   and returns immediately.
3. **This worker** polls the DB via `claim_next_distributor_agent_run`, picks up
   the next queued run, launches Chromium (locally — no Browserbase needed),
   runs the distributor adapter, uploads the downloaded report to Supabase
   Storage (`agent-runs` bucket), and calls `parse-distributor-report` to ingest
   it.
4. Live progress is written to the run's `progress` jsonb + `screenshot_url`
   columns every ~2.5 seconds so the UI can show a live preview.

## Deploy on Railway (5 minutes)

1. Push this `agent-worker/` folder to its own GitHub repo (or use the same
   monorepo with a custom root directory).
2. In Railway → **New Project → Deploy from GitHub repo**, point it at this
   folder. Railway auto-detects the `Dockerfile`.
3. Add these environment variables (Settings → Variables):

   | Variable | Value |
   |---|---|
   | `SUPABASE_URL` | `https://nspcypdvvplvyfsujzxk.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | from Supabase project settings |
   | `MEXCOR_USERNAME` | your Mexcor username |
   | `MEXCOR_PASSWORD` | your Mexcor password |
   | `MEXCOR_ACCOUNT_LABEL` | `Suppliers` (this is the fix for the login loop) |
   | `USE_BROWSERBASE` | `false` (set to `true` to fall back to Browserbase) |
   | `BROWSERBASE_API_KEY` | optional, only if `USE_BROWSERBASE=true` |
   | `BROWSERBASE_PROJECT_ID` | optional, only if `USE_BROWSERBASE=true` |

4. Deploy. The container will boot, log
   `[worker] worker-... starting (poll=5000ms)`, and start picking up runs.

That's it — there is no port to expose, no public URL needed. The worker
talks to Supabase outbound only.

### Cost

Railway's smallest plan (~$5/month) is plenty for one worker handling a few
runs an hour. Scale to multiple replicas later if needed; the `claim_next_...`
RPC uses `FOR UPDATE SKIP LOCKED` so workers won't fight over runs.

## Local development

```bash
cd agent-worker
cp .env.example .env   # fill in values
npm install
npx playwright install chromium
npm run dev
```

Then trigger a run from the Accountant → Agents page in the app, or call
`run-distributor-agent` directly with `{ "distributor_id": "<uuid>" }`.

## Adding a new distributor adapter

1. Create `src/adapters/<name>.ts` exporting a function that takes
   `(context, runId, learnings)` and returns `{ filePath, filename }`.
2. Add a branch in `src/index.ts` based on the distributor's `name` or
   `agent_adapter` column.
3. Throw `AskHumanError` from inside the adapter when you hit something the
   agent doesn't know how to handle — the run will pause as `awaiting_human`,
   the UI will surface the question, and once an admin answers, the run is
   re-queued automatically and the answer is added to the learned playbook.

## Why not run this in a Supabase Edge Function?

Edge Functions run on Deno isolates that lack `Worker.prototype.constructor`
and can't proxy several DOM-ish objects Playwright/Stagehand require. They
also have a hard ~150s wall clock — too short for portal automations that
include logins, navigation, and large downloads. A long-running Node
container is the right tool.
