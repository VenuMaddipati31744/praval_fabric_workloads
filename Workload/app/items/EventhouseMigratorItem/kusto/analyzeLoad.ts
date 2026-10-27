/**
 * Reads what one load would copy: the source's clock as the window's upper
 * bound, then per table how many rows lack an ingestion time and how many rows
 * fall in each day within the window.
 */

import {
  LoadWindow,
  TableHistogram,
  TableMapping,
  WATERMARK_QUERY,
  histogramQuery,
  missingIngestionTimeQuery,
  parseHistogram
} from "../engine";
import { KustoClient } from "./KustoClient";

const READ_CONCURRENCY = 3;

export interface LoadAnalysis {
  window: LoadWindow;
  histograms: Record<string, TableHistogram>;
  /** Rows this load would copy, across all tables that can take part in it. */
  rows: number;
}

/**
 * @param from the previous load's watermark; undefined for the first load.
 * @param onProgress called after each table, for a progress message.
 */
export async function analyzeLoad(
  source: KustoClient,
  database: string,
  mappings: TableMapping[],
  from: string | undefined,
  onProgress?: (done: number, total: number) => void
): Promise<LoadAnalysis> {
  const clock = await source.query(database, WATERMARK_QUERY);
  const to = new Date(String(clock[0]?.Now)).toISOString();
  const window: LoadWindow = { from, to };

  const included = mappings.filter(m => m.include && m.timestampColumn);
  const histograms: Record<string, TableHistogram> = {};
  const queue = [...included];
  let done = 0;

  await Promise.all(
    Array.from({ length: READ_CONCURRENCY }, async () => {
      while (queue.length) {
        const mapping = queue.shift() as TableMapping;
        const missingRows = await source.query(database, missingIngestionTimeQuery(mapping.sourceTable));
        const missing = Number(missingRows[0]?.Missing) || 0;
        // Rows without ingestion time are invisible to a window; on a first load
        // the table is read in full instead, and the plan flags it.
        const bounds = missing > 0 && !from ? undefined : window;
        const rows = await source.query(database, histogramQuery(mapping.sourceTable, mapping.timestampColumn as string, bounds));
        histograms[mapping.sourceTable] = { ...parseHistogram(rows as any), missingIngestionTime: missing };
        onProgress?.(++done, included.length);
      }
    })
  );

  const rows = Object.values(histograms).reduce(
    (sum, h) => sum + (from && h.missingIngestionTime ? 0 : h.days.reduce((s, d) => s + d.rows, h.nullRows)),
    0
  );
  return { window, histograms, rows };
}
