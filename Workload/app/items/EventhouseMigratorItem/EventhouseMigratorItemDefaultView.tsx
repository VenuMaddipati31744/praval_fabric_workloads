import React, { useMemo } from "react";
import { WorkloadClientAPI } from "@ms-fabric/workload-client";

import { WizardControl, WizardStep } from "../../components";
import { EventhouseMigratorItemDefinition } from "./EventhouseMigratorItemDefinition";
import { EH_STEP_IDS, EhWizardContext, asEhContext, planFromContext } from "./steps/WizardContext";
import { SourceStep } from "./steps/SourceStep";
import { TargetStep } from "./steps/TargetStep";
import { TablesStep } from "./steps/TablesStep";
import { PlanStep } from "./steps/PlanStep";
import "./EventhouseMigratorItem.scss";

export interface EventhouseMigratorItemDefaultViewProps {
  workloadClient: WorkloadClientAPI;
  definition?: EventhouseMigratorItemDefinition;
  onWizardComplete: (context: EhWizardContext) => void;
  onWizardCancel: () => void;
}

/** Hosts the planning wizard; completing it saves the plan and opens the run view. */
export function EventhouseMigratorItemDefaultView({
  workloadClient,
  definition,
  onWizardComplete,
  onWizardCancel
}: EventhouseMigratorItemDefaultViewProps) {
  // Rehydrate saved choices so reopening the item doesn't start over.
  const initialContext = useMemo(
    () => ({
      workloadClient,
      sourceClusterUri: definition?.sourceClusterUri,
      sourceDatabases: definition?.sourceDatabase ? [definition.sourceDatabase] : undefined,
      sourceDatabase: definition?.sourceDatabase,
      sourceTables: definition?.sourceTables,
      target: definition?.target,
      targetTables: definition?.targetTables,
      mappings: definition?.mappings,
      histograms: definition?.histograms,
      plannedAt: definition?.plannedAt
    }),
    [workloadClient, definition]
  );

  const steps: WizardStep[] = [
    {
      id: EH_STEP_IDS.SOURCE,
      title: "Source",
      description: "Azure Data Explorer cluster and database",
      component: SourceStep,
      validate: context => Boolean(asEhContext(context).sourceTables)
    },
    {
      id: EH_STEP_IDS.TARGET,
      title: "Target",
      description: "Eventhouse KQL database",
      component: TargetStep,
      validate: context => Boolean(asEhContext(context).target)
    },
    {
      id: EH_STEP_IDS.TABLES,
      title: "Tables & policies",
      description: "Map tables, timestamp columns, retention and cache",
      component: TablesStep,
      validate: context => (asEhContext(context).mappings || []).some(m => m.include)
    },
    {
      id: EH_STEP_IDS.PLAN,
      title: "Plan",
      description: "Daily buckets and the exact commands",
      component: PlanStep
    }
  ];

  return (
    <WizardControl
      steps={steps}
      title="Migrate Azure Data Explorer to Eventhouse"
      initialContext={initialContext}
      canFinish={(_stepId, context) => Boolean(planFromContext(asEhContext(context))?.ready)}
      onComplete={context => onWizardComplete(asEhContext(context))}
      onCancel={onWizardCancel}
      navigationLabels={{ complete: "Save plan" }}
    />
  );
}
