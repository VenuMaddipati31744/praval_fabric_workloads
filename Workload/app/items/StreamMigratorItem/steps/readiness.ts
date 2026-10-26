/**
 * Whether a migration is ready to execute.
 *
 * Two independent gates: the assessment must report no blockers (an ASA/Eventstream
 * capability question), and every generated node must be fully configured (a
 * user-input question). Both must pass before the Eventstream is created, so a
 * predictable client-side failure is never turned into an opaque server-side one.
 */

import { MigratorWizardContext } from "./WizardContext";
import { asaOutputNameOf } from "../migration";

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

  const eventstreamName = (context.eventstreamName || "").trim();
  if (!eventstreamName) {
    problems.push("The Eventstream needs a name.");
  } else if (/[_.]/.test(eventstreamName)) {
    // The SQL operator reads the default stream "<name>-stream", and Fabric
    // documents names with underscores or dots as incompatible with it.
    problems.push("The Eventstream name cannot contain underscores (_) or dots (.).");
  }

  for (const source of plan.definition.sources) {
    const asaInputName = source.name.replace(/-source$/, "");
    if (!context.connections?.[asaInputName]) {
      problems.push(`Input '${asaInputName}' has no Fabric connection selected.`);
    }
  }

  for (const destination of plan.definition.destinations) {
    const asaOutputName = asaOutputNameOf(context.job, destination.name);
    const target = context.targets?.[asaOutputName];

    if (!target?.workspaceId || !target?.itemId) {
      problems.push(`Output '${asaOutputName}' has no target item selected.`);
      continue;
    }

    if (destination.type === "Eventhouse") {
      if (!target.databaseName) {
        problems.push(`Output '${asaOutputName}' needs a KQL database name.`);
      }
      if (!target.tableName) {
        problems.push(`Output '${asaOutputName}' needs a destination table name.`);
      }
    } else if (destination.type === "Lakehouse" && !target.deltaTable) {
      problems.push(`Output '${asaOutputName}' needs a delta table name.`);
    }
  }

  return { ready: problems.length === 0, problems };
}
