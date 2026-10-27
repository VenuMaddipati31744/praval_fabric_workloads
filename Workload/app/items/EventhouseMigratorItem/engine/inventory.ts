/**
 * Parses the metadata Kusto returns into the engine's model.
 *
 * Reads used:
 *   .show database cslschema   → TableName, Schema ("a:string, ['b c']:long")
 *   .show tables details       → TableName, RetentionPolicy, CachingPolicy (JSON strings)
 *   .show database extents     → row counts and sizes, summarized per table
 *
 * Sizes come from the extents rather than `.show tables details`: Fabric serves
 * cached statistics there, which read 0 for minutes after an ingestion.
 */

import { KustoColumn, SourceTable, TargetTable } from "./model";
import { timespanToDays } from "./kql";

export const SCHEMA_COMMAND = ".show database cslschema";
export const DETAILS_COMMAND = ".show tables details";
export const EXTENT_STATS_COMMAND =
  ".show database extents | summarize Rows=sum(RowCount), OriginalSize=sum(OriginalSize) by TableName";
export const DATABASES_COMMAND = ".show databases | project DatabaseName, PrettyName";

export interface DatabaseOption {
  /** Used in commands. In Fabric this is a GUID. */
  name: string;
  /** Shown to people: the pretty name when there is one. */
  label: string;
}

export function parseDatabases(rows: { DatabaseName?: unknown; PrettyName?: unknown }[]): DatabaseOption[] {
  return rows
    .filter(row => row.DatabaseName)
    .map(row => {
      const name = String(row.DatabaseName);
      const pretty = row.PrettyName ? String(row.PrettyName).trim() : "";
      return { name, label: pretty || name };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

export interface ExtentStatsRow {
  TableName: string;
  Rows?: number;
  OriginalSize?: number;
}

/** Splits "a:string, ['b, c']:long" on top-level commas, honouring brackets and quotes. */
export function parseCslSchema(schema: string): KustoColumn[] {
  const columns: KustoColumn[] = [];
  let current = "";
  let depth = 0;
  let quote: string | undefined;

  const flush = () => {
    const text = current.trim();
    current = "";
    if (!text) {
      return;
    }
    const colon = text.lastIndexOf(":");
    if (colon <= 0) {
      return;
    }
    let name = text.slice(0, colon).trim();
    const bracketed = /^\[\s*(['"])([\s\S]*)\1\s*\]$/.exec(name);
    if (bracketed) {
      name = bracketed[2].replace(/\\(['"\\])/g, "$1");
    }
    columns.push({ name, type: text.slice(colon + 1).trim().toLowerCase() });
  };

  for (let i = 0; i < (schema || "").length; i++) {
    const ch = schema[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && i + 1 < schema.length) {
        current += schema[++i];
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
    } else if (ch === "," && depth === 0) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return columns;
}

function parseJson(value: unknown): any {
  if (!value) {
    return undefined;
  }
  if (typeof value === "object") {
    return value;
  }
  try {
    return JSON.parse(String(value));
  } catch {
    return undefined;
  }
}

/** Retention policy JSON → soft-delete days. */
export function retentionDaysOf(policy: unknown): number | undefined {
  const parsed = parseJson(policy);
  return timespanToDays(parsed?.SoftDeletePeriod);
}

/** Caching policy JSON → hot data days. Handles both {"DataHotSpan":"…"} and {"DataHotSpan":{"Value":"…"}}. */
export function cacheDaysOf(policy: unknown): number | undefined {
  const parsed = parseJson(policy);
  const span = parsed?.DataHotSpan;
  return timespanToDays(typeof span === "object" ? span?.Value : span);
}

export interface SchemaRow {
  TableName: string;
  Schema: string;
}

export interface DetailsRow {
  TableName: string;
  TotalRowCount?: number;
  TotalOriginalSize?: number;
  RetentionPolicy?: unknown;
  CachingPolicy?: unknown;
}

export function buildSourceTables(
  schemaRows: SchemaRow[],
  detailRows: DetailsRow[],
  statsRows: ExtentStatsRow[] = []
): SourceTable[] {
  const details = new Map(detailRows.map(row => [row.TableName, row]));
  const stats = new Map(statsRows.map(row => [row.TableName, row]));
  return schemaRows
    .filter(row => row.TableName)
    .map(row => {
      const detail = details.get(row.TableName);
      const stat = stats.get(row.TableName);
      return {
        name: row.TableName,
        columns: parseCslSchema(row.Schema),
        // Extents are authoritative; details are a fallback (and may be stale).
        rowCount: Number(stat?.Rows ?? detail?.TotalRowCount) || 0,
        originalSizeBytes: Number(stat?.OriginalSize ?? detail?.TotalOriginalSize) || 0,
        retentionDays: retentionDaysOf(detail?.RetentionPolicy),
        cacheDays: cacheDaysOf(detail?.CachingPolicy)
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildTargetTables(schemaRows: SchemaRow[], detailRows: DetailsRow[]): TargetTable[] {
  return buildSourceTables(schemaRows, detailRows, []).map(({ name, columns, retentionDays, cacheDays }) => ({
    name,
    columns,
    retentionDays,
    cacheDays
  }));
}
