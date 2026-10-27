/**
 * Executes a MigrationPlan against the target Eventhouse.
 *
 * Phases: prepare (tables, retention, caching) → widen merge lookback → copy
 * daily buckets → restore merge policy → verify row counts per day.
 *
 * All progress lives in a plain RunState that the editor persists on the item
 * after every change, so a closed browser resumes where it left off: finished
 * buckets are skipped, in-flight ones are polled again, and every copy is
 * idempotent through its ingest-by tag anyway.
 */

import {
  BucketComparison,
  MigrationPlan,
  TablePlan,
  compareHistograms,
  histogramQuery,
  kqlName,
  mergeLookbackCommand,
  parseHistogram,
  restoreMergeCommand
} from "../engine";
import { KustoClient, describeError, getOperationStatus } from "./KustoClient";

export type CopyStatus = "pending" | "running" | "done" | "failed";

export interface CopyProgress {
  status: CopyStatus;
  operationId?: string;
  attempts: number;
  error?: string;
}

export type RunPhase = "idle" | "preparing" | "copying" | "restoring" | "verifying" | "done" | "failed" | "stopped";

export interface RunLogEntry {
  at: string;
  level: "info" | "error";
  message: string;
}

export interface TableVerification {
  table: string;
  mismatches: BucketComparison[];
  sourceRows: number;
  targetRows: number;
  /** Distinct creation days across the target's extents: evidence the extents were rebuilt. */
  extentCreationDays: number;
}

export interface RunState {
  phase: RunPhase;
  prepared: Record<string, boolean>;
  /** Target table → its merge policy before the run (null: none of its own). Captured once, ever. */
  originalMerge: Record<string, string | null>;
  mergeWidened: Record<string, boolean>;
  copies: Record<string, CopyProgress>;
  verification?: TableVerification[];
  log: RunLogEntry[];
  startedAt?: string;
  finishedAt?: string;
}

export function emptyRunState(): RunState {
  return { phase: "idle", prepared: {}, originalMerge: {}, mergeWidened: {}, copies: {}, log: [] };
}

export interface RunnerOptions {
  source: KustoClient;
  target: KustoClient;
  targetDatabase: string;
  /** Copies in flight at once; Microsoft advises against many concurrent ingestions. */
  concurrency?: number;
  maxAttempts?: number;
  pollIntervalMs?: number;
  onState: (state: RunState) => void;
}

