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

   | Variable | Required | Notes |
   |---|---|---|
   | `SUPABASE_URL` | yes | `https://nspcypdvvplvyfsujzxk.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | yes | from Supabase project settings |
   | `OPENAI_API_KEY` | yes (default) | **Your own** OpenAI key (`sk-...`) — used by the browser agent |
   | `AGENT_MODEL` | optional | Defaults to `gpt-5.5` (or `gemini-2.5-pro` if provider=google) |
   | `AGENT_PROVIDER` | optional | `openai` (default) or `google` |
   | `GOOGLE_API_KEY` | only if `AGENT_PROVIDER=google` | **Your own** Gemini API key |
   | `AGENT_MAX_STEPS` | optional | Defaults to `30` |
   | `MEXCOR_USERNAME` | yes | your Mexcor username |
   | `MEXCOR_PASSWORD` | yes | your Mexcor password |
   | `MEXCOR_ACCOUNT_LABEL` | optional | `Suppliers` (this is the fix for the login loop) |
   | `USE_BROWSERBASE` | optional | `false` by default; set to `true` to fall back to Browserbase |
   | `BROWSERBASE_API_KEY` | optional | only if `USE_BROWSERBASE=true` |
   | `BROWSERBASE_PROJECT_ID` | optional | only if `USE_BROWSERBASE=true` |

   The worker does **not** use Lovable AI Gateway. All LLM traffic goes through your own OpenAI (or Gemini) account, billed directly to you.

## How the LLM browser agent works

Instead of brittle hardcoded selectors, each step the worker:
1. Takes a screenshot of the page.
2. Extracts every visible interactable element with a stable `ref` (e1, e2, ...).
3. Sends both to **your own OpenAI account** (default model `gpt-5.5`, override with `AGENT_MODEL`).
4. The model returns one tool call: `click(ref)`, `fill(ref, credentialKey)`, `press`, `navigate`, `scroll`, `wait`, `download_complete`, or `ask_human`.
5. Executes the action via Playwright, logs the reasoning + action into `distributor_agent_steps` (passwords redacted), and loops.

Credentials are passed via `credentialKey` so the model never echoes them.

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
