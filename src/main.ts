import {
  App, ItemView, MarkdownView, Plugin, PluginSettingTab, Setting, TFile, TFolder,
  WorkspaceLeaf, getIcon, normalizePath, setIcon
} from "obsidian";
import { AppleReader } from "./apple-reader";
import { ApplePanels } from "./apple-panels";
import { addVisit, normalizeHistory, rankVisits, remapHistory, type Visit } from "./history";
import { NAVIGATOR_ID, PROFILE_KEY, readShortcuts, shortcutRows, type Shortcut } from "./shortcuts";

const VIEW = "minimal-homepage";
type Mode = "recent" | "frequent";
type Entry = TFile | TFolder;
type Data = { openOnStartup: boolean; showRibbon: boolean; history: Visit[] };
type NavigatorApi = {
  metadata?: { getFolderMeta?: (folder: TFolder) => { icon?: string; color?: string } | null };
};
type NavigatorApp = App & {
  plugins?: { plugins?: Record<string, { api?: NavigatorApi }> };
};
type Pins = { items: Shortcut[]; message?: string };

export default class MinimalHomepage extends Plugin {
  data: Data = { openOnStartup: false, showRibbon: true, history: [] };
  appleReader!: AppleReader;
  private ribbon?: HTMLElement;
  private lastOpened?: string;
  private saveTimer?: number;
  private saveQueue: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    const saved = await this.loadData();
    this.data = {
      openOnStartup: saved?.openOnStartup === true,
      showRibbon: saved?.showRibbon !== false,
      history: normalizeHistory(saved?.history, Date.now())
    };
    this.appleReader = new AppleReader(this.app, this.manifest.dir ?? this.app.vault.configDir + "/plugins/" + this.manifest.id);
    this.registerView(VIEW, leaf => new HomepageView(leaf, this));
    this.addCommand({ id: "open-homepage", name: "Open Homepage", callback: () => void this.openHomepage() });
    this.addSettingTab(new HomepageSettings(this.app, this));
    this.syncRibbon();

    this.registerEvent(this.app.workspace.on("file-open", file => {
      if (!file || file.extension.toLowerCase() !== "md") {
        this.lastOpened = undefined;
        return;
      }
      const history = addVisit(this.data.history, file.path, Date.now(), this.lastOpened === file.path);
      this.lastOpened = file.path;
      if (history === this.data.history) return;
      this.data.history = history;
      this.scheduleSave();
      this.views().forEach(view => view.renderVisits());
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handlePathChange(oldPath, file.path)));
    this.registerEvent(this.app.vault.on("delete", file => this.handlePathChange(file.path, null)));
    this.app.workspace.onLayoutReady(() => {
      const history = this.data.history.filter(v => this.app.vault.getFileByPath(v.path));
      if (history.length !== this.data.history.length) {
        this.data.history = history;
        this.scheduleSave();
      }
      if (this.data.openOnStartup) void this.openHomepage();
    });
  }

  onunload(): void {
    if (this.saveTimer !== undefined) void this.persist();
    this.views().forEach(view => view.leaf.detach());
  }

