import { useEffect, useState } from 'react';
import { AccountantLayout } from '@/components/accountant/AccountantLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Bot, Play, RefreshCw, ExternalLink, CheckCircle2, XCircle, Loader2, Clock, Save, AlertTriangle, FileSpreadsheet, HelpCircle } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

type Distributor = {
  id: string;
  name: string;
  state_code: string;
  agent_enabled: boolean;
  report_portal_url: string | null;
  agent_schedule_enabled: boolean;
  agent_schedule_cron: string | null;
  agent_schedule_tz: string | null;
};

type Run = {
  id: string;
  distributor_id: string;
  status: string;
  goal: string | null;
  result: any;
  file_url: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  attempt?: number | null;
  resumable?: boolean | null;
  parent_run_id?: string | null;
  checkpoint?: any;
  browser_live_url?: string | null;
  screenshot_url?: string | null;
  progress?: { phase?: string; message?: string; [k: string]: any } | null;
  queued_at?: string | null;
};

type Step = {
  id: string;
  step_index: number;
  kind: string;
  tool_name: string | null;
  tool_args: any;
  output: any;
  reasoning: string | null;
  duration_ms: number | null;
};

const isSuccessfulRun = (run?: Run | null) => {
  if (!run || run.status !== 'success') return false;
  const resultStatus = typeof run.result === 'object' ? run.result?.status : null;
  return !!run.file_url && resultStatus !== 'error' && !!run.checkpoint?.ingested;
};

const getDisplayStatus = (run: Run) => {
  if (run.status === 'success' && !isSuccessfulRun(run)) return 'error';
  return run.status;
};

const StatusIcon = ({ s }: { s: string }) => {
  if (s === 'success') return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  if (s === 'error') return <XCircle className="h-4 w-4 text-destructive" />;
  return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
};

