import React from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text
} from "@fluentui/react-components";

import { ItemEditorEmptyView, EmptyStateTask } from "../../components/ItemEditor";
import { MigrationPlanRecord } from "./EventhouseMigratorItemDefinition";
import { RunPhase } from "./kusto/MigrationRunner";
import "./EventhouseMigratorItem.scss";

const STATUS: Record<RunPhase | "draft", { label: string; color: "informative" | "success" | "danger" | "warning" | "subtle" }> = {
  draft: { label: "Not started", color: "subtle" },
  idle: { label: "Not started", color: "subtle" },
  preparing: { label: "Running", color: "informative" },
  copying: { label: "Running", color: "informative" },
  restoring: { label: "Running", color: "informative" },
  verifying: { label: "Running", color: "informative" },
  done: { label: "Completed", color: "success" },
  failed: { label: "Finished with errors", color: "danger" },
  stopped: { label: "Stopped", color: "warning" }
};

export interface EventhouseMigratorItemHomeViewProps {
  plans: MigrationPlanRecord[];
  /** The plan currently running, whose actions are locked. */
  runningPlanId?: string;
  onNew: () => void;
  onOpen: (planId: string) => void;
  onEdit: (planId: string) => void;
}

function formatDate(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "-";
}

/** Lists the item's migration plans; first screen when the item opens. */
export function EventhouseMigratorItemHomeView({ plans, runningPlanId, onNew, onOpen, onEdit }: EventhouseMigratorItemHomeViewProps) {
  const { t } = useTranslation();

  if (plans.length === 0) {
    const tasks: EmptyStateTask[] = [
      {
        id: "plan-migration",
        label: t("EventhouseMigratorItemEmptyView_Start", "Plan a migration"),
        description: t(
          "EventhouseMigratorItemEmptyView_Start_Description",
          "Pick an Azure Data Explorer database, map its tables and policies, and copy the data day by day."
        ),
        onClick: onNew
      }
    ];
    return (
      <ItemEditorEmptyView
        title={t("EventhouseMigratorItemEmptyView_Title", "Azure Data Explorer to Eventhouse")}
        description={t(
          "EventhouseMigratorItemEmptyView_Description",
          "Move ADX tables into an Eventhouse without resetting their age: each day of data is copied with its original date as the extent creation time, so retention and the hot cache behave as they did in ADX."
        )}
        tasks={tasks}
      />
    );
  }

  const sorted = [...plans].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));

  return (
    <div className="eh-migrator__step eh-migrator__run">
      <div className="eh-migrator__run-header">
        <div>
          <Text as="h2" size={500} weight="semibold">Migration plans</Text>
          <div className="eh-migrator__muted">Open a plan to run or review it, edit its tables and policies, or start a new one.</div>
        </div>
        <Button appearance="primary" disabled={Boolean(runningPlanId)} onClick={onNew}>
          New migration plan
        </Button>
      </div>

      <Table size="small" aria-label="Migration plans">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Source → target</TableHeaderCell>
            <TableHeaderCell>Tables</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>Last updated</TableHeaderCell>
            <TableHeaderCell />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map(plan => {
            const phase = plan.run?.phase || "draft";
            const status = plan.id === runningPlanId ? STATUS.copying : STATUS[phase];
            const tables = (plan.mappings || []).filter(m => m.include);
            const locked = Boolean(runningPlanId) && plan.id !== runningPlanId;
            return (
              <TableRow key={plan.id}>
                <TableCell>
                  <Text weight="semibold">
                    {`${plan.sourceDatabaseLabel || plan.sourceDatabase || "?"} → ${plan.target?.displayName || "?"}`}
                  </Text>
                  <div className="eh-migrator__muted">{plan.sourceClusterUri}</div>
                </TableCell>
                <TableCell>
                  <span title={tables.map(m => `${m.sourceTable} → ${m.targetTable}`).join("\n")}>{tables.length}</span>
                </TableCell>
                <TableCell>
                  <Badge appearance="tint" color={status.color}>{status.label}</Badge>
                </TableCell>
                <TableCell>{formatDate(plan.run?.finishedAt || plan.updatedAt)}</TableCell>
                <TableCell>
                  <div className="eh-migrator__row eh-migrator__row--start">
                    <Button size="small" disabled={locked} onClick={() => onOpen(plan.id)}>Open</Button>
                    <Button size="small" disabled={locked || plan.id === runningPlanId} onClick={() => onEdit(plan.id)}>Edit</Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