  async openHomepage(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW, active: true });
    } else {
      await this.app.workspace.revealLeaf(leaf);
      if (leaf.view instanceof HomepageView) await leaf.view.refresh();
    }
  }

  syncRibbon(): void {
    if (this.data.showRibbon && !this.ribbon) {
      this.ribbon = this.addRibbonIcon("house", "Open Homepage", () => void this.openHomepage());
    } else if (!this.data.showRibbon && this.ribbon) {
      this.ribbon.remove();
      this.ribbon = undefined;
    }
  }

  async getPins(): Promise<Pins> {
    const path = normalizePath(this.app.vault.configDir + "/plugins/" + NAVIGATOR_ID + "/data.json");
    try {
      if (!await this.app.vault.adapter.exists(path)) {
        const installed = await this.app.vault.adapter.exists(path.replace(/data\.json$/, "manifest.json"));
        return { items: [], message: installed
          ? "Add a folder or note to Notebook Navigator Shortcuts to get started."
          : "Notebook Navigator is not installed in this vault." };
      }
      const config: unknown = JSON.parse(await this.app.vault.adapter.read(path));
      const items = readShortcuts(config, this.app.loadLocalStorage(PROFILE_KEY));
      if (items === null) return { items: [], message: "This Notebook Navigator shortcut format could not be read." };
      return { items, message: items.length ? undefined : "Pin a folder or note in Notebook Navigator to see it here." };
    } catch {
      return { items: [], message: "Could not read Notebook Navigator Shortcuts. Try refreshing." };
    }
  }

  folderStyle(folder: TFolder): { icon?: string; color?: string } {
    try {
      const nav = (this.app as NavigatorApp).plugins?.plugins?.[NAVIGATOR_ID]?.api;
      return nav?.metadata?.getFolderMeta?.(folder) ?? {};
    } catch {
      return {};
    }
  }

  persist(): Promise<void> {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const snapshot = { ...this.data, history: normalizeHistory(this.data.history, Date.now()) };
    this.saveQueue = this.saveQueue.catch(() => undefined).then(() => this.saveData(snapshot));
    void this.saveQueue.catch(error => console.error("Minimal Homepage: could not save local history", error));
    return this.saveQueue;
  }

  private scheduleSave(): void {
    if (this.saveTimer === undefined) {
      this.saveTimer = window.setTimeout(() => void this.persist(), 750);
    }
  }

  private views(): HomepageView[] {
    return this.app.workspace.getLeavesOfType(VIEW).map(leaf => leaf.view)
      .filter((view): view is HomepageView => view instanceof HomepageView);
  }

  private handlePathChange(oldPath: string, newPath: string | null): void {
    const history = this.data.history;
    if (history.some(v => v.path === oldPath || v.path.startsWith(oldPath + "/"))) {
      this.data.history = remapHistory(history, oldPath, newPath, Date.now());
      this.scheduleSave();
    }
    this.views().forEach(view => void view.refresh(false));
  }
}

