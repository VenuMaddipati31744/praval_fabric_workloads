import React, { useState } from "react";
import {
  Button,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Spinner,
  Text
} from "@fluentui/react-components";

import { WizardStepProps } from "../../../components/Wizard/Wizard";
import { DETAILS_COMMAND, SCHEMA_COMMAND, buildSourceTables, normalizeClusterUri } from "../engine";
import { KustoClient } from "../kusto/KustoClient";
import { asEhContext } from "./WizardContext";

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Step 1: the source ADX cluster and database. Reads run as the signed-in user. */
export function SourceStep({ wizardContext, updateContext }: WizardStepProps) {
  const context = asEhContext(wizardContext);
  const [uri, setUri] = useState(context.sourceClusterUri || "");
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState<string>("");

  async function attempt(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (caught) {
      setError(caught?.message || String(caught));
    } finally {
      setBusy("");
    }
  }

  const connect = () =>
    attempt("Connecting...", async () => {
      const clusterUri = normalizeClusterUri(uri);
      setUri(clusterUri);
      const rows = await new KustoClient(context.workloadClient, clusterUri).mgmt("NetDefaultDB", ".show databases");
      updateContext("sourceClusterUri", clusterUri);
      updateContext("sourceDatabases", rows.map(row => String(row.DatabaseName)).filter(Boolean).sort());
      updateContext("sourceDatabase", undefined);
      updateContext("sourceTables", undefined);
      updateContext("mappings", undefined);
      updateContext("histograms", undefined);
    });

  const selectDatabase = (database: string) =>
    attempt("Reading tables...", async () => {
      const client = new KustoClient(context.workloadClient, context.sourceClusterUri as string);
      const [schema, details] = await Promise.all([client.mgmt(database, SCHEMA_COMMAND), client.mgmt(database, DETAILS_COMMAND)]);
      updateContext("sourceDatabase", database);
      updateContext("sourceTables", buildSourceTables(schema as any, details as any));
      updateContext("mappings", undefined);
      updateContext("histograms", undefined);
    });

  const tables = context.sourceTables || [];
  const totalRows = tables.reduce((sum, t) => sum + t.rowCount, 0);
  const totalBytes = tables.reduce((sum, t) => sum + t.originalSizeBytes, 0);

  return (
    <div className="eh-migrator__step">
      <Text as="p">
        Connect to the Azure Data Explorer cluster to migrate from. Tables, schemas and policies are read with your
        identity; the copy itself runs inside the Eventhouse and pulls from this cluster as you.
      </Text>

      <Field label="Cluster URI" className="eh-migrator__field" required hint="e.g. https://mycluster.westeurope.kusto.windows.net">
        <div className="eh-migrator__row">
          <Input value={uri} onChange={(_, data) => setUri(data.value)} placeholder="https://<cluster>.<region>.kusto.windows.net" />
          <Button appearance="primary" disabled={!uri.trim() || Boolean(busy)} onClick={connect}>
            Connect
          </Button>
        </div>
      </Field>

      {context.sourceDatabases && (
        <Field label="Database" className="eh-migrator__field" required>
          <Dropdown
            placeholder="Select a database"
            value={context.sourceDatabase || ""}
            selectedOptions={context.sourceDatabase ? [context.sourceDatabase] : []}
            disabled={Boolean(busy)}
            onOptionSelect={(_, data) => data.optionValue && selectDatabase(data.optionValue)}
          >
            {context.sourceDatabases.map(name => (
              <Option key={name} value={name}>{name}</Option>
            ))}
          </Dropdown>
        </Field>
      )}

      {busy && <Spinner size="tiny" label={busy} />}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Couldn't read the cluster</MessageBarTitle>
            {error} Check that you have viewer access to the database, that the workload's Entra app is consented for
            Azure Data Explorer, and, for a cluster in another tenant, that it trusts this tenant.
          </MessageBarBody>
        </MessageBar>
      )}

      {context.sourceDatabase && (
        <div className="eh-migrator__summary">
          <Text weight="semibold">{`${tables.length} table(s)`}</Text>
          <Text>{` · ${totalRows.toLocaleString()} rows · ${formatBytes(totalBytes)} uncompressed`}</Text>
        </div>
      )}
    </div>
  );
}

export { formatBytes };
