export interface AppleDate {
  day: string;
  timestamp?: number;
  timeZone?: string;
}

export interface AppleEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  allDayStart?: string;
  allDayEnd?: string;
  calendar: string;
  color?: string;
  location?: string;
  notes?: string;
  url?: string;
  timeZone?: string;
}

export interface AppleReminder {
  id: string;
  title: string;
  list: string;
  due?: AppleDate;
  start?: AppleDate;
  priority: number;
  notes?: string;
  url?: string;
  completed: boolean;
}

export type ReminderGroup = "Overdue" | "Today" | "Upcoming" | "No Due Date";
export const GROUPS: ReminderGroup[] = ["Overdue", "Today", "Upcoming", "No Due Date"];

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const longDayFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function localDay(value: Date | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, i) => String(part).padStart(i ? 2 : 4, "0")).join("-");
}

function fromDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date, 12);
}

function offsetDay(day: string, amount: number): string {
  const date = fromDay(day);
  date.setDate(date.getDate() + amount);
  return localDay(date);
}

export function dayLabel(day: string, now: number): string {
  const today = localDay(now);
  if (day === today) return "Today";
  if (day === offsetDay(today, 1)) return "Tomorrow";
  const date = fromDay(day);
  return (date.getFullYear() === new Date(now).getFullYear() ? dayFormat : longDayFormat).format(date);
}

export function dateLabel(date: AppleDate, now: number): string {
  if (date.timestamp === undefined) return dayLabel(date.day, now);
  return dayLabel(localDay(date.timestamp), now) + " · " + timeFormat.format(date.timestamp);
}

function dueDay(date: AppleDate): string {
  return date.timestamp === undefined ? date.day : localDay(date.timestamp);
}

export function groupReminders(items: AppleReminder[], now: number): Record<ReminderGroup, AppleReminder[]> {
  const groups: Record<ReminderGroup, AppleReminder[]> = { Overdue: [], Today: [], Upcoming: [], "No Due Date": [] };
  const today = localDay(now);
  for (const item of items) {
    if (item.completed) continue;
    if (!item.due) { groups["No Due Date"].push(item); continue; }
    const day = dueDay(item.due);
    if (day < today || (item.due.timestamp !== undefined && item.due.timestamp < now)) groups.Overdue.push(item);
    else if (day === today) groups.Today.push(item);
    else groups.Upcoming.push(item);
  }
  for (const group of GROUPS) {
    groups[group].sort((a, b) => {
      const ad = a.due;
      const bd = b.due;
      const deadline = ad && bd ? dueDay(ad).localeCompare(dueDay(bd)) ||
        (ad.timestamp ?? Number.POSITIVE_INFINITY) - (bd.timestamp ?? Number.POSITIVE_INFINITY) : 0;
      return deadline || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    });
  }
  return groups;
}

export function eventLabel(event: AppleEvent, now: number): { day: string; time: string } {
  const start = event.allDayStart ?? localDay(event.start);
  const end = event.allDay && event.allDayEnd
    ? offsetDay(event.allDayEnd, -1) : localDay(event.end);
  const day = dayLabel(start, now);
  if (event.allDay) {
    return { day, time: end > start ? "All day · through " + dayLabel(end, now) : "All day" };
  }
  const endLabel = end === start ? "" : dayLabel(end, now) + " ";
  return { day, time: timeFormat.format(event.start) + " – " + endLabel + timeFormat.format(event.end) };
}

export function priorityLabel(value: number): string | undefined {
  if (value >= 1 && value <= 4) return "High";
  if (value === 5) return "Medium";
  if (value >= 6 && value <= 9) return "Low";
  return undefined;
}