class HomepageView extends ItemView {
  private mode: Mode = "recent";
  private pins?: HTMLElement;
  private visits?: HTMLElement;
  private browse?: HTMLElement;
  private currentFolder?: string;
  private pinnedFolder?: string;
  private pinsButtons = new Map<string, HTMLButtonElement>();
  private refreshId = 0;
  private applePanels?: ApplePanels;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: MinimalHomepage) {
    super(leaf);
  }

  getViewType(): string { return VIEW; }
  getDisplayText(): string { return "Home"; }
  getIcon(): string { return "house"; }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("mh-view");
    const root = this.contentEl.createDiv("mh-page");
    const title = root.createEl("header", { cls: "mh-title" });
    title.createEl("h1", { text: "Home" });
    const refresh = title.createEl("button", { cls: "mh-refresh clickable-icon", attr: {
      "aria-label": "Refresh homepage", title: "Refresh homepage"
    } });
    setIcon(refresh, "refresh-cw");
    refresh.onclick = () => void this.refresh();

    const layout = root.createDiv("mh-home-layout");
    const primary = layout.createDiv("mh-home-primary");
    this.renderActions(primary);

    const pinned = primary.createEl("section", { cls: "mh-section", attr: { "aria-label": "Pinned" } });
    pinned.createEl("h2", { text: "Pinned" });
    this.pins = pinned.createDiv();
    this.browse = pinned.createDiv("mh-folder");
    this.browse.id = "mh-folder-" + this.leafId();
    this.browse.hidden = true;

    const working = primary.createEl("section", { cls: "mh-section mh-working", attr: { "aria-label": "Continue Working" } });
    const header = working.createDiv("mh-section-header");
    header.createEl("h2", { text: "Continue Working" });
    const switcher = header.createDiv({ cls: "mh-segments", attr: { role: "group", "aria-label": "Note history view" } });
    for (const [mode, label] of [["recent", "Recent"], ["frequent", "Frequent"]] as const) {
      const button = switcher.createEl("button", { text: label, attr: { "aria-pressed": String(mode === this.mode) } });
      button.onclick = () => {
        this.mode = mode;
        Array.from(switcher.querySelectorAll("button")).forEach(b => b.setAttribute("aria-pressed", String(b === button)));
        this.renderVisits();
      };
    }
    this.visits = working.createDiv();
    this.applePanels = new ApplePanels(layout, this.plugin.appleReader);
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.refreshId++;
    this.applePanels?.dispose();
    this.applePanels = undefined;
    this.pins = this.visits = this.browse = undefined;
    this.pinsButtons.clear();
  }

  async refresh(refreshApple = true): Promise<void> {
    if (refreshApple) this.applePanels?.refresh();
    const token = ++this.refreshId;
    const pins = await this.plugin.getPins();
    if (token !== this.refreshId || !this.pins) return;
    this.pins.empty();
    this.pinsButtons.clear();
    const resolved = pins.items.flatMap(item => {
      const target = this.app.vault.getAbstractFileByPath(normalizePath(item.path));
      return (item.type === "folder" && target instanceof TFolder) ||
        (item.type === "note" && target instanceof TFile && target.extension.toLowerCase() === "md")
        ? [{ item, target }] : [];
    });
    if (resolved.length) {
      const rows = this.pins.createDiv("mh-pin-rows");
      for (const row of shortcutRows(resolved)) {
        const grid = rows.createDiv("mh-grid");
        grid.style.setProperty("--mh-pin-count", String(row.length));
        row.forEach(({ item, target }) => this.renderPin(grid, item, target));
      }
    } else {
      this.empty(this.pins, pins.message ?? "The shortcut targets could not be found in this vault.");
    }
    if (this.pinnedFolder && !this.pinsButtons.has(this.pinnedFolder)) {
      this.currentFolder = this.pinnedFolder = undefined;
    }
    this.renderFolder();
    this.renderVisits();
  }

  renderVisits(): void {
    if (!this.visits) return;
    this.visits.empty();
    const now = Date.now();
    const existing = this.plugin.data.history.filter(v => this.app.vault.getFileByPath(v.path));
    const ranked = rankVisits(existing, this.mode, now, 5);
    if (!ranked.length) {
      this.empty(this.visits, this.mode === "recent"
        ? "Open a note to start your recent history."
        : "Your most visited notes over the last 14 days will appear here.");
      return;
    }
    const list = this.visits.createDiv("mh-list");
    for (const visit of ranked) {
      const file = this.app.vault.getFileByPath(visit.path);
      if (file) this.fileButton(list, file, relativeTime(visit.last, now));
    }
  }

  private renderActions(root: HTMLElement): void {
    const actions = root.createDiv("mh-actions");
    const form = actions.createEl("form", { cls: "mh-search", attr: { role: "search", "aria-label": "Search vault" } });
    const search = form.createEl("a", { cls: "mh-search-submit", attr: {
      "aria-label": "Open vault search", title: "Open vault search"
    } });
    setIcon(search, "search");
    const input = form.createEl("input", { type: "search", placeholder: "Search vault…", attr: {
      "aria-label": "Search vault", autocomplete: "off"
    } });
    const syncSearch = () => {
      const query = input.value.trim();
      const target = "obsidian://search?vault=" + encodeURIComponent(this.app.vault.getName());
      search.href = query ? target + "&query=" + encodeURIComponent(query) : target;
    };
    syncSearch();
    input.oninput = syncSearch;
    form.onsubmit = event => {
      event.preventDefault();
      syncSearch();
      search.click();
    };
    // An actual submit control lets Enter submit consistently across Chromium versions.
    form.createEl("button", { type: "submit", attr: { hidden: "", tabindex: "-1" } });

    const create = actions.createEl("button", { type: "button", cls: "mh-new-note", attr: { title: "Create a blank note in Box" } });
    setIcon(create.createSpan({ attr: { "aria-hidden": "true" } }), "plus");
    create.createSpan({ text: "New Note" });
    const status = root.createDiv({ cls: "mh-action-status", attr: { role: "status" } });

    create.onclick = async () => {
      if (create.disabled) return;
      const rootFolder = this.app.vault.getRoot();
      const numbered = rootFolder.children.filter((item): item is TFolder =>
        item instanceof TFolder && /^\d+[-_ ]+box$/i.test(item.name));
      const box = this.app.vault.getFolderByPath("box") ?? (numbered.length === 1 ? numbered[0] : null);
      if (!box) {
        status.setText("No single box folder was found at the root of this vault.");
        return;
      }
      create.disabled = true;
      status.empty();
      try {
        const time = new Date();
        const stamp = window.moment(time).format("YYYY-MM-DD HH-mm-ss");
        const title = "Quick note " + stamp;
        let path = box.path + "/" + title + ".md";
        let suffix = 1;
        while (this.app.vault.getAbstractFileByPath(path)) {
          path = box.path + "/" + title + " " + (++suffix) + ".md";
        }
        const file = await this.app.vault.create(path, "");
        await this.openNote(file);
        this.app.workspace.getActiveViewOfType(MarkdownView)?.editor.focus();
      } catch {
        status.setText("Could not create or open the note. Check the box folder and try again.");
      } finally {
        create.disabled = false;
      }
    };
  }

  private renderPin(grid: HTMLElement, shortcut: Shortcut, target: Entry): void {
    const folder = target instanceof TFolder;
    const style = folder ? this.plugin.folderStyle(target) : {};
    const name = shortcut.alias ?? (target instanceof TFile ? target.basename : target.name || "Vault");
    const pin = grid.createEl("button", { cls: "mh-pin", attr: { title: target.path || "/" } });
    const icon = pin.createSpan({ cls: "mh-pin-icon", attr: { "aria-hidden": "true" } });
    paintIcon(icon, style.icon ?? shortcut.icon, folder ? "folder" : "file-text", style.color ?? shortcut.color);
    const copy = pin.createSpan("mh-copy");
    copy.createSpan({ cls: "mh-name", text: name });
    copy.createSpan({ cls: "mh-path", text: parentLabel(target) });
    if (folder) {
      this.pinsButtons.set(target.path, pin);
      const chev = pin.createSpan({ cls: "mh-chevron", attr: { "aria-hidden": "true" } });
      setIcon(chev, "chevron-down");
      pin.setAttribute("aria-controls", this.browse?.id ?? "");
      pin.onclick = () => {
        if (this.pinnedFolder === target.path) {
          this.pinnedFolder = this.currentFolder = undefined;
        } else {
          this.pinnedFolder = this.currentFolder = target.path;
        }
        this.renderFolder();
      };
    } else {
      pin.onclick = () => void this.openNote(target);
    }
  }

  private renderFolder(focus = false): void {
    if (!this.browse) return;
    const folder = this.currentFolder === undefined ? null : this.app.vault.getFolderByPath(this.currentFolder);
    for (const [path, button] of this.pinsButtons) {
      button.setAttribute("aria-expanded", String(Boolean(folder) && this.pinnedFolder === path));
    }
    this.browse.empty();
    this.browse.hidden = !folder;
    if (!folder) return;

    const bar = this.browse.createDiv("mh-folder-bar");
    const root = this.pinnedFolder;
    if (folder.path !== root && folder.parent) {
      const parent = folder.parent;
      const back = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Parent folder", title: "Parent folder" } });
      setIcon(back, "arrow-up");
      back.onclick = () => { this.currentFolder = parent.path; this.renderFolder(true); };
    }
    const heading = bar.createEl("h3", { text: folder.path || "Vault", attr: { tabindex: "-1" } });
    const children = folder.children.filter((f): f is Entry =>
      f instanceof TFolder || (f instanceof TFile && f.extension.toLowerCase() === "md"))
      .sort((a, b) => Number(b instanceof TFolder) - Number(a instanceof TFolder) ||
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    const list = this.browse.createDiv("mh-list");
    if (!children.length) this.empty(list, "No notes or subfolders here.");
    for (const child of children) {
      if (child instanceof TFile) this.fileButton(list, child);
      else {
        const row = this.row(list, "folder", child.name, "", "");
        row.onclick = () => { this.currentFolder = child.path; this.renderFolder(true); };
        setIcon(row.createSpan("mh-row-icon"), "chevron-right");
      }
    }
    if (focus) heading.focus();
  }

  private fileButton(list: HTMLElement, file: TFile, time = ""): void {
    const row = this.row(list, "file-text", file.basename, parentLabel(file), time);
    row.title = file.path;
    row.onclick = () => void this.openNote(file);
  }

  private row(list: HTMLElement, glyph: string, title: string, path: string, time: string): HTMLButtonElement {
    const row = list.createEl("button", { cls: "mh-row" });
    setIcon(row.createSpan({ cls: "mh-row-icon", attr: { "aria-hidden": "true" } }), glyph);
    const copy = row.createSpan("mh-copy");
    copy.createSpan({ cls: "mh-name", text: title });
    if (path) copy.createSpan({ cls: "mh-path", text: path });
    if (time) row.createSpan({ cls: "mh-time", text: time });
    return row;
  }

  private empty(parent: HTMLElement, message: string): void {
    parent.createEl("p", { cls: "mh-empty", text: message });
  }

  private async openNote(file: TFile): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType("markdown").find(leaf => {
      const view = leaf.view as { file?: TFile };
      return view.file?.path === file.path && leaf.getRoot() === this.leaf.getRoot();
    });
    if (existing) await this.app.workspace.revealLeaf(existing);
    else await this.app.workspace.getLeaf("tab").openFile(file, { active: true });
  }

  private leafId(): string {
    return Math.random().toString(36).slice(2, 10);
  }
}

