/**
 * Turns the user's table mappings into the exact commands the runner executes.
 *
 * Why buckets of one day: Kusto ages data for retention and the hot cache by
 * each extent's creation time, not by any column in it. A plain copy would
 * stamp years-old data as created today, so it would sit in the hot cache and
 * restart its retention clock. Copying one day of the timestamp column per
 * command, with `creationTime` set to the end of that day, rebuilds extents that
 * age exactly like the data they hold.
 *
 * Every copy carries an `ingest-by:` tag and `ingestIfNotExists`, so re-running
 * a bucket after a failure or a closed browser never duplicates data.
 */

import {
  KustoColumn,
  MigrationPlan,
  PlanIssue,
  PolicyChoice,
  SourceTable,
  TableHistogram,
  TableMapping,
  TablePlan,
  TargetTable
} from "./model";
import { kqlDatetime, kqlName, kqlString, kqlVerbatim } from "./kql";

/** Microsoft's guidance for ingest-from-query: keep each operation under 1 GB, or distribute it. */
export const DISTRIBUTE_ABOVE_BYTES = 1024 * 1024 * 1024;

const PREFERRED_TIMESTAMP = /^(timestamp|eventtime|event_time|time|datetime|ts|createdat|created_at|enqueuedtime)$/i;

export function datetimeColumns(columns: KustoColumn[]): string[] {
  return columns.filter(column => column.type.toLowerCase() === "datetime").map(column => column.name);
}

/** Sensible starting choices: map onto a same-named target table if one exists, keep source policies. */
export function defaultMapping(source: SourceTable, targets: TargetTable[]): TableMapping {
  const existing = targets.find(target => target.name.toLowerCase() === source.name.toLowerCase());
  const candidates = datetimeColumns(source.columns);
  return {
    sourceTable: source.name,
    include: true,
    mode: existing ? "existing" : "create",
    targetTable: existing ? existing.name : source.name,
    timestampColumn: candidates.find(name => PREFERRED_TIMESTAMP.test(name)) || candidates[0],
    retention: source.retentionDays !== undefined ? { mode: "source" } : { mode: "keep" },
    caching: source.cacheDays !== undefined ? { mode: "source" } : { mode: "keep" }
  };
}

/** The days a policy choice resolves to, or undefined when the target is left as is. */
export function resolvePolicyDays(choice: PolicyChoice, sourceDays: number | undefined): number | undefined {
  if (choice.mode === "source") {
    return sourceDays;
  }
  if (choice.mode === "custom") {
    return choice.days;
  }
  return undefined;
}

function nullLiteral(type: string): string {
  const t = type.toLowerCase();
  if (t === "string") {
    return `""`;
  }
  return `${t === "dynamic" ? "dynamic" : t}(null)`;
}

/**
 * How the source rows are shaped to fit an existing target table: target column
 * order, missing columns filled with nulls, extra source columns dropped.
 */
function projectionFor(source: SourceTable, target: TargetTable): { projection?: string; issues: string[]; errors: string[] } {
  const issues: string[] = [];
  const errors: string[] = [];
  const sourceByName = new Map(source.columns.map(column => [column.name.toLowerCase(), column]));
  const targetNames = new Set(target.columns.map(column => column.name.toLowerCase()));

  const parts = target.columns.map(column => {
    const match = sourceByName.get(column.name.toLowerCase());
    if (!match) {
      issues.push(`Target column '${column.name}' has no source column and will be empty.`);
      return `${kqlName(column.name)}=${nullLiteral(column.type)}`;
    }
    if (match.type.toLowerCase() !== column.type.toLowerCase()) {
      errors.push(`Column '${column.name}' is ${match.type} in the source but ${column.type} in the target.`);
    }
    return kqlName(match.name) === kqlName(column.name) ? kqlName(column.name) : `${kqlName(column.name)}=${kqlName(match.name)}`;
  });

  const dropped = source.columns.filter(column => !targetNames.has(column.name.toLowerCase()));
  if (dropped.length > 0) {
    issues.push(`Source column(s) ${dropped.map(c => `'${c.name}'`).join(", ")} don't exist in the target and won't be copied.`);
  }

  const identical =
    dropped.length === 0 &&
    source.columns.length === target.columns.length &&
    source.columns.every((column, i) => column.name === target.columns[i].name);
  return { projection: identical ? undefined : `project ${parts.join(", ")}`, issues, errors };
}