const AccountantAgents = () => {
  const [distributors, setDistributors] = useState<Distributor[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [liveKey, setLiveKey] = useState(0);

  // Refresh the live screenshot busting cache every 3s while a run is active.
  useEffect(() => {
    const t = setInterval(() => setLiveKey((k) => k + 1), 3000);
    return () => clearInterval(t);
  }, []);

  const load = async () => {
    setLoading(true);
    const [d, r] = await Promise.all([
      supabase.from('distributors').select('id,name,state_code,agent_enabled,report_portal_url,agent_schedule_enabled,agent_schedule_cron,agent_schedule_tz').order('name'),
      supabase.from('distributor_agent_runs').select('*').order('started_at', { ascending: false }).limit(40),
    ]);
    setDistributors((d.data as any) || []);
    setRuns((r.data as any) || []);
    if (!activeRunId && r.data?.length) setActiveRunId((r.data as any)[0].id);
    setLoading(false);
  };

  const loadSteps = async (runId: string) => {
    const { data } = await supabase
      .from('distributor_agent_steps')
      .select('*')
      .eq('run_id', runId)
      .order('step_index');
    setSteps((data as any) || []);
  };

  // Pending agent questions (ask_human)
  const [questions, setQuestions] = useState<any[]>([]);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [savingAnswer, setSavingAnswer] = useState<string | null>(null);

  const loadQuestions = async () => {
    const { data } = await supabase
      .from('distributor_agent_learnings')
      .select('id, distributor_id, run_id, question, context, situation_keywords, answer, created_at, answered_at, distributors:distributor_id(name)')
      .order('created_at', { ascending: false })
      .limit(50);
    setQuestions((data as any) || []);
  };

  const submitAnswer = async (q: any) => {
    const answer = (answerDrafts[q.id] || '').trim();
    if (!answer) { toast.error('Type an answer first'); return; }
    setSavingAnswer(q.id);
    try {
      const { data: u } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('distributor_agent_learnings')
        .update({ answer, answered_at: new Date().toISOString(), answered_by: u.user?.id })
        .eq('id', q.id);
      if (error) throw error;
      toast.success('Saved — agent will use this next run');
      setAnswerDrafts((d) => { const n = { ...d }; delete n[q.id]; return n; });
      // If the run is paused, re-trigger it so it can use the new learning
      if (q.run_id) {
        await supabase.functions.invoke('run-distributor-agent', {
          body: { distributor_id: q.distributor_id },
        });
        toast.success('Restarted agent run with your answer');
      }
      await loadQuestions();
      await load();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to save answer');
    } finally {
      setSavingAnswer(null);
    }
  };

  useEffect(() => { load(); loadQuestions(); }, []);
  useEffect(() => { if (activeRunId) loadSteps(activeRunId); }, [activeRunId]);

  // Live tail for active run (realtime + polling fallback so the live URL appears reliably)
  useEffect(() => {
    if (!activeRunId) return;
    const channel = supabase
      .channel(`agent-run-${activeRunId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'distributor_agent_steps', filter: `run_id=eq.${activeRunId}` },
        () => loadSteps(activeRunId))
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'distributor_agent_runs', filter: `id=eq.${activeRunId}` },
        () => load())
      .subscribe();

    const poll = setInterval(async () => {
      const { data } = await supabase
        .from('distributor_agent_runs')
        .select('*')
        .eq('id', activeRunId)
        .maybeSingle();
      if (data) {
        setRuns((prev) => {
          const idx = prev.findIndex((p) => p.id === activeRunId);
          if (idx === -1) return [data as any, ...prev];
          const next = [...prev];
          next[idx] = data as any;
          return next;
        });
        if ((data as any).status !== 'running') loadSteps(activeRunId);
        else loadSteps(activeRunId);
      }
    }, 3000);

    return () => { supabase.removeChannel(channel); clearInterval(poll); };
  }, [activeRunId]);

  const toggleAgent = async (id: string, value: boolean) => {
    const { error } = await supabase.from('distributors').update({ agent_enabled: value }).eq('id', id);
    if (error) toast.error(error.message); else { toast.success(value ? 'Agent enabled' : 'Agent disabled'); load(); }
  };

  // Schedule editor state per distributor
  const [scheduleEdits, setScheduleEdits] = useState<Record<string, { hour: string; minute: string; tz: string; cron: string; mode: 'daily' | 'cron' }>>({});
  const [savingSchedule, setSavingSchedule] = useState<string | null>(null);

  const getEdit = (d: Distributor) => {
    if (scheduleEdits[d.id]) return scheduleEdits[d.id];
    // Parse existing cron "M H * * *" if present, else default 6:00 ET
    const parts = (d.agent_schedule_cron || '0 6 * * *').split(' ');
    const isDaily = parts.length === 5 && parts[2] === '*' && parts[3] === '*' && parts[4] === '*' && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]);
    return {
      hour: isDaily ? parts[1] : '6',
      minute: isDaily ? parts[0] : '0',
      tz: d.agent_schedule_tz || 'America/New_York',
      cron: d.agent_schedule_cron || '0 6 * * *',
      mode: (isDaily ? 'daily' : 'cron') as 'daily' | 'cron',
    };
  };

  const updateEdit = (id: string, patch: Partial<ReturnType<typeof getEdit>>) => {
    setScheduleEdits((prev) => ({ ...prev, [id]: { ...getEdit(distributors.find((x) => x.id === id)!), ...prev[id], ...patch } }));
  };

  const saveSchedule = async (d: Distributor) => {
    const edit = getEdit(d);
    const cron = edit.mode === 'daily' ? `${parseInt(edit.minute || '0', 10)} ${parseInt(edit.hour || '6', 10)} * * *` : edit.cron.trim();
    if (!/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(cron)) {
      toast.error('Invalid cron expression (need 5 fields)');
      return;
    }
    setSavingSchedule(d.id);
    try {
      // Persist tz separately
      await supabase.from('distributors').update({ agent_schedule_tz: edit.tz }).eq('id', d.id);
      const { error } = await supabase.rpc('schedule_distributor_agent', { _distributor_id: d.id, _cron: cron });
      if (error) throw error;
      toast.success(`Scheduled (${cron} UTC)`);
      load();
    } catch (e: any) {
      toast.error(e.message || 'Failed to schedule');
    } finally {
      setSavingSchedule(null);
    }
  };

  const disableSchedule = async (d: Distributor) => {
    setSavingSchedule(d.id);
    try {
      const { error } = await supabase.rpc('unschedule_distributor_agent', { _distributor_id: d.id });
      if (error) throw error;
      toast.success('Schedule disabled');
      load();
    } catch (e: any) {
      toast.error(e.message || 'Failed to disable');
    } finally {
      setSavingSchedule(null);
    }
  };

  const runAgent = async (distributorId: string) => {
    setRunning(distributorId);
    try {
      const { data, error } = await supabase.functions.invoke('run-distributor-agent', {
        body: { distributor_id: distributorId },
      });
      if (error) throw error;
      toast.success('Agent started — watching live');
      if (data?.run_id) setActiveRunId(data.run_id);
      load();
    } catch (e: any) {
      toast.error(`Failed to start: ${e.message || e}`);
      load();
    } finally {
      setRunning(null); // unblock button — run continues in background
    }
  };

  const resumeRun = async (run: Run) => {
    setRunning(run.distributor_id);
    try {
      const { data, error } = await supabase.functions.invoke('run-distributor-agent', {
        body: { distributor_id: run.distributor_id, resume_run_id: run.id, auto_resume: true },
      });
      if (error) throw error;
      toast.success('Resume started');
      if (data?.run_id) setActiveRunId(data.run_id);
      load();
    } catch (e: any) {
      toast.error(`Resume failed: ${e.message || e}`);
      load();
    } finally {
      setRunning(null);
    }
  };

  const activeRun = runs.find((r) => r.id === activeRunId);
  const activeRunStatus = activeRun ? getDisplayStatus(activeRun) : null;
  const reportMissing = !!activeRun && activeRun.status === 'success' && !isSuccessfulRun(activeRun);

  return (
    <AccountantLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Bot className="h-6 w-6 text-primary" />
              AI Agents
            </h1>
            <p className="text-sm text-muted-foreground">
              Autonomous agents that log into distributor portals and ingest reports.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {questions.filter((q) => !q.answer).length > 0 && (
          <Card className="border-amber-500/40 bg-amber-50/40 dark:bg-amber-950/10">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <HelpCircle className="h-4 w-4 text-amber-600" />
                Agent needs your help ({questions.filter((q) => !q.answer).length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {questions.filter((q) => !q.answer).map((q) => (
                <div key={q.id} className="border rounded-lg p-3 bg-background space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-sm font-medium">{(q.distributors as any)?.name || 'Distributor'}</div>
                    <div className="text-xs text-muted-foreground">{new Date(q.created_at).toLocaleString()}</div>
                  </div>
                  <div className="text-sm">{q.question}</div>
                  {q.context && (
                    <div className="text-xs text-muted-foreground whitespace-pre-wrap bg-muted/50 rounded p-2">
                      {q.context}
                    </div>
                  )}
                  <Textarea
                    placeholder="Your answer (will be saved as a learning so the agent handles this automatically next time)…"
                    value={answerDrafts[q.id] || ''}
                    onChange={(e) => setAnswerDrafts((d) => ({ ...d, [q.id]: e.target.value }))}
                    rows={2}
                  />
                  <div className="flex justify-end">
                    <Button size="sm" onClick={() => submitAnswer(q)} disabled={savingAnswer === q.id}>
                      {savingAnswer === q.id ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-2" />}
                      Save & resume agent
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: distributors list */}
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle className="text-base">Distributors</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {distributors.map((d) => {
                const lastRun = runs.find((r) => r.distributor_id === d.id);
                return (
                  <div key={d.id} className="border rounded-lg p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-medium text-sm">{d.name}</div>
                        <div className="text-xs text-muted-foreground">{d.state_code}</div>
                      </div>
                      <Switch
                        checked={d.agent_enabled}
                        onCheckedChange={(v) => toggleAgent(d.id, v)}
                      />
                    </div>
                    {lastRun && (
                      <div className="flex items-center gap-2 text-xs">
                        <StatusIcon s={getDisplayStatus(lastRun)} />
                        <span className="text-muted-foreground">
                          {new Date(lastRun.started_at).toLocaleString()}
                        </span>
                      </div>
                    )}
                    <Button
                      size="sm"
                      className="w-full"
                      onClick={() => runAgent(d.id)}
                      disabled={!d.agent_enabled || running === d.id}
                    >
                      {running === d.id ? (
                        <><Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> Running…</>
                      ) : (
                        <><Play className="h-3.5 w-3.5 mr-2" /> Run agent</>
                      )}
                    </Button>

                    {/* Schedule */}
                    <div className="border-t pt-2 mt-1 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-xs font-medium">
                          <Clock className="h-3.5 w-3.5" />
                          Auto-run schedule
                        </div>
                        {d.agent_schedule_enabled && (
                          <Badge variant="secondary" className="text-[10px]">
                            {d.agent_schedule_cron} UTC
                          </Badge>
                        )}
                      </div>

                      {(() => {
                        const e = getEdit(d);
                        return (
                          <>
                            <div className="flex gap-1.5 text-xs">
                              <button
                                className={`flex-1 px-2 py-1 rounded border ${e.mode === 'daily' ? 'bg-primary/10 border-primary' : ''}`}
                                onClick={() => updateEdit(d.id, { mode: 'daily' })}
                              >Daily</button>
                              <button
                                className={`flex-1 px-2 py-1 rounded border ${e.mode === 'cron' ? 'bg-primary/10 border-primary' : ''}`}
                                onClick={() => updateEdit(d.id, { mode: 'cron' })}
                              >Custom cron</button>
                            </div>

                            {e.mode === 'daily' ? (
                              <div className="grid grid-cols-3 gap-1.5">
                                <div>
                                  <Label className="text-[10px] text-muted-foreground">Hour (UTC)</Label>
                                  <Input
                                    type="number" min={0} max={23}
                                    value={e.hour}
                                    onChange={(ev) => updateEdit(d.id, { hour: ev.target.value })}
                                    className="h-7 text-xs"
                                  />
                                </div>
                                <div>
                                  <Label className="text-[10px] text-muted-foreground">Minute</Label>
                                  <Input
                                    type="number" min={0} max={59}
                                    value={e.minute}
                                    onChange={(ev) => updateEdit(d.id, { minute: ev.target.value })}
                                    className="h-7 text-xs"
                                  />
                                </div>
                                <div>
                                  <Label className="text-[10px] text-muted-foreground">TZ note</Label>
                                  <Select value={e.tz} onValueChange={(v) => updateEdit(d.id, { tz: v })}>
                                    <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="America/New_York">ET</SelectItem>
                                      <SelectItem value="America/Chicago">CT</SelectItem>
                                      <SelectItem value="America/Denver">MT</SelectItem>
                                      <SelectItem value="America/Los_Angeles">PT</SelectItem>
                                      <SelectItem value="UTC">UTC</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                              </div>
                            ) : (
                              <Input
                                placeholder="0 6 * * *"
                                value={e.cron}
                                onChange={(ev) => updateEdit(d.id, { cron: ev.target.value })}
                                className="h-7 text-xs font-mono"
                              />
                            )}

                            <div className="flex gap-1.5">
                              <Button
                                size="sm" variant="default" className="flex-1 h-7 text-xs"
                                onClick={() => saveSchedule(d)}
                                disabled={savingSchedule === d.id}
                              >
                                {savingSchedule === d.id
                                  ? <Loader2 className="h-3 w-3 animate-spin" />
                                  : <><Save className="h-3 w-3 mr-1" />{d.agent_schedule_enabled ? 'Update' : 'Enable'}</>}
                              </Button>
                              {d.agent_schedule_enabled && (
                                <Button
                                  size="sm" variant="outline" className="h-7 text-xs"
                                  onClick={() => disableSchedule(d)}
                                  disabled={savingSchedule === d.id}
                                >Disable</Button>
                              )}
                            </div>
                            <p className="text-[10px] text-muted-foreground">
                              pg_cron uses UTC. {e.mode === 'daily' && `→ runs at ${e.hour.padStart(2,'0')}:${e.minute.padStart(2,'0')} UTC daily.`}
                            </p>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                );
              })}
              {!distributors.length && !loading && (
                <p className="text-sm text-muted-foreground">No distributors found.</p>
              )}
            </CardContent>
          </Card>

          {/* Right: run history + active run details */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base flex items-center justify-between">
                <span>Agent run</span>
                {activeRun && (
                  <Badge variant={activeRunStatus === 'success' ? 'default' : activeRunStatus === 'error' ? 'destructive' : 'secondary'}>
                    {reportMissing ? 'error · no report' : activeRunStatus}
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* run picker */}
              <div className="flex flex-wrap gap-2">
                {runs.slice(0, 8).map((r) => {
                  const d = distributors.find((x) => x.id === r.distributor_id);
                  return (
                    <button
                      key={r.id}
                      onClick={() => setActiveRunId(r.id)}
                      className={`text-xs px-2 py-1 rounded border flex items-center gap-1.5 ${
                        r.id === activeRunId ? 'bg-primary/10 border-primary' : 'hover:bg-muted/50'
                      }`}
                    >
                      <StatusIcon s={getDisplayStatus(r)} />
                      <span>{d?.name || 'Unknown'}</span>
                      <span className="text-muted-foreground">
                        {new Date(r.started_at).toLocaleTimeString()}
                      </span>
                    </button>
                  );
                })}
              </div>

              {activeRun && (
                <>
                  <Separator />
                  <div className="text-sm">
                    <div className="text-muted-foreground text-xs uppercase tracking-wider mb-1">Goal</div>
                    <div>{activeRun.goal}</div>
                  </div>

                  {(activeRun.screenshot_url || activeRun.progress?.phase || activeRun.browser_live_url) && (
                    <div className="text-sm space-y-1">
                      <div className="flex items-center justify-between">
                        <div className="text-muted-foreground text-xs uppercase tracking-wider">
                          Live activity {activeRun.progress?.phase ? `· ${activeRun.progress.phase}` : ''}
                        </div>
                        <div className="flex items-center gap-3">
                          {activeRun.status === 'running' && (
                            <button
                              onClick={() => setLiveKey((k) => k + 1)}
                              className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:text-foreground"
                              title="Refresh screenshot"
                            >
                              <RefreshCw className="h-3 w-3" /> Refresh
                            </button>
                          )}
                          {activeRun.browser_live_url && (
                            <a href={activeRun.browser_live_url} target="_blank" rel="noreferrer"
                              className="text-xs text-primary inline-flex items-center gap-1 hover:underline">
                              Browserbase <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                      </div>
                      {activeRun.progress?.message && (
                        <div className="text-xs text-muted-foreground">{activeRun.progress.message}</div>
                      )}
                      {activeRun.status === 'queued' && (
                        <div className="border rounded p-3 bg-muted/20 text-xs text-muted-foreground">
                          Queued — waiting for the agent worker to pick this run up. If this takes more than ~30 seconds, the worker may be offline.
                        </div>
                      )}
                      {activeRun.screenshot_url ? (
                        <div className="border rounded overflow-hidden bg-muted/20" style={{ aspectRatio: '16 / 10' }}>
                          <img
                            key={`${activeRun.screenshot_url}-${liveKey}`}
                            src={`${activeRun.screenshot_url}?t=${liveKey}`}
                            alt="Agent live screenshot"
                            className="w-full h-full object-contain bg-black"
                          />
                        </div>
                      ) : activeRun.status === 'running' ? (
                        <div className="border rounded p-3 bg-muted/20 text-xs text-muted-foreground">
                          Waiting for the first screenshot from the worker…
                        </div>
                      ) : null}
                    </div>
                  )}
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className={`rounded border p-3 text-sm ${activeRun.file_url ? 'bg-primary/5' : 'bg-muted/20'}`}>
                      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground mb-1">
                        <FileSpreadsheet className="h-3.5 w-3.5" /> Report file
                      </div>
                      {activeRun.file_url ? (
                        <a href={activeRun.file_url} target="_blank" rel="noreferrer"
                          className="text-primary inline-flex items-center gap-1 hover:underline">
                          Open downloaded report <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground text-xs">No report file was created for this run.</span>
                      )}
                    </div>
                    <div className={`rounded border p-3 text-sm ${activeRun.checkpoint?.ingested ? 'bg-primary/5' : 'bg-muted/20'}`}>
                      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground mb-1">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Ingestion
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {activeRun.checkpoint?.ingested ? `Completed${activeRun.checkpoint?.report_id ? ` · ${activeRun.checkpoint.report_id}` : ''}` : 'Not completed'}
                      </span>
                    </div>
                  </div>
                  {reportMissing && (
                    <div className="text-sm border rounded p-3 bg-destructive/10 text-destructive flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                      <div>
                        This older run was marked success by the model, but no report file/ingestion exists. It is being shown as failed so it cannot be mistaken for a completed import.
                      </div>
                    </div>
                  )}
                  {activeRun.result && (
                    <div className="text-sm">
                      <div className="text-muted-foreground text-xs uppercase tracking-wider mb-1">Summary</div>
                      <div className="bg-muted/40 rounded p-2 text-xs">
                        {typeof activeRun.result === 'string' ? activeRun.result : (activeRun.result as any).text}
                      </div>
                    </div>
                  )}
                  {activeRun.error && (
                    <div className="text-sm space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="text-muted-foreground text-xs uppercase tracking-wider">
                          Error {activeRun.attempt && activeRun.attempt > 1 ? `(attempt ${activeRun.attempt})` : ''}
                        </div>
                        {activeRun.resumable && (
                          <Button
                            size="sm" variant="outline"
                            onClick={() => resumeRun(activeRun)}
                            disabled={running === activeRun.distributor_id}
                          >
                            {running === activeRun.distributor_id ? (
                              <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Resuming…</>
                            ) : (
                              <><RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Resume from checkpoint</>
                            )}
                          </Button>
                        )}
                      </div>
                      <div className="bg-destructive/10 text-destructive rounded p-2 text-xs whitespace-pre-wrap">
                        {activeRun.error}
                      </div>
                      {activeRun.checkpoint && Object.keys(activeRun.checkpoint).length > 0 && (
                        <details className="bg-muted/20 rounded p-2 text-xs">
                          <summary className="cursor-pointer text-muted-foreground">
                            Saved checkpoint (will be reused on resume)
                          </summary>
                          <pre className="mt-1 overflow-auto">{JSON.stringify(activeRun.checkpoint, null, 2)}</pre>
                        </details>
                      )}
                    </div>
                  )}

                  {/* Currently-running indicator: shows latest activity so the
                      user always sees forward progress, even between tool calls. */}
                  {activeRun.status === 'running' && steps.length > 0 && (() => {
                    const latest = steps[steps.length - 1];
                    const phase = (latest.output as any)?.phase;
                    const message = (latest.output as any)?.message;
                    const url = (latest.output as any)?.url;
                    const label = latest.kind === 'browser'
                      ? `🌐 ${phase || 'browser'}${message ? ` — ${message}` : ''}`
                      : latest.kind === 'tool'
                        ? `🔧 ${latest.tool_name}`
                        : latest.kind === 'retry'
                          ? `🔁 retry ${latest.tool_name}`
                          : '🧠 thinking';
                    return (
                      <div className="text-sm border rounded p-2 bg-primary/5 flex items-start gap-2">
                        <Loader2 className="h-4 w-4 animate-spin text-primary mt-0.5 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium truncate">{label}</div>
                          {url && <div className="text-[10px] text-muted-foreground truncate">{url}</div>}
                        </div>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          step #{latest.step_index}
                        </span>
                      </div>
                    );
                  })()}

                  {(() => {
                    const shots = steps
                      .map((s) => ({ idx: s.step_index, url: (s.output as any)?.screenshot_url as string | undefined, phase: (s.output as any)?.phase as string | undefined, tool: s.tool_name as string | undefined }))
                      .filter((s) => !!s.url);
                    if (!shots.length) return null;
                    return (
                      <div>
                        <div className="text-muted-foreground text-xs uppercase tracking-wider mb-2">
                          Screenshots ({shots.length})
                        </div>
                        <div className="border rounded p-2 overflow-x-auto">
                          <div className="flex gap-2">
                            {shots.map((s) => (
                              <a
                                key={`${s.idx}-${s.url}`}
                                href={s.url}
                                target="_blank"
                                rel="noreferrer"
                                title={`#${s.idx} ${s.phase || s.tool || ''}`}
                                className="shrink-0 group"
                              >
                                <div className="w-32 aspect-[16/10] bg-black rounded overflow-hidden border">
                                  <img src={s.url} alt={`step ${s.idx}`} className="w-full h-full object-cover" loading="lazy" />
                                </div>
                                <div className="text-[10px] text-muted-foreground mt-1 truncate w-32">
                                  #{s.idx} {s.phase || s.tool || ''}
                                </div>
                              </a>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  <div>
                    <div className="text-muted-foreground text-xs uppercase tracking-wider mb-2">
                      Steps ({steps.length})
                    </div>
                    <ScrollArea className="h-[360px] border rounded">
                      <div className="p-3 space-y-3">
                        {steps.map((s) => {
                          const phase = (s.output as any)?.phase;
                          const message = (s.output as any)?.message;
                          const stepUrl = (s.output as any)?.url;
                          const errorMsg = (s.output as any)?.error;
                          const screenshotUrl = (s.output as any)?.screenshot_url;
                          const icon = s.kind === 'tool' ? `🔧 ${s.tool_name}`
                            : s.kind === 'browser' ? `🌐 ${phase || 'browser'}`
                            : s.kind === 'retry' ? `🔁 retry ${s.tool_name}`
                            : '🧠 reasoning';
                          return (
                          <div key={s.id} className="text-xs space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge variant="outline" className="font-mono">#{s.step_index}</Badge>
                              <span className="font-medium">{icon}</span>
                              {message && <span className="text-muted-foreground">{message}</span>}
                              {errorMsg && <span className="text-destructive">{errorMsg}</span>}
                              {s.duration_ms != null && (
                                <span className="text-muted-foreground">{s.duration_ms}ms</span>
                              )}
                              {screenshotUrl && (
                                <a href={screenshotUrl} target="_blank" rel="noreferrer"
                                  className="text-primary inline-flex items-center gap-0.5 hover:underline">
                                  view <ExternalLink className="h-3 w-3" />
                                </a>
                              )}
                            </div>
                            {stepUrl && (
                              <div className="text-[10px] text-muted-foreground font-mono truncate">{stepUrl}</div>
                            )}
                            {s.reasoning && (
                              <div className="bg-muted/40 rounded p-2 whitespace-pre-wrap">{s.reasoning}</div>
                            )}
                            {s.tool_args && Object.keys(s.tool_args).length > 0 && (
                              <details className="bg-muted/20 rounded p-2">
                                <summary className="cursor-pointer text-muted-foreground">args</summary>
                                <pre className="mt-1 overflow-auto">{JSON.stringify(s.tool_args, null, 2)}</pre>
                              </details>
                            )}
                            {s.output && (
                              <details className="bg-muted/20 rounded p-2">
                                <summary className="cursor-pointer text-muted-foreground">output</summary>
                                <pre className="mt-1 overflow-auto">{JSON.stringify(s.output, null, 2)}</pre>
                              </details>
                            )}
                          </div>
                          );
                        })}
                        {!steps.length && (
                          <div className="text-muted-foreground text-sm">No steps yet.</div>
                        )}
                      </div>
                    </ScrollArea>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AccountantLayout>
  );
};

export default AccountantAgents;