function parentLabel(entry: Entry): string {
  return entry.parent?.path && entry.parent.path !== "/" ? entry.parent.path : "Vault";
}

function paintIcon(el: HTMLElement, icon: string | undefined, fallback: string, color?: string): void {
  if (icon && getIcon(icon)) setIcon(el, icon);
  else if (icon && /\p{Extended_Pictographic}/u.test(icon) && icon.length <= 12) el.setText(icon);
  else setIcon(el, fallback);
  if (color && CSS.supports("color", color)) el.style.color = color;
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function relativeTime(time: number, now: number): string {
  const seconds = Math.max(0, (now - time) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return relative.format(-Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return relative.format(-Math.floor(seconds / 3600), "hour");
  return relative.format(-Math.floor(seconds / 86400), "day");
}

class HomepageSettings extends PluginSettingTab {
  constructor(app: App, private readonly plugin: MinimalHomepage) { super(app, plugin); }

  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl).setName("Open on startup")
      .setDesc("Open Home after the workspace loads.")
      .addToggle(toggle => toggle.setValue(this.plugin.data.openOnStartup).onChange(async value => {
        this.plugin.data.openOnStartup = value;
        await this.plugin.persist();
      }));
    new Setting(this.containerEl).setName("Show ribbon icon")
      .setDesc("Place a Home shortcut in the ribbon.")
      .addToggle(toggle => toggle.setValue(this.plugin.data.showRibbon).onChange(async value => {
        this.plugin.data.showRibbon = value;
        this.plugin.syncRibbon();
        await this.plugin.persist();
      }));
  }
}
