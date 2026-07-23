import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Globe2, GripVertical, Plus, Route, Trash2 } from "lucide-react";
import { FieldHelp } from "./FieldHelp";

let draftSequence = 0;

function draftId(prefix: string): string {
  draftSequence += 1;
  return `${prefix}-${draftSequence}`;
}

export type DraftRoute = {
  key: string;
  path: string;
  serviceUrl: string;
};

export type DraftPublication = {
  key: string;
  suffix: string;
  routes: DraftRoute[];
};

export function createDraftPublication(serviceUrl = ""): DraftPublication {
  return {
    key: draftId("publication"),
    suffix: "",
    routes: [{ key: draftId("route"), path: "/", serviceUrl }]
  };
}

export function validatePublications(publications: DraftPublication[]): string | null {
  if (publications.length === 0) return "Add at least one subdomain";
  const suffixes = new Set<string>();
  for (const publication of publications) {
    const suffix = publication.suffix.trim().toLowerCase();
    if (suffixes.has(suffix)) return "Each subdomain suffix must be unique";
    suffixes.add(suffix);
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?)?$/.test(suffix)) {
      return "Suffixes can contain lowercase letters, numbers, and inner hyphens";
    }
    if (publication.routes.length === 0) return "Each subdomain needs at least one route";
    const paths = new Set<string>();
    for (const route of publication.routes) {
      const path = route.path.trim();
      if (!path.startsWith("/")) return "Every path must start with /";
      if (paths.has(path)) return `Path ${path} is duplicated within a subdomain`;
      paths.add(path);
      try {
        const url = new URL(route.serviceUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") return "Service URLs must use HTTP or HTTPS";
      } catch {
        return "Enter a valid service URL for every route";
      }
    }
  }
  return null;
}

export function connectivityPayload(publications: DraftPublication[]) {
  return publications.map((publication) => ({
    suffix: publication.suffix.trim().toLowerCase(),
    routes: publication.routes.map((route) => ({ path: route.path.trim(), serviceUrl: route.serviceUrl.trim() }))
  }));
}

function hostnameLabel(storeId: string, suffix: string): string {
  const normalized = storeId
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const baseLabel = normalized || "store-id";
  return suffix.trim() ? `${baseLabel}-${suffix.trim().toLowerCase()}` : baseLabel;
}

export function ConnectivityEditor({
  storeId,
  zoneName,
  publications,
  onChange
}: {
  storeId: string;
  zoneName?: string | undefined;
  publications: DraftPublication[];
  onChange: (publications: DraftPublication[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const updatePublication = (index: number, update: (publication: DraftPublication) => DraftPublication) => {
    onChange(publications.map((publication, publicationIndex) => publicationIndex === index ? update(publication) : publication));
  };
  const reorderRoutes = (publicationIndex: number, event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    updatePublication(publicationIndex, (publication) => {
      const oldIndex = publication.routes.findIndex((route) => route.key === event.active.id);
      const newIndex = publication.routes.findIndex((route) => route.key === event.over!.id);
      if (oldIndex < 0 || newIndex < 0) return publication;
      const reordered = arrayMove(publication.routes, oldIndex, newIndex);
      return { ...publication, routes: [...reordered.filter((route) => route.path.trim() !== "/"), ...reordered.filter((route) => route.path.trim() === "/")] };
    });
  };
  return (
    <div className="connectivity-editor">
      <div className="connectivity-editor-heading">
        <div><h3>Published subdomains</h3><span>One tunnel serves every hostname and route below.</span></div>
        <button className="button button-secondary button-small" type="button" onClick={() => onChange([...publications, createDraftPublication()])}><Plus size={14} />Subdomain</button>
      </div>
      <div className="publication-editor-list">
        {publications.map((publication, publicationIndex) => {
          const preview = `${hostnameLabel(storeId, publication.suffix)}.${zoneName || "selected-zone"}`;
          return (
            <section className="publication-editor" key={publication.key}>
              <header>
                <span className="publication-glyph"><Globe2 size={16} /></span>
                <div><strong>Subdomain {publicationIndex + 1}</strong><code>{preview}</code></div>
                <button className="icon-button account-delete" type="button" title="Remove subdomain" aria-label={`Remove subdomain ${publicationIndex + 1}`} disabled={publications.length === 1} onClick={() => onChange(publications.filter((_, index) => index !== publicationIndex))}><Trash2 size={15} /></button>
              </header>
              <label className="field"><span className="field-label">Suffix <FieldHelp text="Optional. Leave blank to use the Store ID as the hostname, or enter a suffix to create Store ID-suffix. Only one subdomain can have a blank suffix." /></span><input value={publication.suffix} onChange={(event) => updatePublication(publicationIndex, (current) => ({ ...current, suffix: event.target.value }))} placeholder="api" maxLength={30} /></label>
              <div className="route-editor">
                <div className="route-editor-heading"><span><Route size={14} />Ingress routes</span><button type="button" onClick={() => updatePublication(publicationIndex, (current) => ({ ...current, routes: [...current.routes, { key: draftId("route"), path: "/api", serviceUrl: "" }] }))}><Plus size={13} />Path</button></div>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => reorderRoutes(publicationIndex, event)}>
                  <SortableContext items={publication.routes.map((route) => route.key)} strategy={verticalListSortingStrategy}>
                    {publication.routes.map((route, routeIndex) => (
                      <SortableRouteRow
                        key={route.key}
                        route={route}
                        routeCount={publication.routes.length}
                        onChange={(update) => updatePublication(publicationIndex, (current) => ({ ...current, routes: current.routes.map((item, index) => index === routeIndex ? { ...item, ...update } : item) }))}
                        onRemove={() => updatePublication(publicationIndex, (current) => ({ ...current, routes: current.routes.filter((_, index) => index !== routeIndex) }))}
                      />
                    ))}
                  </SortableContext>
                </DndContext>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function SortableRouteRow({
  route,
  routeCount,
  onChange,
  onRemove
}: {
  route: DraftRoute;
  routeCount: number;
  onChange: (update: Partial<Pick<DraftRoute, "path" | "serviceUrl">>) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: route.key });
  return (
    <div
      className={`route-editor-row ${isDragging ? "route-editor-row-dragging" : ""}`}
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button className="route-drag-handle" type="button" title="Drag to reorder" aria-label={`Reorder path ${route.path}`} {...attributes} {...listeners}><GripVertical size={16} /></button>
      <label className="field"><span className="field-label">Path prefix <FieldHelp text="The URL path prefix matched on this hostname. Drag routes into priority order. Use / as the fallback; it is always kept last." /></span><input value={route.path} onChange={(event) => onChange({ path: event.target.value })} placeholder="/" required /></label>
      <label className="field"><span className="field-label">Local service URL <FieldHelp text="The HTTP service reachable from the cloudflared machine. Use localhost for a service on the same host or a LAN IP for another POS machine." /></span><input type="url" value={route.serviceUrl} onChange={(event) => onChange({ serviceUrl: event.target.value })} placeholder="http://localhost:8080" required /></label>
      <button className="icon-button account-delete" type="button" title="Remove path" aria-label={`Remove path ${route.path}`} disabled={routeCount === 1} onClick={onRemove}><Trash2 size={15} /></button>
    </div>
  );
}
