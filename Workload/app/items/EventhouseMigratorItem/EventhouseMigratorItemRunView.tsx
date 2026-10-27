import React from "react";
import {
  Badge,
  Button,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  ProgressBar,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text
} from "@fluentui/react-components";

import { MigrationPlan } from "./engine";
import { RunPhase, RunState } from "./kusto/MigrationRunner";

const PHASE_LABEL: Record<RunPhase, string> = {
  idle: "Not started",
  preparing: "Preparing tables and policies",
  copying: "Copying daily buckets",
  restoring: "Restoring merge policies",
  verifying: "Verifying row counts",
  done: "Completed",
  failed: "Finished with errors",
  stopped: "Stopped"
};

const PHASE_COLOR: Record<RunPhase, "informative" | "success" | "danger" | "warning"> = {
  idle: "informative",
  preparing: "informative",
  copying: "informative",
  restoring: "informative",
  verifying: "informative",
  done: "success",
  failed: "danger",
  stopped: "warning"
};

export interface EventhouseMigratorItemRunViewProps {
  plan?: MigrationPlan;
  run: RunState;
  running: boolean;
  sourceLabel: string;
  targetLabel: string;
  onStart: () => void;
  onStop: () => void;
  onEditPlan: () => void;
}

/** Progress, log and verification for a migration run. */
export function EventhouseMigratorItemRunView({
  plan,
  run,
  running,
  sourceLabel,
  targetLabel,
  onStart,
  onStop,
  onEditPlan
}: EventhouseMigratorItemRunViewProps) {
  if (!plan) {
    return (
      <div className="eh-migrator__step eh-migrator__run">
        <Text>No migration plan yet.</Text>
        <Button onClick={onEditPlan}>Plan a migration</Button>
      </div>
    );
  }

  const copies = plan.tables.flatMap(table => table.copies);
  const doneCount = copies.filter(c => run.copies[c.id]?.status === "done").length;
  const started = Object.keys(run.copies).length > 0;
  const finished = run.phase === "done";

  return (
    <div className="eh-migrator__step eh-migrator__run">
      <div className="eh-migrator__run-header">
        <div>
          <Text as="h2" size={500} weight="semibold">Migration</Text>
          <div className="eh-migrator__muted">{`${sourceLabel} → ${targetLabel}`}</div>
        </div>
        <div className="eh-migrator__row eh-migrator__row--start">
          <Badge appearance="filled" color={PHASE_COLOR[run.phase]}>{PHASE_LABEL[run.phase]}</Badge>
          {running ? (
            <Button onClick={onStop}>Stop</Button>
          ) : (
            <>
              <Button appearance="primary" disabled={!plan.ready || finished} onClick={onStart}>
                {started ? "Resume" : "Start migration"}
              </Button>
              <Button onClick={onEditPlan}>Edit plan</Button>
            </>
          )}
        </div>
      </div>

      {!plan.ready && (
        <MessageBar intent="error">
          <MessageBarBody>The plan has errors. Edit the plan to resolve them.</MessageBarBody>
        </MessageBar>
      )}

      <ProgressBar value={copies.length ? doneCount / copies.length : 0} thickness="large" />
      <Text>{`${doneCount} of ${copies.length} daily copies done`}</Text>

      <Table size="small" aria-label="Progress by table">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Table</TableHeaderCell>
            <TableHeaderCell>Days copied</TableHeaderCell>
            <TableHeaderCell>Rows</TableHeaderCell>
            <TableHeaderCell>Failed</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {plan.tables.map(table => {
            const done = table.copies.filter(c => run.copies[c.id]?.status === "done");
            const failed = table.copies.filter(c => run.copies[c.id]?.status === "failed");
            return (
              <TableRow key={table.mapping.sourceTable}>
                <TableCell>{`${table.mapping.sourceTable} → ${table.mapping.targetTable}`}</TableCell>
                <TableCell>{`${done.length} / ${table.copies.length}`}</TableCell>
                <TableCell>{`${done.reduce((s, c) => s + c.rows, 0).toLocaleString()} / ${table.copies.reduce((s, c) => s + c.rows, 0).toLocaleString()}`}</TableCell>
                <TableCell>
                  {failed.length > 0 ? (
                    <span title={failed.map(c => `${c.day || "no timestamp"}: ${run.copies[c.id]?.error}`).join("\n")}>
                      <Badge appearance="tint" color="danger">{failed.length}</Badge>
                    </span>
                  ) : "-"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {run.verification && (
        <>
          <Text as="h3" size={400} weight="semibold">Verification</Text>
          <Table size="small" aria-label="Verification">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Table</TableHeaderCell>
                <TableHeaderCell>Source rows</TableHeaderCell>
                <TableHeaderCell>Target rows</TableHeaderCell>
                <TableHeaderCell>Extent creation days</TableHeaderCell>
                <TableHeaderCell>Days that differ</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {run.verification.map(v => (
                <TableRow key={v.table}>
                  <TableCell>{v.table}</TableCell>
                  <TableCell>{v.sourceRows.toLocaleString()}</TableCell>
                  <TableCell>{v.targetRows.toLocaleString()}</TableCell>
                  <TableCell>{v.extentCreationDays}</TableCell>
                  <TableCell>
                    {v.mismatches.length === 0 ? (
                      <Badge appearance="tint" color="success">None</Badge>
                    ) : (
                      <span title={v.mismatches.slice(0, 20).map(m => `${m.day}: ${m.sourceRows} vs ${m.targetRows}`).join("\n")}>
                        <Badge appearance="tint" color="warning">{v.mismatches.length}</Badge>
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Text size={200} className="eh-migrator__muted">
            Extent creation days counts the distinct days among the target's extent creation times. Close to the number
            of days copied means the extents were rebuilt with their original ages. A target table that already held
            data will show more target rows than source rows.
          </Text>
        </>
      )}

      {run.log.length > 0 && (
        <>
          <Text as="h3" size={400} weight="semibold">Activity</Text>
          <pre className="eh-migrator__code eh-migrator__log">
            {run.log
              .slice(-60)
              .reverse()
              .map(entry => `${entry.at.replace("T", " ").slice(0, 19)}  ${entry.level === "error" ? "ERROR " : ""}${entry.message}`)
              .join("\n")}
          </pre>
        </>
      )}

      {run.phase === "failed" && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Some days failed</MessageBarTitle>
            Resume to retry them. Days already copied are skipped, and a retried day can't be ingested twice.
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}
