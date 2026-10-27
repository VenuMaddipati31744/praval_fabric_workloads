import React from "react";
import { useTranslation } from "react-i18next";

import { ItemEditorEmptyView, EmptyStateTask } from "../../components/ItemEditor";
import "./EventhouseMigratorItem.scss";

export interface EventhouseMigratorItemEmptyViewProps {
  onStart: () => void;
}

/** First screen for a newly created Eventhouse Migrator item. */
export function EventhouseMigratorItemEmptyView({ onStart }: EventhouseMigratorItemEmptyViewProps) {
  const { t } = useTranslation();

  const tasks: EmptyStateTask[] = [
    {
      id: "plan-migration",
      label: t("EventhouseMigratorItemEmptyView_Start", "Plan a migration"),
      description: t(
        "EventhouseMigratorItemEmptyView_Start_Description",
        "Pick an Azure Data Explorer database, map its tables and policies, and copy the data day by day."
      ),
      onClick: onStart
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
