import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { NotificationType } from "@ms-fabric/workload-client";

import { PageProps, ContextProps } from "../../App";
import { ItemWithDefinition, getWorkloadItem, callGetItem, saveWorkloadItem } from "../../controller/ItemCRUDController";
import { callOpenSettings } from "../../controller/SettingsController";
import { callNotificationOpen } from "../../controller/NotificationController";
import { ItemEditor, useViewNavigation } from "../../components/ItemEditor";
import { EventhouseMigratorItemDefinition } from "./EventhouseMigratorItemDefinition";
import { EventhouseMigratorItemEmptyView } from "./EventhouseMigratorItemEmptyView";
import { EventhouseMigratorItemDefaultView } from "./EventhouseMigratorItemDefaultView";
import { EventhouseMigratorItemRunView } from "./EventhouseMigratorItemRunView";
import { EventhouseMigratorItemRibbon } from "./EventhouseMigratorItemRibbon";
import { EhWizardContext, planFromContext } from "./steps/WizardContext";
import { KustoClient } from "./kusto/KustoClient";
import { MigrationRunner, RunState, emptyRunState } from "./kusto/MigrationRunner";
import "./EventhouseMigratorItem.scss";

export const EH_VIEW_TYPES = {
  EMPTY: "empty",
  WIZARD: "default",
  RUN: "run"
} as const;

const enum SaveStatus {
  NotSaved = "NotSaved",
  Saving = "Saving",
  Saved = "Saved"
}

/** Run state is saved at most this often while a migration runs. */
const PERSIST_INTERVAL_MS = 4000;

/**
 * Editor for the Eventhouse Migrator item: plan in the wizard, then run and
 * verify in the run view. The run state is saved on the item as it progresses,
 * so a closed tab resumes where it stopped.
 */
