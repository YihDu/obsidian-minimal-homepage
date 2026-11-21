export const NAVIGATOR_ID = "notebook-navigator";
export const PROFILE_KEY = "notebook-navigator-vault-profile";

type ObjectMap = Record<string, unknown>;
export interface Shortcut {
  type: "folder" | "note";
  path: string;
  alias?: string;
  icon?: string;
  color?: string;
}

function object(value: unknown): ObjectMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectMap : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

// Notebook Navigator 3.5.1 stores ordered entries on the selected profile.
// Only the active profile ID may be set in vault-scoped local storage.
export function readShortcuts(value: unknown, deviceProfile?: unknown): Shortcut[] | null {
  const settings = object(value);
  if (!Array.isArray(settings.vaultProfiles)) return null;
  const profiles = settings.vaultProfiles.map(object).filter(p => string(p.id));
  const mode = object(settings.syncModes).vaultProfile;
  const candidates = mode === "local" ? [deviceProfile, "default"] : [settings.vaultProfile, deviceProfile, "default"];
  const profile = candidates.map(id => profiles.find(p => p.id === id)).find(Boolean) ?? profiles[0];
  if (!profile) return [];
  if (!Array.isArray(profile.shortcuts)) return null;
  return profile.shortcuts.flatMap(raw => {
    const entry = object(raw);
    const type = entry.type;
    const path = string(entry.path);
    if (!path || (type !== "folder" && type !== "note")) return [];
    if (type === "note" && !path.toLowerCase().endsWith(".md")) return [];
    const appearance = object(object(settings.folderAppearances)[path]);
    const icon = type === "folder" ? appearance.icon ?? object(settings.folderIcons)[path] : object(settings.fileIcons)[path];
    const color = type === "folder" ? appearance.color ?? object(settings.folderColors)[path] : object(settings.fileColors)[path];
    return [{ type, path, alias: string(entry.alias), icon: string(icon), color: string(color) }];
  });
}

// Group consecutive shortcuts by their top-level folder without reordering the source.
export function shortcutRows<T extends { item: Shortcut }>(items: T[]): T[][] {
  const rows: T[][] = [];
  let previous: string | undefined;
  for (const item of items) {
    const path = item.item.path.replace(/^\/+/, "");
    const group = item.item.type === "note" && !path.includes("/") ? "" : path.split("/", 1)[0];
    if (group === previous) rows.at(-1)?.push(item);
    else rows.push([item]);
    previous = group;
  }
  return rows;
}
