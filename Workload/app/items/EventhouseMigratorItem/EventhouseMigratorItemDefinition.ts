/**
 * Persisted state for an Eventhouse Migrator item.
 *
 * Everything needed to rebuild the exact plan is stored, rather than the plan
 * itself (whose copy commands grow with every day of history): the source and
 * target inventories, the per-table choices, the day histograms and the time
 * the plan was made. Rebuilding is deterministic, and copy ids are stable, so
 * the saved run state lines up with the rebuilt plan on resume.
 */

import { SourceTable, TableHistogram, TableMapping, TargetTable } from "./engine";
import { RunState } from "./kusto/MigrationRunner";

export interface MigrationTarget {
  workspaceId: string;
  itemId: string;
  displayName: string;
  queryServiceUri: string;
  databaseName: string;
}

export interface EventhouseMigratorItemDefinition {
  sourceClusterUri?: string;
  sourceDatabase?: string;
  target?: MigrationTarget;

  sourceTables?: SourceTable[];
  targetTables?: TargetTable[];
  mappings?: TableMapping[];
  histograms?: Record<string, TableHistogram>;
  /** When the plan was made; fixes the merge lookback so a resumed plan is identical. */
  plannedAt?: string;

  run?: RunState;
}
