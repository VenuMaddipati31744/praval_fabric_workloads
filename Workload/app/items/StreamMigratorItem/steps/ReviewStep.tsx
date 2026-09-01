import React from "react";
import {
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Text
} from "@fluentui/react-components";

import { WizardStepProps } from "../../../components/Wizard/Wizard";
import { asMigratorContext } from "./WizardContext";
import { getMigrationReadiness } from "./readiness";

/**
 * Step 5: name the Eventstream and review the definition that will be created.
 *
 * The generated eventstream.json is shown verbatim. Completing the wizard saves
 * the plan and creates the Eventstream in this item's workspace.
 */
export function ReviewStep({ wizardContext, updateContext }: WizardStepProps) {
  const context = asMigratorContext(wizardContext);
  const plan = context.plan;

  if (!plan) {
    return (
      <div className="stream-migrator__step">
        <Text as="p">Select a Stream Analytics job first.</Text>
      </div>
    );
  }

  const readiness = getMigrationReadiness(context);

  return (
    <div className="stream-migrator__step">
      <Field label="Eventstream name" className="stream-migrator__field" required>
        <Input
          value={context.eventstreamName || ""}
          placeholder="Name for the new Eventstream item"
          onChange={(_, data) => updateContext("eventstreamName", data.value)}
        />
      </Field>

      {context.alreadyCreatedEventstreamId && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>This job has already been migrated</MessageBarTitle>
            Completing the wizard again creates an additional Eventstream rather than
            updating the existing one. Delete the previous Eventstream first if you meant
            to replace it.
          </MessageBarBody>
        </MessageBar>
      )}

      {readiness.ready ? (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>Ready to migrate</MessageBarTitle>
            {`Creating this Eventstream will add ${plan.definition.sources.length} source(s), ` +
              `${plan.definition.operators.length} operator(s) and ` +
              `${plan.definition.destinations.length} destination(s) to this workspace.`}
          </MessageBarBody>
        </MessageBar>
      ) : (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Not ready yet</MessageBarTitle>
            <ul className="stream-migrator__problems">
              {readiness.problems.map((problem, index) => (
                <li key={index}>{problem}</li>
              ))}
            </ul>
          </MessageBarBody>
        </MessageBar>
      )}

      <Text as="p" weight="semibold">
        Generated eventstream.json
      </Text>
      <pre className="stream-migrator__json">
        {JSON.stringify(plan.definition, null, 2)}
      </pre>
    </div>
  );
}
