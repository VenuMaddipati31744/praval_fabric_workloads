import React from "react";
import { PageProps } from "../../App";
import { Ribbon, RibbonAction, createSaveAction, createSettingsAction } from "../../components/ItemEditor";
import { ViewContext } from "../../components";

export interface EventhouseMigratorItemRibbonProps extends PageProps {
  viewContext: ViewContext;
  isSaveButtonEnabled?: boolean;
  saveItemCallback: () => Promise<void>;
  openSettingsCallback: () => Promise<void>;
}

/** Ribbon for the Eventhouse Migrator item, built from the standard action factories. */
export function EventhouseMigratorItemRibbon(props: EventhouseMigratorItemRibbonProps) {
  const homeToolbarActions: RibbonAction[] = [
    createSaveAction(props.saveItemCallback, !props.isSaveButtonEnabled),
    createSettingsAction(props.openSettingsCallback)
  ];
  return <Ribbon homeToolbarActions={homeToolbarActions} viewContext={props.viewContext} />;
}
