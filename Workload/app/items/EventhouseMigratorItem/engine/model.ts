/**
 * Shapes shared by the Eventhouse migration engine, the runner and the wizard.
 */

export interface KustoColumn {
  name: string;
  /** Kusto scalar type as reported by cslschema: string, long, datetime, dynamic, ... */
  type: string;
}

/** A table as read from the source ADX database. */
export interface SourceTable {
  name: string;
  columns: KustoColumn[];
  rowCount: number;
  originalSizeBytes: number;
  /** Table-level policies; undefined when the table inherits the database default. */
  retentionDays?: number;
  cacheDays?: number;
}

/** A table that already exists in the target KQL database. */
export interface TargetTable {
  name: string;
  columns: KustoColumn[];
  retentionDays?: number;
  cacheDays?: number;
}

export type TableTargetMode = "create" | "existing";

/**
 * - `source`: copy the source table's policy.
 * - `custom`: use the number of days given.
 * - `keep`: leave the target as it is (its own policy or the database default).
 */
export type PolicyMode = "source" | "custom" | "keep";

export interface PolicyChoice {
  mode: PolicyMode;
  days?: number;
}

/** The user's decision for one source table. */
export interface TableMapping {
  sourceTable: string;
  include: boolean;
  mode: TableTargetMode;
  targetTable: string;
  /** The datetime column that defines the 1-day buckets and each extent's creation time. */
  timestampColumn?: string;
  retention: PolicyChoice;
  caching: PolicyChoice;
}

/** Row counts per UTC day of the timestamp column, read from the source. */
export interface TableHistogram {
  /** yyyy-MM-dd → rows. */
  days: { day: string; rows: number }[];
  /** Rows whose timestamp is null; they get a bucket of their own. */
  nullRows: number;
}

export type IssueSeverity = "error" | "warning";

export interface PlanIssue {
  severity: IssueSeverity;
  table: string;
  message: string;
}

export interface PlanCommand {
  id: string;
  table: string;
  description: string;
  command: string;
}

/** One `.set-or-append` that copies a single day (or the null-timestamp rows) of one table. */
export interface CopyTask {
  id: string;
  sourceTable: string;
  targetTable: string;
  /** yyyy-MM-dd, or undefined for the null-timestamp bucket. */
  day?: string;
  rows: number;
  estimatedBytes: number;
  /** Creation time stamped on the new extents; undefined means ingestion time. */
  creationTime?: string;
  /** The ingest-by tag value that makes a retry a no-op. */
  tag: string;
  command: string;
}

export interface TablePlan {
  mapping: TableMapping;
  /** Run before any copy: create table, set policies. */
  prepare: PlanCommand[];
  /** Merge lookback that lets backdated extents merge; the original is restored afterwards. */
  mergeLookbackDays?: number;
  copies: CopyTask[];
  issues: PlanIssue[];
}

export interface MigrationPlan {
  sourceClusterUri: string;
  sourceDatabase: string;
  tables: TablePlan[];
  totals: { tables: number; copies: number; rows: number; estimatedBytes: number };
  /** False when any included table has an error-level issue. */
  ready: boolean;
}
