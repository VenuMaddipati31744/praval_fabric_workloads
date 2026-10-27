import React, { useState } from "react";
import { Button, Field, Input, MessageBar, MessageBarBody, Spinner, Text } from "@fluentui/react-components";

import { WizardStepProps } from "../../../components/Wizard/Wizard";
import { callDatahubOpen } from "../../../controller/DataHubController";
import { DETAILS_COMMAND, SCHEMA_COMMAND, buildTargetTables } from "../engine";
import { KustoClient, describeError, getKqlDatabase } from "../kusto/KustoClient";
import { asEhContext } from "./WizardContext";

/** Step 2: the target KQL database in an Eventhouse. */
export function TargetStep({ wizardContext, updateContext }: WizardStepProps) {
  const context = asEhContext(wizardContext);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function browse() {
    setError("");
    try {
      const picked = await callDatahubOpen(
        context.workloadClient,
        ["KustoDatabase"],
        "Select the KQL database to migrate into",
        false
      );
      if (!picked) {
        return;
      }
      setBusy("Reading the KQL database...");
      const info = await getKqlDatabase(context.workloadClient, picked.workspaceId, picked.id);
      if (!info.queryServiceUri) {
        throw new Error("The KQL database has no query URI.");
      }
      const client = new KustoClient(context.workloadClient, info.queryServiceUri);
      const [schema, details] = await Promise.all([
        client.mgmt(info.databaseName, SCHEMA_COMMAND),
        client.mgmt(info.databaseName, DETAILS_COMMAND)
      ]);
      updateContext("target", {
        workspaceId: info.workspaceId,
        itemId: info.id,
        displayName: info.displayName,
        queryServiceUri: info.queryServiceUri,
        databaseName: info.databaseName
      });
      updateContext("targetTables", buildTargetTables(schema as any, details as any));
      updateContext("mappings", undefined);
      updateContext("histograms", undefined);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="eh-migrator__step">
      <Text as="p">
        Choose the KQL database to migrate into. Existing tables can be filled; any others are created from the
        source schema.
      </Text>
      <Field label="Target KQL database" className="eh-migrator__field" required>
        <div className="eh-migrator__row">
          <Input readOnly value={context.target?.displayName || ""} placeholder="No database selected" />
          <Button disabled={Boolean(busy)} onClick={browse}>Browse...</Button>
        </div>
      </Field>
      {busy && <Spinner size="tiny" label={busy} />}
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      {context.target && (
        <div className="eh-migrator__summary">
          <Text weight="semibold">{context.target.databaseName}</Text>
          <Text>{` · ${(context.targetTables || []).length} existing table(s)`}</Text>
          <div className="eh-migrator__muted">{context.target.queryServiceUri}</div>
        </div>
      )}
    </div>
  );
}