const MAX_LOG = 200;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class MigrationRunner {
  private stopRequested = false;
  private state: RunState;

  constructor(private readonly plan: MigrationPlan, initial: RunState | undefined, private readonly options: RunnerOptions) {
    this.state = initial ? JSON.parse(JSON.stringify(initial)) : emptyRunState();
  }

  stop(): void {
    this.stopRequested = true;
  }

  private emit(patch: Partial<RunState> = {}): void {
    this.state = { ...this.state, ...patch };
    this.options.onState(JSON.parse(JSON.stringify(this.state)));
  }

  private log(level: RunLogEntry["level"], message: string): void {
    const log = [...this.state.log, { at: new Date().toISOString(), level, message }].slice(-MAX_LOG);
    this.emit({ log });
  }

  private mgmt(csl: string) {
    return this.options.target.mgmt(this.options.targetDatabase, csl);
  }

  async run(): Promise<RunState> {
    this.stopRequested = false;
    this.emit({ startedAt: this.state.startedAt || new Date().toISOString(), finishedAt: undefined });
    let failed = false;
    try {
      this.emit({ phase: "preparing" });
      await this.prepare();
      await this.widenMerge();

      this.emit({ phase: "copying" });
      failed = !(await this.copyAll());
    } catch (error) {
      failed = true;
      this.log("error", describeError(error));
    } finally {
      // Always put merge policies back, even after a failure or a stop.
      this.emit({ phase: "restoring" });
      await this.restoreMerge();
    }

    if (this.stopRequested) {
      this.emit({ phase: "stopped" });
      this.log("info", "Stopped. Run again to resume; finished days are skipped.");
      return this.state;
    }
    if (failed) {
      this.emit({ phase: "failed", finishedAt: new Date().toISOString() });
      return this.state;
    }

    this.emit({ phase: "verifying" });
    try {
      await this.verify();
      this.emit({ phase: "done", finishedAt: new Date().toISOString() });
      this.log("info", "Migration complete.");
    } catch (error) {
      this.log("error", `Verification failed: ${describeError(error)}`);
      this.emit({ phase: "failed", finishedAt: new Date().toISOString() });
    }
    return this.state;
  }

  private async prepare(): Promise<void> {
    for (const table of this.plan.tables) {
      for (const step of table.prepare) {
        if (this.stopRequested || this.state.prepared[step.id]) {
          continue;
        }
        await this.mgmt(step.command);
        this.emit({ prepared: { ...this.state.prepared, [step.id]: true } });
        this.log("info", `${step.table}: ${step.description}`);
      }
    }
  }

  private async widenMerge(): Promise<void> {
    for (const table of this.plan.tables) {
      const name = table.mapping.targetTable;
      if (this.stopRequested || !table.mergeLookbackDays || this.state.mergeWidened[name]) {
        continue;
      }
      // Capture the original only once: after an interrupted run the table may
      // still carry our widened policy, which must never become the "original".
      if (!(name in this.state.originalMerge)) {
        const rows = await this.mgmt(`.show table ${kqlName(name)} policy merge`);
        const policy = rows[0]?.Policy;
        this.emit({ originalMerge: { ...this.state.originalMerge, [name]: policy && policy !== "null" ? String(policy) : null } });
      }
      await this.mgmt(mergeLookbackCommand(name, table.mergeLookbackDays));
      this.emit({ mergeWidened: { ...this.state.mergeWidened, [name]: true } });
      this.log("info", `${name}: merge lookback widened to ${table.mergeLookbackDays} days for the backfill`);
    }
  }

  private async restoreMerge(): Promise<void> {
    for (const name of Object.keys(this.state.mergeWidened)) {
      if (!this.state.mergeWidened[name]) {
        continue;
      }
      try {
        await this.mgmt(restoreMergeCommand(name, this.state.originalMerge[name]));
        this.emit({ mergeWidened: { ...this.state.mergeWidened, [name]: false } });
        this.log("info", `${name}: merge policy restored`);
      } catch (error) {
        this.log("error", `${name}: could not restore the merge policy: ${describeError(error)}`);
      }
    }
  }

  private setCopy(id: string, patch: Partial<CopyProgress>): void {
    const current = this.state.copies[id] || { status: "pending", attempts: 0 };
    this.emit({ copies: { ...this.state.copies, [id]: { ...current, ...patch } } });
  }

  /** Runs every unfinished copy through a small worker pool. Returns false if any copy gave up. */
  private async copyAll(): Promise<boolean> {
    const maxAttempts = this.options.maxAttempts ?? 3;
    const queue = this.plan.tables.flatMap((table: TablePlan) => table.copies).filter(copy => {
      const progress = this.state.copies[copy.id];
      return !progress || progress.status !== "done";
    });

    const worker = async () => {
      while (queue.length > 0 && !this.stopRequested) {
        const copy = queue.shift();
        let progress = this.state.copies[copy.id] || { status: "pending", attempts: 0 };
        while (progress.status !== "done" && progress.attempts < maxAttempts && !this.stopRequested) {
          try {
            let operationId = progress.status === "running" ? progress.operationId : undefined;
            if (!operationId) {
              this.setCopy(copy.id, { status: "running", attempts: progress.attempts + 1, error: undefined });
              const rows = await this.mgmt(copy.command);
              operationId = String(rows[0]?.OperationId || "");
              this.setCopy(copy.id, { operationId });
            }
            const outcome = await this.waitFor(operationId);
            if (outcome.ok) {
              this.setCopy(copy.id, { status: "done" });
              this.log("info", `${copy.targetTable} ${copy.day || "(no timestamp)"}: ${copy.rows} rows`);
            } else {
              this.setCopy(copy.id, { status: "failed", operationId: undefined, error: outcome.message });
            }
          } catch (error) {
            this.setCopy(copy.id, { status: "failed", operationId: undefined, error: describeError(error) });
          }
          progress = this.state.copies[copy.id];
          if (progress.status === "failed" && progress.attempts < maxAttempts) {
            this.log("error", `${copy.targetTable} ${copy.day || "(no timestamp)"}: ${progress.error}. Retrying.`);
          }
        }
        if (progress.status === "failed") {
          this.log("error", `${copy.targetTable} ${copy.day || "(no timestamp)"}: gave up after ${progress.attempts} attempts: ${progress.error}`);
        }
      }
    };

    const workers = Array.from({ length: Math.max(1, this.options.concurrency ?? 3) }, () => worker());
    await Promise.all(workers);
    return Object.values(this.state.copies).every(c => c.status !== "failed");
  }

  private async waitFor(operationId: string): Promise<{ ok: boolean; message?: string }> {
    if (!operationId) {
      return { ok: false, message: "The command returned no operation id." };
    }
    const interval = this.options.pollIntervalMs ?? 5000;
    while (!this.stopRequested) {
      const status = await getOperationStatus(this.options.target, this.options.targetDatabase, operationId);
      if (status.state === "Completed") {
        return { ok: true };
      }
      if (status.state === "Failed") {
        return { ok: false, message: `${status.rawState}: ${status.message || "no details"}` };
      }
      await sleep(interval);
    }
    return { ok: false, message: "Stopped while waiting." };
  }

  private async verify(): Promise<void> {
    const results: TableVerification[] = [];
    for (const table of this.plan.tables) {
      const { sourceTable, targetTable, timestampColumn } = table.mapping;
      // Cumulative check: everything the source held up to this load's watermark
      // must now be in the target, whichever load copied it.
      const upTo = table.windowed && this.plan.window ? { to: this.plan.window.to } : undefined;
      const [sourceRows, targetRows, extents] = await Promise.all([
        this.options.source.query(this.plan.sourceDatabase, histogramQuery(sourceTable, timestampColumn as string, upTo)),
        this.options.target.query(this.options.targetDatabase, histogramQuery(targetTable, timestampColumn as string)),
        this.mgmt(`.show table ${kqlName(targetTable)} extents | summarize by bin(MaxCreatedOn, 1d) | count`)
      ]);
      const source = parseHistogram(sourceRows as any);
      const target = parseHistogram(targetRows as any);
      const sum = (h: typeof source) => h.days.reduce((s, d) => s + d.rows, h.nullRows);
      results.push({
        table: targetTable,
        mismatches: compareHistograms(source, target).filter(d => d.sourceRows !== d.targetRows),
        sourceRows: sum(source),
        targetRows: sum(target),
        extentCreationDays: Number(extents[0]?.Count) || 0
      });
    }
    this.emit({ verification: results });
  }
}
