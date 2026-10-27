/**
 * Parses the metadata Kusto returns into the engine's model.
 *
 * Reads used:
 *   .show database cslschema   → TableName, Schema ("a:string, ['b c']:long")
 *   .show tables details       → TableName, TotalRowCount, TotalOriginalSize,
 *                                RetentionPolicy, CachingPolicy (JSON strings)
 */

import { KustoColumn, SourceTable, TargetTable } from "./model";
import { timespanToDays } from "./kql";

export const SCHEMA_COMMAND = ".show database cslschema";
export const DETAILS_COMMAND = ".show tables details";

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

export function buildSourceTables(schemaRows: SchemaRow[], detailRows: DetailsRow[]): SourceTable[] {
  const details = new Map(detailRows.map(row => [row.TableName, row]));
  return schemaRows
    .filter(row => row.TableName)
    .map(row => {
      const detail = details.get(row.TableName);
      return {
        name: row.TableName,
        columns: parseCslSchema(row.Schema),
        rowCount: Number(detail?.TotalRowCount) || 0,
        originalSizeBytes: Number(detail?.TotalOriginalSize) || 0,
        retentionDays: retentionDaysOf(detail?.RetentionPolicy),
        cacheDays: cacheDaysOf(detail?.CachingPolicy)
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildTargetTables(schemaRows: SchemaRow[], detailRows: DetailsRow[]): TargetTable[] {
  return buildSourceTables(schemaRows, detailRows).map(({ name, columns, retentionDays, cacheDays }) => ({
    name,
    columns,
    retentionDays,
    cacheDays
  }));
}
