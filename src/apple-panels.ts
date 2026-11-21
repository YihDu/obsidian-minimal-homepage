import { setIcon } from "obsidian";
import { AppleReader, type Kind, type Snapshot } from "./apple-reader";
import {
  GROUPS, dateLabel, eventLabel, groupReminders, priorityLabel, type AppleEvent, type AppleReminder
} from "./apple-model";

const REFRESH = 5 * 60_000;
const localTimeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
const lastUpdatedFormat = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
});

export class ApplePanels {
  private readonly calendar: AppleCard;
  private readonly reminders: AppleCard;
  private readonly timer: number;
  private readonly observer: IntersectionObserver;
  private lastAttempt = 0;

  constructor(parent: HTMLElement, reader: AppleReader) {
    const grid = parent.createDiv("mh-apple-grid");
    this.calendar = new AppleCard(grid, reader, "calendar", "Upcoming Events");
    this.reminders = new AppleCard(grid, reader, "reminders", "Reminders");
    const refreshIfVisible = () => {
      if (!document.hidden && grid.getClientRects().length && Date.now() - this.lastAttempt >= REFRESH) this.refresh();
    };
    this.timer = window.setInterval(refreshIfVisible, 60_000);
    this.observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) refreshIfVisible();
    });
    this.observer.observe(grid);
  }

  refresh(): void {
    this.lastAttempt = Date.now();
    void this.calendar.refresh();
    void this.reminders.refresh();
  }

  dispose(): void {
    window.clearInterval(this.timer);
    this.observer.disconnect();
    this.calendar.dispose();
    this.reminders.dispose();
  }
}

type Row = AppleEvent | AppleReminder;
type BatchRow = { group: string } | { item: Row };

class AppleCard {
  private readonly body: HTMLElement;
  private readonly status: HTMLElement;
  private readonly count: HTMLElement;
  private busy = false;
  private disposed = false;
  private frame?: number;

  constructor(parent: HTMLElement, private readonly reader: AppleReader, private readonly kind: Kind, title: string) {
    const card = parent.createEl("section", { cls: "mh-apple-card", attr: { "aria-label": title } });
    const header = card.createEl("header", { cls: "mh-apple-header" });
    header.createEl("h2", { text: title });
    this.count = header.createSpan("mh-apple-count");
    const icon = header.createEl("button", { cls: "clickable-icon mh-apple-open", attr: {
      "aria-label": "Open Apple " + (kind === "calendar" ? "Calendar" : "Reminders"),
      title: "Open Apple " + (kind === "calendar" ? "Calendar" : "Reminders")
    } });
    setIcon(icon, "arrow-up-right");
    icon.onclick = () => reader.openApp(kind);
    this.status = card.createDiv({ cls: "mh-apple-status", attr: { "aria-live": "polite" } });
    this.body = card.createDiv({ cls: "mh-apple-body", attr: { "aria-label": title + " list" } });
    const cached = reader.last(kind);
    if (cached) this.render(cached);
  }

  async refresh(authorize = false): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.status.empty();
    this.status.createSpan({ text: authorize ? "Waiting for macOS permission…" : "Refreshing…" });
    this.body.setAttribute("aria-busy", "true");
    try {
      const result = await this.reader.refresh(this.kind, authorize);
      if (!this.disposed) this.render(result);
    } finally {
      this.busy = false;
      this.body.removeAttribute("aria-busy");
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
  }

