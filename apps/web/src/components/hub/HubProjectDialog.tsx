import type {
  EnvironmentId,
  HubAutonomy,
  HubJobKind,
  HubLane,
  HubPriority,
  HubProjectStatus,
  HubProjectView,
  HubSdlcMode,
  HubSdlcStage,
  HubStrategyPriority,
} from "@t3tools/contracts";
import { useId, useState, type FormEvent, type ReactNode } from "react";

import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  AUTONOMY_OPTIONS,
  PRIORITY_OPTIONS,
  STATUS_OPTIONS,
  autonomyHint,
  labelOf,
  stageOptions,
  stageSelectValue,
} from "./hubFormat";
import { useHubAction } from "./useHubAction";

/** Create or edit a project. The form stays open and keeps its input if saving fails. */
export function HubProjectDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly nodeName: string;
  readonly view: HubProjectView | null;
  readonly strategy: ReadonlyArray<HubStrategyPriority>;
  readonly sdlcMode: HubSdlcMode;
  readonly onClose: () => void;
}) {
  const project = props.view?.project ?? null;
  const stages = stageOptions(props.sdlcMode);
  const formId = useId();
  const [name, setName] = useState(project?.name ?? "");
  const [autonomy, setAutonomy] = useState<HubAutonomy>(project?.autonomy ?? 0);
  const [strategyId, setStrategyId] = useState(project?.strategyId ?? "");
  const [priority, setPriority] = useState<HubPriority>(project?.priority ?? "medium");
  const [status, setStatus] = useState<HubProjectStatus>(project?.status ?? "active");
  const [stage, setStage] = useState<HubSdlcStage>(
    project ? stageSelectValue(project.stage, props.sdlcMode) : (stages[0]?.value ?? "plan"),
  );
  const [localPath, setLocalPath] = useState(props.view?.localPath ?? "");
  const [repoUrl, setRepoUrl] = useState(project?.repoUrl ?? "");
  const [category, setCategory] = useState(project?.category ?? "");
  const [tags, setTags] = useState(project?.tags.join(", ") ?? "");
  const [notes, setNotes] = useState(project?.notes ?? "");
  const [reviewBudget, setReviewBudget] = useState(String(project?.reviewBudget ?? 2));
  const [favorite, setFavorite] = useState(project?.favorite ?? false);
  const [archived, setArchived] = useState(project?.archived ?? false);
  const [lane, setLane] = useState<HubLane | "">(project?.lane ?? "");
  const [jobKind, setJobKind] = useState<HubJobKind>(project?.jobKind ?? "dev");
  const [details, setDetails] = useState(
    project !== null &&
      (project.notes !== "" ||
        project.tags.length > 0 ||
        project.category !== null ||
        project.repoUrl !== null ||
        project.lane !== null ||
        project.favorite ||
        project.archived ||
        project.jobKind !== "dev" ||
        project.reviewBudget !== 2),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useHubAction(
    serverEnvironment.hubUpsertProject,
    props.environmentId,
    "Could not save the project",
  );
  const remove = useHubAction(
    serverEnvironment.hubDeleteProject,
    props.environmentId,
    "Could not delete the project",
  );

  const trimmedOrNull = (value: string) => (value.trim() === "" ? null : value.trim());
  const budget = Number.parseInt(reviewBudget, 10);
  const invalid = name.trim() === "" || !Number.isInteger(budget) || budget < 0;
  const strategyOptions = [
    { value: "", label: "None" },
    ...props.strategy.map((priorityItem) => ({
      value: priorityItem.id,
      label: priorityItem.title,
    })),
  ];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (invalid || save.busy) return;
    const result = await save.run({
      ...(project ? { id: project.id } : {}),
      name: name.trim(),
      autonomy,
      strategyId: strategyId === "" ? null : strategyId,
      priority,
      status,
      stage,
      localPath: trimmedOrNull(localPath),
      repoUrl: trimmedOrNull(repoUrl),
      category: trimmedOrNull(category),
      tags: tags
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag !== ""),
      notes,
      reviewBudget: budget,
      favorite,
      archived,
      lane: lane === "" ? null : lane,
      jobKind,
    });
    if (result) props.onClose();
  };
  const destroy = async () => {
    if (!project) return;
    const result = await remove.run({ id: project.id });
    if (result) props.onClose();
  };

  const field = (id: string, label: string, control: ReactNode) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${formId}-${id}`}>{label}</Label>
      {control}
    </div>
  );

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{project ? project.name : "Add project"}</DialogTitle>
          <DialogDescription>{autonomyHint(autonomy)}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            onSubmit={(event) => void submit(event)}
            className="flex flex-col gap-4"
          >
            {field(
              "name",
              "Name",
              <Input
                id={`${formId}-name`}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />,
            )}
            {field(
              "autonomy",
              "Autonomy",
              <Choice
                id={`${formId}-autonomy`}
                value={autonomy}
                options={AUTONOMY_OPTIONS}
                onChange={setAutonomy}
              />,
            )}
            {field(
              "strategy",
              "Strategy",
              <Choice
                id={`${formId}-strategy`}
                value={strategyId}
                options={strategyOptions}
                onChange={setStrategyId}
              />,
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              {field(
                "priority",
                "Priority",
                <Choice
                  id={`${formId}-priority`}
                  value={priority}
                  options={PRIORITY_OPTIONS}
                  onChange={setPriority}
                />,
              )}
              {field(
                "status",
                "Status",
                <Choice
                  id={`${formId}-status`}
                  value={status}
                  options={STATUS_OPTIONS}
                  onChange={setStatus}
                />,
              )}
            </div>
            {field(
              "stage",
              "Stage",
              <Choice id={`${formId}-stage`} value={stage} options={stages} onChange={setStage} />,
            )}
            {field(
              "path",
              `Checkout on ${props.nodeName}`,
              <Input
                id={`${formId}-path`}
                placeholder="/Users/you/Projects/my-app"
                value={localPath}
                onChange={(event) => setLocalPath(event.target.value)}
              />,
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost-muted"
              className="self-start"
              aria-expanded={details}
              onClick={() => setDetails((current) => !current)}
            >
              {details ? "Hide details" : "Details"}
            </Button>
            {details ? (
              <>
                {field(
                  "repo",
                  "Repository URL",
                  <Input
                    id={`${formId}-repo`}
                    value={repoUrl}
                    onChange={(event) => setRepoUrl(event.target.value)}
                  />,
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  {field(
                    "lane",
                    "Lane",
                    <Choice
                      id={`${formId}-lane`}
                      value={lane}
                      options={[
                        { value: "" as const, label: "None" },
                        { value: "immersion" as const, label: "Immersion" },
                        { value: "automation" as const, label: "Automation" },
                        { value: "publicity" as const, label: "Publicity" },
                      ]}
                      onChange={setLane}
                    />,
                  )}
                  {field(
                    "job",
                    "Job kind",
                    <Choice
                      id={`${formId}-job`}
                      value={jobKind}
                      options={[
                        { value: "dev" as const, label: "Dev" },
                        { value: "edit" as const, label: "Edit" },
                        { value: "writing" as const, label: "Writing" },
                        { value: "image" as const, label: "Image" },
                      ]}
                      onChange={setJobKind}
                    />,
                  )}
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {field(
                    "category",
                    "Category",
                    <Input
                      id={`${formId}-category`}
                      value={category}
                      onChange={(event) => setCategory(event.target.value)}
                    />,
                  )}
                  {field(
                    "budget",
                    "Review budget",
                    <Input
                      id={`${formId}-budget`}
                      type="number"
                      min={0}
                      inputMode="numeric"
                      value={reviewBudget}
                      onChange={(event) => setReviewBudget(event.target.value)}
                    />,
                  )}
                </div>
                {field(
                  "tags",
                  "Tags",
                  <Input
                    id={`${formId}-tags`}
                    placeholder="Web, Bot"
                    value={tags}
                    onChange={(event) => setTags(event.target.value)}
                  />,
                )}
                {field(
                  "notes",
                  "Notes for agents",
                  <Textarea
                    id={`${formId}-notes`}
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                  />,
                )}
                <div className="flex flex-wrap gap-6">
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <Switch
                      aria-label="Favourite"
                      checked={favorite}
                      onCheckedChange={setFavorite}
                    />
                    Favourite
                  </label>
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <Switch
                      aria-label="Archived"
                      checked={archived}
                      onCheckedChange={setArchived}
                    />
                    Archived
                  </label>
                </div>
              </>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          {project ? (
            confirmDelete ? (
              <div className="me-auto flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Delete from every machine?</span>
                <Button size="sm" variant="ghost-muted" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={remove.busy}
                  aria-busy={remove.busy}
                  onClick={() => void destroy()}
                >
                  {remove.busy ? "Deleting…" : "Delete"}
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost-destructive"
                className="me-auto"
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
            )
          ) : null}
          <Button size="sm" variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            type="submit"
            form={formId}
            disabled={invalid || save.busy}
            aria-busy={save.busy}
          >
            {save.busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Choice<V extends string | number>(props: {
  readonly id: string;
  readonly value: V;
  readonly options: ReadonlyArray<{ value: V; label: string }>;
  readonly onChange: (value: V) => void;
}) {
  return (
    <Select
      value={props.value}
      onValueChange={(next) => {
        if (next !== null && next !== props.value) props.onChange(next as V);
      }}
    >
      <SelectTrigger id={props.id}>
        <SelectValue>{labelOf(props.options, props.value)}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {props.options.map((option) => (
          <SelectItem key={String(option.value)} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
