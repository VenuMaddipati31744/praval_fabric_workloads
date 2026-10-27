import React, { useEffect } from "react";
import {
  Button,
  Checkbox,
  Dropdown,
  Input,
  Option,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text
} from "@fluentui/react-components";

import { WizardStepProps } from "../../../components/Wizard/Wizard";
import { PolicyChoice, PolicyMode, SourceTable, TableMapping, datetimeColumns, defaultMapping, validateMapping } from "../engine";
import { asEhContext } from "./WizardContext";
import { formatBytes } from "./SourceStep";

const CREATE_NEW = "__create__";

function PolicyPicker({
  label,
  choice,
  sourceDays,
  targetDays,
  onChange
}: {
  label: string;
  choice: PolicyChoice;
  sourceDays?: number;
  targetDays?: number;
  onChange: (choice: PolicyChoice) => void;
}) {
  const labels: Record<PolicyMode, string> = {
    source: sourceDays !== undefined ? `From source (${sourceDays} d)` : "From source (not set)",
    custom: "Custom",
    keep: targetDays !== undefined ? `Keep target (${targetDays} d)` : "Keep target default"
  };
  return (
    <div className="eh-migrator__policy">
      <Dropdown
        aria-label={label}
        size="small"
        value={labels[choice.mode]}
        selectedOptions={[choice.mode]}
        onOptionSelect={(_, data) => onChange({ mode: data.optionValue as PolicyMode, days: choice.days ?? sourceDays })}
      >
        <Option value="source" disabled={sourceDays === undefined}>{labels.source}</Option>
        <Option value="custom">Custom</Option>
        <Option value="keep">{labels.keep}</Option>
      </Dropdown>
      {choice.mode === "custom" && (
        <Input
          aria-label={`${label} days`}
          size="small"
          type="number"
          min={1}
          value={choice.days === undefined ? "" : String(choice.days)}
          contentAfter={<Text size={200}>days</Text>}
          onChange={(_, data) => onChange({ mode: "custom", days: data.value === "" ? undefined : Number(data.value) })}
        />
      )}
    </div>
  );
}

/**
 * Step 3: one row per source table. Map it onto an existing target table or
 * auto-create one, pick the timestamp column for daily buckets, and choose the
 * retention and hot-cache policies.
 */