export function validateMapping(
  mapping: TableMapping,
  source: SourceTable,
  target: TargetTable | undefined
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const add = (severity: PlanIssue["severity"], message: string) =>
    issues.push({ severity, table: source.name, message });

  if (!mapping.include) {
    return issues;
  }
  if (!mapping.targetTable.trim()) {
    add("error", "Choose a target table name.");
  }
  if (mapping.mode === "existing" && !target) {
    add("error", `Target table '${mapping.targetTable}' doesn't exist. Pick another, or auto-create it.`);
  }
  if (mapping.mode === "create" && target) {
    add("warning", `Target table '${mapping.targetTable}' already exists; its schema will be extended with any missing columns.`);
  }

  const column = source.columns.find(c => c.name === mapping.timestampColumn);
  if (!mapping.timestampColumn) {
    add("error", datetimeColumns(source.columns).length === 0
      ? "The table has no datetime column, so it can't be split into daily buckets."
      : "Choose the timestamp column that defines the daily buckets.");
  } else if (!column || column.type.toLowerCase() !== "datetime") {
    add("error", `Column '${mapping.timestampColumn}' is not a datetime column.`);
  }

  for (const [label, choice] of [["Retention", mapping.retention], ["Caching", mapping.caching]] as const) {
    if (choice.mode === "custom" && (!choice.days || choice.days < 1 || !Number.isInteger(choice.days))) {
      add("error", `${label}: enter a whole number of days (1 or more).`);
    }
  }
  const retention = resolvePolicyDays(mapping.retention, source.retentionDays) ?? target?.retentionDays;
  const cache = resolvePolicyDays(mapping.caching, source.cacheDays) ?? target?.cacheDays;
  if (retention !== undefined && cache !== undefined && cache > retention) {
    add("error", `The hot cache (${cache} days) can't be longer than retention (${retention} days) in Fabric.`);
  }

  if (mapping.mode === "existing" && target) {
    const shape = projectionFor(source, target);
    shape.errors.forEach(message => add("error", message));
    shape.issues.forEach(message => add("warning", message));
  }
  return issues;
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The last tick of a UTC day, so retention never drops a bucket's newest rows early. */
export function endOfDay(day: string): string {
  return `${day}T23:59:59.9999999Z`;
}

export function copyTag(targetTable: string, day: string | undefined): string {
  return `ssmig:${targetTable}:${day || "null"}`;
}

function daysBetween(fromDay: string, now: Date): number {
  const from = Date.parse(`${fromDay}T00:00:00Z`);
  return Math.max(1, Math.ceil((now.getTime() - from) / 86400000));
}

export interface PlanContext {
  sourceClusterUri: string;
  sourceDatabase: string;
  now?: Date;
}

export function buildTablePlan(
  mapping: TableMapping,
  source: SourceTable,
  target: TargetTable | undefined,
  histogram: TableHistogram | undefined,
  context: PlanContext
): TablePlan {
  const issues = validateMapping(mapping, source, target);
  const plan: TablePlan = { mapping, prepare: [], copies: [], issues };
  if (!mapping.include || issues.some(issue => issue.severity === "error")) {
    return plan;
  }
  if (!histogram) {
    issues.push({ severity: "error", table: source.name, message: "The day histogram hasn't been read yet." });
    return plan;
  }

  const t = kqlName(mapping.targetTable);
  const add = (id: string, description: string, command: string) =>
    plan.prepare.push({ id: `${mapping.targetTable}:${id}`, table: mapping.targetTable, description, command });

  if (mapping.mode === "create") {
    const columns = source.columns.map(column => `${kqlName(column.name)}:${column.type}`).join(", ");
    add("create", `Create table '${mapping.targetTable}' with the source schema`, `.create-merge table ${t} (${columns})`);
  }
  const retention = resolvePolicyDays(mapping.retention, source.retentionDays);
  if (retention !== undefined) {
    add("retention", `Retention ${retention} days`, `.alter-merge table ${t} policy retention softdelete = ${retention}d recoverability = enabled`);
  }
  const cache = resolvePolicyDays(mapping.caching, source.cacheDays);
  if (cache !== undefined) {
    add("caching", `Hot cache ${cache} days`, `.alter table ${t} policy caching hot = ${cache}d`);
  }

  const avgRowBytes = source.rowCount > 0 ? source.originalSizeBytes / source.rowCount : 0;
  const shape = mapping.mode === "existing" && target ? projectionFor(source, target).projection : undefined;
  const from = `cluster(${kqlString(context.sourceClusterUri)}).database(${kqlString(context.sourceDatabase)}).${kqlName(source.name)}`;
  const ts = kqlName(mapping.timestampColumn as string);

  const copy = (day: string | undefined, rows: number) => {
    const tag = copyTag(mapping.targetTable, day);
    const estimatedBytes = Math.round(rows * avgRowBytes);
    const props = [
      day ? `creationTime=${kqlString(endOfDay(day))}` : undefined,
      `tags=${kqlString(JSON.stringify([`ingest-by:${tag}`]))}`,
      `ingestIfNotExists=${kqlString(JSON.stringify([tag]))}`,
      `distributed=${estimatedBytes > DISTRIBUTE_ABOVE_BYTES}`
    ].filter(Boolean).join(", ");
    const filter = day
      ? `where ${ts} >= ${kqlDatetime(`${day}T00:00:00Z`)} and ${ts} < ${kqlDatetime(`${nextDay(day)}T00:00:00Z`)}`
      : `where isnull(${ts})`;
    const command = `.set-or-append async ${t} with (${props}) <|\n${from}\n| ${filter}${shape ? `\n| ${shape}` : ""}`;
    plan.copies.push({
      id: tag,
      sourceTable: source.name,
      targetTable: mapping.targetTable,
      day,
      rows,
      estimatedBytes,
      creationTime: day ? endOfDay(day) : undefined,
      tag,
      command
    });
  };

  const days = histogram.days.filter(bucket => bucket.rows > 0).sort((a, b) => a.day.localeCompare(b.day));
  days.forEach(bucket => copy(bucket.day, bucket.rows));
  if (histogram.nullRows > 0) {
    copy(undefined, histogram.nullRows);
    issues.push({
      severity: "warning",
      table: source.name,
      message: `${histogram.nullRows} row(s) have no '${mapping.timestampColumn}' value; they're copied with today's creation time.`
    });
  }

  if (days.length > 0) {
    plan.mergeLookbackDays = daysBetween(days[0].day, context.now || new Date()) + 1;
  }
  return plan;
}

export function buildMigrationPlan(
  mappings: TableMapping[],
  sources: SourceTable[],
  targets: TargetTable[],
  histograms: Record<string, TableHistogram>,
  context: PlanContext
): MigrationPlan {
  const tables = mappings
    .filter(mapping => mapping.include)
    .map(mapping =>
      buildTablePlan(
        mapping,
        sources.find(s => s.name === mapping.sourceTable) as SourceTable,
        targets.find(t => t.name.toLowerCase() === mapping.targetTable.toLowerCase()),
        histograms[mapping.sourceTable],
        context
      )
    );

  // Two source tables writing to one target would collide on tags and policies.
  const byTarget = new Map<string, string[]>();
  for (const table of tables) {
    const key = table.mapping.targetTable.toLowerCase();
    byTarget.set(key, [...(byTarget.get(key) || []), table.mapping.sourceTable]);
  }
  for (const table of tables) {
    const sharing = byTarget.get(table.mapping.targetTable.toLowerCase()) || [];
    if (sharing.length > 1) {
      table.issues.push({
        severity: "error",
        table: table.mapping.sourceTable,
        message: `Target '${table.mapping.targetTable}' is also chosen for ${sharing.filter(s => s !== table.mapping.sourceTable).join(", ")}.`
      });
    }
  }

  const copies = tables.flatMap(table => table.copies);
  return {
    sourceClusterUri: context.sourceClusterUri,
    sourceDatabase: context.sourceDatabase,
    tables,
    totals: {
      tables: tables.length,
      copies: copies.length,
      rows: copies.reduce((sum, c) => sum + c.rows, 0),
      estimatedBytes: copies.reduce((sum, c) => sum + c.estimatedBytes, 0)
    },
    ready: tables.length > 0 && tables.every(table => !table.issues.some(issue => issue.severity === "error"))
  };
}

// ---- merge policy -----------------------------------------------------------

/**
 * Backdated extents fall outside the default 14-day merge lookback, so they
 * would never merge into fewer, larger extents. Widen the lookback for the
 * duration of the backfill; the original policy is restored afterwards.
 */
export function mergeLookbackCommand(table: string, days: number): string {
  const policy = { Lookback: { Kind: "Custom", CustomPeriod: `${days}.00:00:00` } };
  return `.alter-merge table ${kqlName(table)} policy merge ${kqlVerbatim(JSON.stringify(policy))}`;
}

/** Puts the merge policy back exactly as it was: deleted if the table had none of its own. */
export function restoreMergeCommand(table: string, originalPolicyJson: string | null | undefined): string {
  return originalPolicyJson
    ? `.alter table ${kqlName(table)} policy merge ${kqlVerbatim(originalPolicyJson)}`
    : `.delete table ${kqlName(table)} policy merge`;
}

// ---- reads ----------------------------------------------------------------

/** Rows per UTC day of the timestamp column; null timestamps reported with an empty day. */
export function histogramQuery(table: string, timestampColumn: string): string {
  const ts = kqlName(timestampColumn);
  return `${kqlName(table)}\n| summarize rows=count() by day=iff(isnull(${ts}), "", format_datetime(bin(${ts}, 1d), "yyyy-MM-dd"))`;
}

/** Creation-time histogram of a table's extents, to prove the extents were rebuilt. */
export function extentCreationQuery(table: string): string {
  return `.show table ${kqlName(table)} extents\n| summarize extents=count(), rows=sum(RowCount) by day=format_datetime(bin(MaxCreatedOn, 1d), "yyyy-MM-dd")`;
}

export function parseHistogram(rows: { day: string; rows: number }[]): TableHistogram {
  const histogram: TableHistogram = { days: [], nullRows: 0 };
  for (const row of rows) {
    if (!row.day) {
      histogram.nullRows += Number(row.rows) || 0;
    } else {
      histogram.days.push({ day: row.day, rows: Number(row.rows) || 0 });
    }
  }
  histogram.days.sort((a, b) => a.day.localeCompare(b.day));
  return histogram;
}

export interface BucketComparison {
  day: string;
  sourceRows: number;
  targetRows: number;
}

/** Day-by-day row counts, source vs target; only mismatches are worth showing. */
export function compareHistograms(source: TableHistogram, target: TableHistogram): BucketComparison[] {
  const days = new Set([...source.days.map(d => d.day), ...target.days.map(d => d.day)]);
  const lookup = (h: TableHistogram, day: string) => h.days.find(d => d.day === day)?.rows || 0;
  const result = Array.from(days)
    .sort()
    .map(day => ({ day, sourceRows: lookup(source, day), targetRows: lookup(target, day) }));
  if (source.nullRows || target.nullRows) {
    result.push({ day: "(no timestamp)", sourceRows: source.nullRows, targetRows: target.nullRows });
  }
  return result;
}