  private render(snapshot: Snapshot): void {
    this.status.empty();
    const messages = {
      notDetermined: "Allow access to view items from Apple " + (this.kind === "calendar" ? "Calendar." : "Reminders."),
      denied: "Access is off. In System Settings → Privacy & Security, allow access for the Apple reader or Obsidian, then refresh.",
      restricted: "macOS restricts access to this data.",
      unsupported: "Available on macOS 14 or later.",
      missing: "Apple reader is missing. Build it with npm run build:apple-helper, then refresh.",
      timeout: "Apple data did not respond in time. Try refreshing.",
      failed: "Could not read Apple data. Try refreshing."
    };
    if (snapshot.state !== "ok") {
      this.status.createDiv({ text: messages[snapshot.state] });
      if (snapshot.lastSuccess) this.status.createDiv({
        cls: "mh-apple-updated", text: "Last successful refresh · " + lastUpdatedFormat.format(snapshot.lastSuccess)
      });
      if (snapshot.state === "notDetermined") {
        const allow = this.status.createEl("button", { cls: "mh-apple-permission", text: "Allow access" });
        allow.onclick = () => void this.refresh(true);
      }
    }

    const now = Date.now();
    const items = this.kind === "calendar" ? snapshot.events : snapshot.reminders;
    this.count.setText(items ? String(items.length) : "");
    if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    if (!items?.length) {
      this.body.empty();
      if (items && snapshot.state === "ok") this.body.createEl("p", {
        cls: "mh-apple-empty",
        text: this.kind === "calendar" ? "No upcoming events in the search window." : "No unfinished reminders."
      });
      return;
    }

    const rows: BatchRow[] = [];
    if (this.kind === "calendar") {
      rows.push(...(snapshot.events ?? []).map(item => ({ item })));
    } else {
      const groups = groupReminders(snapshot.reminders ?? [], now);
      for (const group of GROUPS) {
        if (groups[group].length) rows.push({ group });
        for (const item of groups[group]) rows.push({ item });
      }
    }
    const buffer = document.createElement("div");
    let index = 0;
    const appendBatch = () => {
      const stop = Math.min(rows.length, index + 40);
      for (; index < stop; index++) {
        const row = rows[index];
        if ("group" in row) buffer.createEl("h3", { cls: "mh-apple-group", text: row.group });
        else if ("calendar" in row.item) this.renderEvent(buffer, row.item, now);
        else this.renderReminder(buffer, row.item, now);
      }
      if (index < rows.length) {
        this.frame = window.requestAnimationFrame(appendBatch);
      } else {
        this.frame = undefined;
        const scroll = this.body.closest(".mh-view");
        const position = scroll?.scrollTop ?? 0;
        this.body.replaceChildren(buffer);
        if (scroll) scroll.scrollTop = position;
      }
    };
    appendBatch();
  }

  private renderEvent(parent: HTMLElement, event: AppleEvent, now: number): void {
    const row = parent.createEl("article", { cls: "mh-apple-row" });
    const label = eventLabel(event, now);
    row.createDiv({ cls: "mh-apple-when", text: label.day + " · " + label.time });
    row.createDiv({ cls: "mh-apple-name", text: event.title });
    const meta = row.createDiv("mh-apple-meta");
    const calendar = meta.createSpan("mh-apple-tag");
    if (event.color && /^#[0-9a-f]{6}$/i.test(event.color)) {
      const dot = calendar.createSpan("mh-apple-color");
      dot.style.backgroundColor = event.color;
    }
    calendar.createSpan({ text: event.calendar });
    if (event.location) {
      const location = meta.createSpan({ cls: "mh-apple-location", attr: { title: event.location } });
      const icon = location.createSpan({ attr: { "aria-hidden": "true" } });
      setIcon(icon, "map-pin");
      location.createSpan({ text: event.location });
    }
    if (event.timeZone && event.timeZone !== localTimeZone) {
      meta.createSpan({ text: event.timeZone, attr: { title: "Event time zone" } });
    }
    this.notesAndLink(row, event.notes, event.url);
  }

  private renderReminder(parent: HTMLElement, item: AppleReminder, now: number): void {
    const row = parent.createEl("article", { cls: "mh-apple-row mh-apple-reminder" });
    row.createSpan({ cls: "mh-apple-circle", attr: { "aria-label": "Not completed" } });
    const content = row.createDiv("mh-apple-item-content");
    const headline = content.createDiv("mh-apple-headline");
    headline.createSpan({ cls: "mh-apple-name", text: item.title });
    const priority = priorityLabel(item.priority);
    if (priority) headline.createSpan({ cls: "mh-apple-priority", text: priority, attr: { title: priority + " priority" } });
    const meta = content.createDiv("mh-apple-meta");
    if (item.due) meta.createSpan({ text: dateLabel(item.due, now) });
    meta.createSpan({ cls: "mh-apple-tag", text: item.list });
    if (item.start) meta.createSpan({ text: "Starts " + dateLabel(item.start, now) });
    if (item.due?.timeZone && item.due.timeZone !== localTimeZone) {
      meta.createSpan({ text: item.due.timeZone, attr: { title: "Due time zone" } });
    }
    if (item.start?.timeZone && item.start.timeZone !== localTimeZone && item.start.timeZone !== item.due?.timeZone) {
      meta.createSpan({ text: item.start.timeZone, attr: { title: "Start time zone" } });
    }
    this.notesAndLink(content, item.notes, item.url);
  }

  private notesAndLink(row: HTMLElement, notes?: string, url?: string): void {
    if (notes) row.createDiv({ text: notes, cls: "mh-apple-detail-text" });
    if (!url) return;
    if (/^https?:\/\//i.test(url)) {
      row.createEl("a", { cls: "mh-apple-url", text: "Open link", href: url, attr: {
        title: url, target: "_blank", rel: "noopener noreferrer"
      } });
    } else row.createDiv({ text: url, cls: "mh-apple-detail-text" });
  }
}