export function TablesStep({ wizardContext, updateContext }: WizardStepProps) {
  const context = asEhContext(wizardContext);
  const sources = context.sourceTables || [];
  const targets = context.targetTables || [];

  useEffect(() => {
    if (!context.mappings && sources.length > 0 && context.target) {
      updateContext("mappings", sources.map(source => defaultMapping(source, targets)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.mappings, sources.length, context.target]);

  const mappings = context.mappings || [];
  const update = (index: number, patch: Partial<TableMapping>) => {
    const next = mappings.map((mapping, i) => (i === index ? { ...mapping, ...patch } : mapping));
    updateContext("mappings", next);
    // Histograms depend on the chosen tables and timestamp columns.
    updateContext("histograms", undefined);
  };
  const setAll = (include: boolean) => {
    updateContext("mappings", mappings.map(mapping => ({ ...mapping, include })));
    updateContext("histograms", undefined);
  };

  if (!context.sourceDatabase || !context.target) {
    return (
      <div className="eh-migrator__step">
        <Text as="p">Choose the source database and the target KQL database first.</Text>
      </div>
    );
  }

  const included = mappings.filter(m => m.include).length;

  return (
    <div className="eh-migrator__step">
      <Text as="p">
        Every table in <b>{context.sourceDatabaseLabel || context.sourceDatabase}</b>. Data is copied one day at a time on the timestamp column, and
        each day's extents are stamped with that day as their creation time, so retention and the hot cache treat the
        data by its real age.
      </Text>
      <div className="eh-migrator__row eh-migrator__row--start">
        <Text>{`${included} of ${mappings.length} table(s) selected`}</Text>
        <Button size="small" onClick={() => setAll(true)}>Select all</Button>
        <Button size="small" onClick={() => setAll(false)}>Select none</Button>
      </div>

      <div className="eh-migrator__table-wrap">
        <Table size="small" aria-label="Source tables">
          <TableHeader>
            <TableRow>
              <TableHeaderCell className="eh-migrator__col-check" />
              <TableHeaderCell>Source table</TableHeaderCell>
              <TableHeaderCell>Target table</TableHeaderCell>
              <TableHeaderCell>Timestamp column</TableHeaderCell>
              <TableHeaderCell>Retention</TableHeaderCell>
              <TableHeaderCell>Hot cache</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {mappings.map((mapping, index) => {
              const source = sources.find(s => s.name === mapping.sourceTable) as SourceTable;
              const target = targets.find(t => t.name.toLowerCase() === mapping.targetTable.toLowerCase());
              const issues = validateMapping(mapping, source, target);
              const timestampOptions = datetimeColumns(source.columns);
              return (
                <React.Fragment key={mapping.sourceTable}>
                  <TableRow className={mapping.include ? undefined : "eh-migrator__row--excluded"}>
                    <TableCell className="eh-migrator__col-check">
                      <Checkbox
                        aria-label={`Include ${mapping.sourceTable}`}
                        checked={mapping.include}
                        onChange={(_, data) => update(index, { include: Boolean(data.checked) })}
                      />
                    </TableCell>
                    <TableCell>
                      <Text weight="semibold">{mapping.sourceTable}</Text>
                      <div className="eh-migrator__muted">
                        {`${source.rowCount.toLocaleString()} rows · ${formatBytes(source.originalSizeBytes)}`}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Dropdown
                        aria-label={`Target for ${mapping.sourceTable}`}
                        size="small"
                        disabled={!mapping.include}
                        value={mapping.mode === "create" ? "Auto-create new table" : mapping.targetTable}
                        selectedOptions={[mapping.mode === "create" ? CREATE_NEW : mapping.targetTable]}
                        onOptionSelect={(_, data) =>
                          data.optionValue === CREATE_NEW
                            ? update(index, { mode: "create", targetTable: mapping.sourceTable })
                            : update(index, { mode: "existing", targetTable: data.optionValue as string })
                        }
                      >
                        <Option value={CREATE_NEW}>Auto-create new table</Option>
                        {targets.map(t => (
                          <Option key={t.name} value={t.name}>{t.name}</Option>
                        ))}
                      </Dropdown>
                      {mapping.mode === "create" && (
                        <Input
                          aria-label={`New table name for ${mapping.sourceTable}`}
                          size="small"
                          disabled={!mapping.include}
                          value={mapping.targetTable}
                          onChange={(_, data) => update(index, { targetTable: data.value })}
                        />
                      )}
                    </TableCell>
                    <TableCell>
                      <Dropdown
                        aria-label={`Timestamp column for ${mapping.sourceTable}`}
                        size="small"
                        disabled={!mapping.include || timestampOptions.length === 0}
                        placeholder={timestampOptions.length ? "Choose column" : "No datetime column"}
                        value={mapping.timestampColumn || ""}
                        selectedOptions={mapping.timestampColumn ? [mapping.timestampColumn] : []}
                        onOptionSelect={(_, data) => update(index, { timestampColumn: data.optionValue })}
                      >
                        {timestampOptions.map(name => (
                          <Option key={name} value={name}>{name}</Option>
                        ))}
                      </Dropdown>
                    </TableCell>
                    <TableCell>
                      <PolicyPicker
                        label={`Retention for ${mapping.sourceTable}`}
                        choice={mapping.retention}
                        sourceDays={source.retentionDays}
                        targetDays={mapping.mode === "existing" ? target?.retentionDays : undefined}
                        onChange={retention => update(index, { retention })}
                      />
                    </TableCell>
                    <TableCell>
                      <PolicyPicker
                        label={`Hot cache for ${mapping.sourceTable}`}
                        choice={mapping.caching}
                        sourceDays={source.cacheDays}
                        targetDays={mapping.mode === "existing" ? target?.cacheDays : undefined}
                        onChange={caching => update(index, { caching })}
                      />
                    </TableCell>
                  </TableRow>
                  {mapping.include && issues.length > 0 && (
                    <TableRow className="eh-migrator__issues-row">
                      <TableCell />
                      <TableCell colSpan={5}>
                        <ul className="eh-migrator__issues">
                          {issues.map((issue, i) => (
                            <li key={i} className={`eh-migrator__issue--${issue.severity}`}>{issue.message}</li>
                          ))}
                        </ul>
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