export function EventhouseMigratorItemEditor(props: PageProps) {
  const { workloadClient } = props;
  const pageContext = useParams<ContextProps>();
  const { pathname } = useLocation();
  const { t } = useTranslation();

  const [isLoading, setIsLoading] = useState(true);
  const [item, setItem] = useState<ItemWithDefinition<EventhouseMigratorItemDefinition>>();
  const [definition, setDefinition] = useState<EventhouseMigratorItemDefinition>({});
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(SaveStatus.NotSaved);
  const [viewSetter, setViewSetter] = useState<((view: string) => void) | null>(null);
  const [run, setRun] = useState<RunState>(emptyRunState());
  const [running, setRunning] = useState(false);

  const runnerRef = useRef<MigrationRunner | null>(null);
  const latestRef = useRef<EventhouseMigratorItemDefinition>({});
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    async function load() {
      if (!pageContext.itemObjectId || (item && item.id === pageContext.itemObjectId)) {
        setIsLoading(false);
        return;
      }
      setIsLoading(true);
      try {
        const loaded = await getWorkloadItem<EventhouseMigratorItemDefinition>(workloadClient, pageContext.itemObjectId);
        const loadedDefinition = loaded.definition || {};
        setItem({ ...loaded, definition: loadedDefinition });
        setDefinition(loadedDefinition);
        latestRef.current = loadedDefinition;
        // A run interrupted by a closed tab shows as stopped, ready to resume.
        const saved = loadedDefinition.run;
        setRun(saved ? { ...saved, phase: ["done", "failed", "idle"].includes(saved.phase) ? saved.phase : "stopped" } : emptyRunState());
        setSaveStatus(loaded.definition ? SaveStatus.Saved : SaveStatus.NotSaved);
      } catch (error) {
        console.error("Failed to load Eventhouse Migrator item:", error);
        setItem(undefined);
      }
      setIsLoading(false);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageContext, pathname]);

  // Warn before closing the tab mid-run; progress is saved, but in-flight polling stops.
  useEffect(() => {
    if (!running) {
      return undefined;
    }
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [running]);

  async function persist(next: EventhouseMigratorItemDefinition, options: { notify?: boolean } = {}): Promise<boolean> {
    if (!item) {
      return false;
    }
    setSaveStatus(SaveStatus.Saving);
    let saved = false;
    let message = "";
    try {
      saved = Boolean(await saveWorkloadItem<EventhouseMigratorItemDefinition>(workloadClient, { ...item, definition: next }));
    } catch (error) {
      message = error?.message;
    }
    if (saved) {
      item.definition = next;
      setDefinition(next);
      setSaveStatus(SaveStatus.Saved);
      if (options.notify) {
        callNotificationOpen(workloadClient, t("ItemEditor_Saved_Notification_Title"),
          t("ItemEditor_Saved_Notification_Text", { itemName: item.displayName }), undefined, undefined);
      }
    } else {
      setSaveStatus(SaveStatus.NotSaved);
      callNotificationOpen(workloadClient, t("ItemEditor_SaveFailed_Notification_Title"),
        `${t("ItemEditor_SaveFailed_Notification_Text", { itemName: item.displayName })} ${message || ""}`.trim(),
        NotificationType.Error, undefined);
    }
    return saved;
  }

  function schedulePersist(state: RunState, immediate = false) {
    latestRef.current = { ...latestRef.current, run: state };
    if (persistTimer.current) {
      if (!immediate) {
        return;
      }
      clearTimeout(persistTimer.current);
    }
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null;
      persist(latestRef.current);
    }, immediate ? 0 : PERSIST_INTERVAL_MS);
  }

  const plan = useMemo(
    () => planFromContext({ workloadClient, ...definition } as EhWizardContext),
    [definition, workloadClient]
  );

  async function savePlan(context: EhWizardContext) {
    const next: EventhouseMigratorItemDefinition = {
      ...definition,
      sourceClusterUri: context.sourceClusterUri,
      sourceDatabase: context.sourceDatabase,
      target: context.target,
      sourceTables: context.sourceTables,
      targetTables: context.targetTables,
      mappings: context.mappings,
      histograms: context.histograms,
      plannedAt: context.plannedAt,
      // Copy ids are stable per table and day, so progress carries over to an edited plan.
      run: definition.run || emptyRunState()
    };
    latestRef.current = next;
    if (await persist(next)) {
      viewSetter?.(EH_VIEW_TYPES.RUN);
    }
  }

  async function startRun() {
    if (!plan || !definition.target || !definition.sourceClusterUri) {
      return;
    }
    const runner = new MigrationRunner(plan, run, {
      source: new KustoClient(workloadClient, definition.sourceClusterUri),
      target: new KustoClient(workloadClient, definition.target.queryServiceUri),
      targetDatabase: definition.target.databaseName,
      onState: state => {
        setRun(state);
        schedulePersist(state);
      }
    });
    runnerRef.current = runner;
    setRunning(true);
    try {
      const final = await runner.run();
      schedulePersist(final, true);
      callNotificationOpen(
        workloadClient,
        final.phase === "done" ? "Migration complete" : final.phase === "stopped" ? "Migration stopped" : "Migration finished with errors",
        final.phase === "done" ? "All daily buckets were copied and verified." : "Open the item to resume.",
        final.phase === "done" ? undefined : NotificationType.Warning,
        undefined
      );
    } finally {
      runnerRef.current = null;
      setRunning(false);
    }
  }

  const handleOpenSettings = async () => {
    if (item) {
      const result = await callGetItem(workloadClient, item.id);
      await callOpenSettings(workloadClient, result.item, "About");
    }
  };

  const EmptyViewWrapper = () => {
    const { setCurrentView } = useViewNavigation();
    return <EventhouseMigratorItemEmptyView onStart={() => setCurrentView(EH_VIEW_TYPES.WIZARD)} />;
  };

  const WizardViewWrapper = () => {
    const { setCurrentView } = useViewNavigation();
    return (
      <EventhouseMigratorItemDefaultView
        workloadClient={workloadClient}
        definition={definition}
        onWizardComplete={savePlan}
        onWizardCancel={() => setCurrentView(plan ? EH_VIEW_TYPES.RUN : EH_VIEW_TYPES.EMPTY)}
      />
    );
  };

  const RunViewWrapper = () => {
    const { setCurrentView } = useViewNavigation();
    return (
      <EventhouseMigratorItemRunView
        plan={plan}
        run={run}
        running={running}
        sourceLabel={`${definition.sourceClusterUri || ""} / ${definition.sourceDatabase || ""}`}
        targetLabel={definition.target ? `${definition.target.displayName}` : ""}
        onStart={startRun}
        onStop={() => runnerRef.current?.stop()}
        onEditPlan={() => setCurrentView(EH_VIEW_TYPES.WIZARD)}
      />
    );
  };

  const views = [
    { name: EH_VIEW_TYPES.EMPTY, component: <EmptyViewWrapper /> },
    { name: EH_VIEW_TYPES.WIZARD, component: <WizardViewWrapper /> },
    { name: EH_VIEW_TYPES.RUN, component: <RunViewWrapper /> }
  ];

  useEffect(() => {
    if (!isLoading && item && viewSetter) {
      viewSetter(definition.histograms ? EH_VIEW_TYPES.RUN : definition.sourceClusterUri ? EH_VIEW_TYPES.WIZARD : EH_VIEW_TYPES.EMPTY);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, item, viewSetter]);

  return (
    <ItemEditor
      isLoading={isLoading}
      loadingMessage={t("EventhouseMigratorItemEditor_Loading", "Loading item...")}
      ribbon={context => (
        <EventhouseMigratorItemRibbon
          {...props}
          viewContext={context}
          isSaveButtonEnabled={saveStatus !== SaveStatus.Saved && !running}
          saveItemCallback={async () => {
            await persist(latestRef.current, { notify: true });
          }}
          openSettingsCallback={handleOpenSettings}
        />
      )}
      views={views}
      viewSetter={setCurrentView => {
        if (!viewSetter) {
          setViewSetter(() => setCurrentView);
        }
      }}
    />
  );
}
