import React, { useState } from "react";
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Text
} from "@fluentui/react-components";

import { WizardStepProps } from "../../../components/Wizard/Wizard";
import { KustoClient, describeError } from "../kusto/KustoClient";
import { analyzeLoad } from "../kusto/analyzeLoad";
import { asEhContext, planFromContext } from "./WizardContext";
import { formatBytes } from "./SourceStep";

/**
 * Step 4: read how many rows each selected table has per day, then show the
 * exact commands the migration will run. On a plan that has already copied
 * data, only rows that arrived since its watermark are planned.
 */
export function PlanStep({ wizardContext, updateContext }: WizardStepProps) {
  const context = asEhContext(wizardContext);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const included = (context.mappings || []).filter(m => m.include && m.timestampColumn);

  async function analyze() {
    setError("");
    const client = new KustoClient(context.workloadClient, context.sourceClusterUri as string);
    setBusy(`Reading daily row counts (0/${included.length})...`);
    try {
      const analysis = await analyzeLoad(client, context.sourceDatabase as string, included, context.watermark, (done, total) =>
        setBusy(`Reading daily row counts (${done}/${total})...`)
      );
      updateContext("histograms", analysis.histograms);
      updateContext("window", analysis.window);
      updateContext("plannedAt", new Date().toISOString());
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy("");
    }
  }

  const plan = planFromContext(context);

  return (
    <div className="eh-migrator__step">
      <Text as="p">
        Reads how many rows each selected table holds per day, then lays out every command the migration will run.
        Nothing changes in the target until you start the migration.
      </Text>
      <div className="eh-migrator__row eh-migrator__row--start">
        <Button appearance="primary" disabled={Boolean(busy) || included.length === 0} onClick={analyze}>
          {context.histograms ? "Re-analyze" : "Analyze tables"}
        </Button>
        {busy && <Spinner size="tiny" label={busy} />}
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {plan && (
        <>
          <MessageBar intent={plan.ready ? "success" : "error"}>
            <MessageBarBody>
              <MessageBarTitle>{plan.ready ? "Ready to migrate" : "Resolve the errors below first"}</MessageBarTitle>
              {`${plan.totals.tables} table(s) · ${plan.totals.copies} daily copies · ` +
                `${plan.totals.rows.toLocaleString()} rows · ~${formatBytes(plan.totals.estimatedBytes)}`}
              {plan.window && (
                <div className="eh-migrator__muted">
                  {plan.window.from
                    ? `Incremental: rows that arrived in the source after ${new Date(plan.window.from).toLocaleString()} ` +
                      `and up to ${new Date(plan.window.to).toLocaleString()}.`
                    : `Everything that arrived in the source up to ${new Date(plan.window.to).toLocaleString()}. ` +
                      "Later syncs copy only what arrives after that."}
                </div>
              )}
            </MessageBarBody>
          </MessageBar>
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Merge policy</MessageBarTitle>
              Backdated extents are older than the default 14-day merge lookback, so each target table's merge lookback
              is widened for the duration of the copy and restored to its original afterwards, even if the run fails.
            </MessageBarBody>
          </MessageBar>

          <Accordion multiple collapsible>
            {plan.tables.map(table => {
              const days = table.copies.filter(c => c.day);
              const errors = table.issues.filter(i => i.severity === "error").length;
              return (
                <AccordionItem key={table.mapping.sourceTable} value={table.mapping.sourceTable}>
                  <AccordionHeader>
                    <span className="eh-migrator__plan-header">
                      <Text weight="semibold">{`${table.mapping.sourceTable} → ${table.mapping.targetTable}`}</Text>
                      <Badge appearance="tint" color={errors ? "danger" : "success"}>
                        {errors ? `${errors} error(s)` : `${table.copies.length} copies`}
                      </Badge>
                      {days.length > 0 && (
                        <Text className="eh-migrator__muted">{`${days[0].day} → ${days[days.length - 1].day}`}</Text>
                      )}
                    </span>
                  </AccordionHeader>
                  <AccordionPanel>
                    {table.issues.length > 0 && (
                      <ul className="eh-migrator__issues">
                        {table.issues.map((issue, i) => (
                          <li key={i} className={`eh-migrator__issue--${issue.severity}`}>{issue.message}</li>
                        ))}
                      </ul>
                    )}
                    <ul className="eh-migrator__plan-list">
                      {table.prepare.map(step => (
                        <li key={step.id}>{step.description}</li>
                      ))}
                      {table.mergeLookbackDays && <li>{`Merge lookback widened to ${table.mergeLookbackDays} days, then restored`}</li>}
                      <li>{`${days.length} daily copies, each stamped with its day as the extent creation time`}</li>
                    </ul>
                    {table.copies[0] && (
                      <>
                        <Text size={200} weight="semibold">First copy command</Text>
                        <pre className="eh-migrator__code">{table.copies[0].command}</pre>
                      </>
                    )}
                  </AccordionPanel>
                </AccordionItem>
              );
            })}
          </Accordion>
        </>
      )}
    </div>
  );
}
