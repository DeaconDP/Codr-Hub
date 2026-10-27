import type { EnvironmentId, HubProjectView } from "@t3tools/contracts";
import { useId, useState, type FormEvent } from "react";

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
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { useHubAction } from "./useHubAction";

/** Create or edit a project. The form stays open and keeps its input if saving fails. */
export function HubProjectDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly nodeName: string;
  readonly view: HubProjectView | null;
  readonly onClose: () => void;
}) {
  const project = props.view?.project ?? null;
  const thisHost = project?.hosts[props.nodeName];
  const formId = useId();
  const [name, setName] = useState(project?.name ?? "");
  const [localPath, setLocalPath] = useState(props.view?.localPath ?? "");
  const [stickyPort, setStickyPort] = useState(
    thisHost?.stickyPort !== null && thisHost?.stickyPort !== undefined
      ? String(thisHost.stickyPort)
      : "",
  );
  const [launchCmd, setLaunchCmd] = useState(thisHost?.launchCmd ?? "");
  const [repoUrl, setRepoUrl] = useState(project?.repoUrl ?? "");
  const [previewUrl, setPreviewUrl] = useState(project?.previewUrl ?? "");
  const [liveUrl, setLiveUrl] = useState(project?.liveUrl ?? "");
  const [siteId, setSiteId] = useState(project?.siteId ?? "");
  const [surface, setSurface] = useState(project?.surface ?? "");
  const [category, setCategory] = useState(project?.category ?? "");
  const [tags, setTags] = useState(project?.tags.join(", ") ?? "");
  const [notes, setNotes] = useState(project?.notes ?? "");
  const [reviewBudget, setReviewBudget] = useState(String(project?.reviewBudget ?? 2));
  const [favorite, setFavorite] = useState(project?.favorite ?? false);
  const [archived, setArchived] = useState(project?.archived ?? false);
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
  const portTrimmed = stickyPort.trim();
  const portValue = portTrimmed === "" ? null : Number.parseInt(portTrimmed, 10);
  const invalid =
    name.trim() === "" ||
    !Number.isInteger(budget) ||
    budget < 0 ||
    (portTrimmed !== "" && (!Number.isInteger(portValue) || (portValue ?? 0) < 0));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (invalid || save.busy) return;
    const result = await save.run({
      ...(project ? { id: project.id } : {}),
      name: name.trim(),
      localPath: trimmedOrNull(localPath),
      stickyPort: portValue,
      launchCmd: trimmedOrNull(launchCmd),
      repoUrl: trimmedOrNull(repoUrl),
      previewUrl: trimmedOrNull(previewUrl),
      liveUrl: trimmedOrNull(liveUrl),
      siteId: trimmedOrNull(siteId),
      surface: trimmedOrNull(surface),
      category: trimmedOrNull(category),
      tags: tags
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag !== ""),
      notes,
      reviewBudget: budget,
      favorite,
      archived,
    });
    if (result) props.onClose();
  };
  const destroy = async () => {
    if (!project) return;
    const result = await remove.run({ id: project.id });
    if (result) props.onClose();
  };

  const field = (id: string, label: string, control: React.ReactNode, hint?: string) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${formId}-${id}`}>{label}</Label>
      {control}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{project ? project.name : "Add project"}</DialogTitle>
          <DialogDescription>
            Saved to the portfolio repo and shared with every node.
          </DialogDescription>
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
              "path",
              `Checkout on ${props.nodeName}`,
              <Input
                id={`${formId}-path`}
                placeholder="/Users/you/Projects/my-app"
                value={localPath}
                onChange={(event) => setLocalPath(event.target.value)}
              />,
              "Each node keeps its own path. The autopilot only works on projects checked out here.",
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              {field(
                "stickyPort",
                `Sticky port on ${props.nodeName}`,
                <Input
                  id={`${formId}-stickyPort`}
                  type="number"
                  min={0}
                  inputMode="numeric"
                  placeholder="5173"
                  value={stickyPort}
                  onChange={(event) => setStickyPort(event.target.value)}
                />,
              )}
              {field(
                "launchCmd",
                `Launch command on ${props.nodeName}`,
                <Input
                  id={`${formId}-launchCmd`}
                  placeholder="npm run dev"
                  value={launchCmd}
                  onChange={(event) => setLaunchCmd(event.target.value)}
                />,
              )}
            </div>
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
                "previewUrl",
                "Preview site",
                <Input
                  id={`${formId}-previewUrl`}
                  placeholder="https://preview.example"
                  value={previewUrl}
                  onChange={(event) => setPreviewUrl(event.target.value)}
                />,
              )}
              {field(
                "liveUrl",
                "Live site",
                <Input
                  id={`${formId}-liveUrl`}
                  placeholder="https://example.com"
                  value={liveUrl}
                  onChange={(event) => setLiveUrl(event.target.value)}
                />,
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {field(
                "siteId",
                "Site id",
                <Input
                  id={`${formId}-siteId`}
                  placeholder="product-family"
                  value={siteId}
                  onChange={(event) => setSiteId(event.target.value)}
                />,
              )}
              {field(
                "surface",
                "Surface",
                <Input
                  id={`${formId}-surface`}
                  placeholder="site"
                  value={surface}
                  onChange={(event) => setSurface(event.target.value)}
                />,
                "Product face (ios, site, …), not the T3 client surface.",
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
                "Autopilot threads that may wait for review at once.",
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
              "Comma separated.",
            )}
            {field(
              "notes",
              "Notes for agents",
              <Textarea
                id={`${formId}-notes`}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />,
              "Included in every autopilot prompt for this project.",
            )}
            <div className="flex flex-wrap gap-6">
              <label className="flex items-center gap-2 text-sm">
                <Switch aria-label="Favourite" checked={favorite} onCheckedChange={setFavorite} />
                Favourite
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch aria-label="Archived" checked={archived} onCheckedChange={setArchived} />
                Archived
              </label>
            </div>
          </form>
        </DialogPanel>
        <DialogFooter>
          {project ? (
            confirmDelete ? (
              <div className="me-auto flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Delete from every node?</span>
                <Button size="sm" variant="ghost-muted" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={remove.busy}
                  onClick={() => void destroy()}
                >
                  Delete
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost-destructive"
                className="me-auto"
                onClick={() => setConfirmDelete(true)}
              >
                Delete…
              </Button>
            )
          ) : null}
          <Button size="sm" variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button size="sm" type="submit" form={formId} disabled={invalid || save.busy}>
            {save.busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
