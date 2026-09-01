/**
 * Whether a migration is ready to execute.
 *
 * Two independent gates: the assessment must report no blockers (an ASA/Eventstream
 * capability question), and every generated node must be fully configured (a
 * user-input question). Both must pass before the Eventstream is created, so a
 * predictable client-side failure is never turned into an opaque server-side one.
 */

import { MigratorWizardContext } from "./WizardContext";

export interface MigrationReadiness {
  ready: boolean;
  problems: string[];
}

export function getMigrationReadiness(context: MigratorWizardContext): MigrationReadiness {
  const problems: string[] = [];
  const plan = context.plan;

  if (!plan) {
    return { ready: false, problems: ["No Stream Analytics job selected."] };
  }

  if (!plan.assessment.canMigrate) {
    const blockedCount = plan.assessment.counts.Blocked;
    problems.push(
      `The assessment reports ${blockedCount} blocked item(s). ` +
        "These have no Eventstream equivalent and must be resolved before migrating."
    );
  }

  if (!(context.eventstreamName || "").trim()) {
    problems.push("The Eventstream needs a name.");
  }

  for (const source of plan.definition.sources) {
    const asaInputName = source.name.replace(/-source$/, "");
    if (!context.connections?.[asaInputName]) {
      problems.push(`Input '${asaInputName}' has no Fabric connection selected.`);
    }
  }

  for (const destination of plan.definition.destinations) {
    const target = context.targets?.[destination.name];

    if (!target?.workspaceId || !target?.itemId) {
      problems.push(`Output '${destination.name}' has no target item selected.`);
      continue;
    }

    if (destination.type === "Eventhouse") {
      if (!target.databaseName) {
        problems.push(`Output '${destination.name}' needs a KQL database name.`);
      }
      if (!target.tableName) {
        problems.push(`Output '${destination.name}' needs a destination table name.`);
      }
    } else if (destination.type === "Lakehouse" && !target.deltaTable) {
      problems.push(`Output '${destination.name}' needs a delta table name.`);
    }
  }

  return { ready: problems.length === 0, problems };
}
