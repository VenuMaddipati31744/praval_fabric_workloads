import React, { useEffect, useMemo, useState } from "react";
import {
  Dropdown,
  Field,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Spinner,
  Text
} from "@fluentui/react-components";

import { WizardStepProps } from "../../../components/Wizard/Wizard";
import { ConnectionClient } from "../../../clients/ConnectionClient";
import { Connection } from "../../../clients/FabricPlatformTypes";
import { buildMigrationPlan } from "../migration";
import { asMigratorContext } from "./WizardContext";

/**
 * Step 3: bind each mapped ASA input to a Fabric connection.
 *
 * ARM never returns Stream Analytics secrets, so credentials cannot be carried
 * over. The user selects an existing Fabric connection, or creates one in Fabric
 * and comes back. Selections are persisted in the item definition so re-running
 * a migration does not mean redoing this step.
 */
export function ConnectionsStep({ wizardContext, updateContext }: WizardStepProps) {
  const context = asMigratorContext(wizardContext);
  const connectionClient = useMemo(
    () => new ConnectionClient(context.workloadClient),
    [context.workloadClient]
  );

  const [connections, setConnections] = useState<Connection[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    connectionClient
      .getAllConnections()
      .then(result => {
        if (!cancelled) {
          setConnections(result);
        }
      })
      .catch(caught => {
        console.error("Failed to list Fabric connections:", caught);
        if (!cancelled) {
          setError(caught?.message || String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBusy(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [connectionClient]);

  // Only inputs that actually produced a source node need a connection.
  const sources = context.plan?.definition.sources || [];

  function assign(asaInputName: string, connectionId: string, displayName: string): void {
    const nextConnections = { ...(context.connections || {}), [asaInputName]: connectionId };
    const nextNames = { ...(context.connectionNames || {}), [asaInputName]: displayName };

    updateContext("connections", nextConnections);
    updateContext("connectionNames", nextNames);

    // Rebuild so the generated definition on the review step stays in step.
    if (context.job) {
      updateContext(
        "plan",
        buildMigrationPlan(context.job, {
          connections: nextConnections,
          targets: context.targets
        })
      );
    }
  }

  if (!context.plan) {
    return (
      <div className="stream-migrator__step">
        <Text as="p">Select a Stream Analytics job first.</Text>
      </div>
    );
  }

  if (sources.length === 0) {
    return (
      <div className="stream-migrator__step">
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>No sources to connect</MessageBarTitle>
            None of this job's inputs mapped to an Eventstream source. Review the assessment
            step for the reasons.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  return (
    <div className="stream-migrator__step">
      <Text as="p">
        Stream Analytics credentials cannot be read from Azure, so each source needs a Fabric
        connection. Create one in Fabric first if the list does not contain what you need.
      </Text>

      {busy && <Spinner size="tiny" label="Loading connections..." />}

      {sources.map(source => {
        // Source nodes are named "<input>-source"; recover the ASA input name.
        const asaInputName = source.name.replace(/-source$/, "");
        const selectedId = context.connections?.[asaInputName];
        const selectedName = context.connectionNames?.[asaInputName];

        return (
          <Field
            key={source.name}
            label={`${asaInputName} (${source.type})`}
            className="stream-migrator__field"
            required
          >
            <Dropdown
              placeholder={
                connections.length ? "Select a connection" : "No connections available"
              }
              value={selectedName || ""}
              selectedOptions={selectedId ? [selectedId] : []}
              onOptionSelect={(_, data) => {
                const match = connections.find(c => c.id === data.optionValue);
                assign(asaInputName, data.optionValue, match?.displayName || "");
              }}
            >
              {connections.map(connection => (
                <Option
                  key={connection.id}
                  value={connection.id}
                  text={connection.displayName}
                >
                  {connection.displayName} ({connection.connectionDetails?.type})
                </Option>
              ))}
            </Dropdown>
          </Field>
        );
      })}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not list connections</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}
