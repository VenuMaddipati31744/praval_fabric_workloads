/**
 * Persisted state for an Eventhouse Migrator item: a list of migration plans.
 *
 * Each plan stores what's needed to rebuild its exact commands, rather than the
 * commands themselves (which grow with every day of history): the source and
 * target inventories, the per-table choices, the day histograms and the time
 * the plan was made. Rebuilding is deterministic and copy ids are stable, so a
 * plan's saved run state lines up with the rebuilt plan on resume.
 */

import { LoadWindow, SourceTable, TableHistogram, TableMapping, TargetTable } from "./engine";
import { RunPhase, RunState } from "./kusto/MigrationRunner";

export interface MigrationTarget {
  workspaceId: string;
  itemId: string;
  displayName: string;
  queryServiceUri: string;
  databaseName: string;
}

/** The planning inputs of one migration, as gathered by the wizard. */
export interface PlanInputs {
  sourceClusterUri?: string;
  /** The database's name in commands (a GUID in Fabric). */
  sourceDatabase?: string;
  /** The database's display name. */
  sourceDatabaseLabel?: string;
  target?: MigrationTarget;

  sourceTables?: SourceTable[];
  targetTables?: TargetTable[];
  mappings?: TableMapping[];
  histograms?: Record<string, TableHistogram>;
  /** When the plan was made; fixes the merge lookback so a resumed plan is identical. */
  plannedAt?: string;
  /** The ingestion-time window of the current load. */
  window?: LoadWindow;
}

/** One completed (or abandoned) load, for the plan's history. */
export interface LoadRecord {
  window?: LoadWindow;
  phase: RunPhase;
  rows: number;
  startedAt?: string;
  finishedAt?: string;
}

export interface MigrationPlanRecord extends PlanInputs {
  id: string;
  createdAt: string;
  updatedAt: string;
  run?: RunState;
  /**
   * Source data is in the target up to this ingestion time. The next sync
   * starts here, so it copies only rows that arrived since.
   */
  watermark?: string;
  loads?: LoadRecord[];
}

/**
 * Where the next sync should start. Plans made before load windows existed
 * copied everything present when their run started, so that's their mark.
 */
export function syncStartOf(plan: MigrationPlanRecord): string | undefined {
  return plan.watermark || (plan.run?.phase === "done" ? plan.run.startedAt : undefined);
}

export interface EventhouseMigratorItemDefinition {
  plans?: MigrationPlanRecord[];
  /** The plan shown when the item opens. */
  activePlanId?: string;
}

/** Items saved before plans became a list kept a single plan's fields at the top level. */
type LegacyDefinition = EventhouseMigratorItemDefinition & PlanInputs & { run?: RunState };

/** Reads either shape; a legacy single plan becomes the first entry of the list. */
export function normalizeDefinition(definition: LegacyDefinition | undefined): EventhouseMigratorItemDefinition {
  if (!definition) {
    return { plans: [] };
  }
  if (definition.plans) {
    return { plans: definition.plans, activePlanId: definition.activePlanId };
  }
  if (!definition.sourceClusterUri) {
    return { plans: [] };
  }
  const { run, sourceClusterUri, sourceDatabase, sourceDatabaseLabel, target, sourceTables, targetTables, mappings, histograms, plannedAt } = definition;
  const stamp = plannedAt || new Date().toISOString();
  const plan: MigrationPlanRecord = {
    id: "plan-1",
    createdAt: stamp,
    updatedAt: run?.finishedAt || stamp,
    sourceClusterUri,
    sourceDatabase,
    sourceDatabaseLabel,
    target,
    sourceTables,
    targetTables,
    mappings,
    histograms,
    plannedAt,
    run
  };
  return { plans: [plan], activePlanId: plan.id };
}

export function newPlanId(): string {
  return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
