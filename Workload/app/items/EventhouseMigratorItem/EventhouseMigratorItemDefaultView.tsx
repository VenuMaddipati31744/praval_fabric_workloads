import React, { useMemo } from "react";
import { WorkloadClientAPI } from "@ms-fabric/workload-client";

import { WizardControl, WizardStep } from "../../components";
import { MigrationPlanRecord, syncStartOf } from "./EventhouseMigratorItemDefinition";
import { EH_STEP_IDS, EhWizardContext, asEhContext, planFromContext } from "./steps/WizardContext";
import { SourceStep } from "./steps/SourceStep";
import { TargetStep } from "./steps/TargetStep";
import { TablesStep } from "./steps/TablesStep";
import { PlanStep } from "./steps/PlanStep";
import "./EventhouseMigratorItem.scss";

export interface EventhouseMigratorItemDefaultViewProps {
  workloadClient: WorkloadClientAPI;
  /** The plan being edited; undefined for a new plan. */
  plan?: MigrationPlanRecord;
  onWizardComplete: (context: EhWizardContext) => void;
  onWizardCancel: () => void;
}

/** Hosts the planning wizard; completing it saves the plan and opens the run view. */
export function EventhouseMigratorItemDefaultView({
  workloadClient,
  plan,
  onWizardComplete,
  onWizardCancel
}: EventhouseMigratorItemDefaultViewProps) {
  // Rehydrate saved choices so editing a plan doesn't start over.
  const initialContext = useMemo(
    () => ({
      workloadClient,
      sourceClusterUri: plan?.sourceClusterUri,
      sourceDatabases: plan?.sourceDatabase
        ? [{ name: plan.sourceDatabase, label: plan.sourceDatabaseLabel || plan.sourceDatabase }]
        : undefined,
      sourceDatabase: plan?.sourceDatabase,
      sourceDatabaseLabel: plan?.sourceDatabaseLabel,
      sourceTables: plan?.sourceTables,
      target: plan?.target,
      targetTables: plan?.targetTables,
      mappings: plan?.mappings,
      histograms: plan?.histograms,
      plannedAt: plan?.plannedAt,
      window: plan?.window,
      watermark: plan ? syncStartOf(plan) : undefined
    }),
    [workloadClient, plan]
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
