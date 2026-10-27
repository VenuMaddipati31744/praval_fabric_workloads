/**
 * Shared shape of the Eventhouse migration wizard's context.
 *
 * WizardControl passes context around as Record<string, any>; this type plus
 * the accessor keep the steps honest without fighting that API.
 */

import { WorkloadClientAPI } from "@ms-fabric/workload-client";
import { MigrationTarget } from "../EventhouseMigratorItemDefinition";
import { SourceTable, TableHistogram, TableMapping, TargetTable, buildMigrationPlan, MigrationPlan } from "../engine";

export interface EhWizardContext {
  workloadClient: WorkloadClientAPI;

  /** Step 1: source ADX database. */
  sourceClusterUri?: string;
  sourceDatabases?: string[];
  sourceDatabase?: string;
  sourceTables?: SourceTable[];

  /** Step 2: target KQL database. */
  target?: MigrationTarget;
  targetTables?: TargetTable[];

  /** Step 3: per source table. */
  mappings?: TableMapping[];

  /** Step 4: day histograms read for the included tables. */
  histograms?: Record<string, TableHistogram>;
  plannedAt?: string;
}

export function asEhContext(context: Record<string, any>): EhWizardContext {
  return context as EhWizardContext;
}

export const EH_STEP_IDS = {
  SOURCE: "source",
  TARGET: "target",
  TABLES: "tables",
  PLAN: "plan"
};

/** The plan for the current context, or undefined until histograms are read. */
export function planFromContext(context: EhWizardContext): MigrationPlan | undefined {
  if (!context.sourceClusterUri || !context.sourceDatabase || !context.mappings || !context.histograms) {
    return undefined;
  }
  return buildMigrationPlan(
    context.mappings,
    context.sourceTables || [],
    context.targetTables || [],
    context.histograms,
    {
      sourceClusterUri: context.sourceClusterUri,
      sourceDatabase: context.sourceDatabase,
      now: context.plannedAt ? new Date(context.plannedAt) : undefined
    }
  );
}
