import { test } from "node:test";
import assert from "node:assert/strict";
import { dateLabel, eventLabel, groupReminders, localDay, priorityLabel } from "../src/apple-model.ts";

const now = new Date(2026, 10, 21, 12).getTime();
const today = localDay(now);
const yesterday = localDay(new Date(2026, 10, 20, 12));
const tomorrow = localDay(new Date(2026, 10, 22, 12));
const task = (id, due, completed = false) => ({
  id, title: id, list: "Projects", due, priority: 0, completed
});

test("Overdue includes timed tasks earlier today, while date-only tasks stay in Today", () => {
  const groups = groupReminders([
    task("late day", { day: yesterday }),
    task("earlier today", { day: today, timestamp: now - 60_000 }),
    task("all day", { day: today }),
    task("later today", { day: today, timestamp: now + 60_000 }),
    task("tomorrow", { day: tomorrow }),
    task("undated"),
    task("finished", { day: today }, true)
  ], now);
  assert.deepEqual(groups.Overdue.map(t => t.id), ["late day", "earlier today"]);
  assert.deepEqual(groups.Today.map(t => t.id), ["later today", "all day"]);
  assert.deepEqual(groups.Upcoming.map(t => t.id), ["tomorrow"]);
  assert.deepEqual(groups["No Due Date"].map(t => t.id), ["undated"]);
  assert.equal(dateLabel({ day: today }, now), "Today");
  assert.equal(dateLabel({ day: tomorrow }, now), "Tomorrow");
});

test("Grouping preserves every unfinished reminder and orders future deadlines", () => {
  const undated = Array.from({ length: 500 }, (_, i) => task("Undated " + i));
  const groups = groupReminders([
    ...undated,
    task("later", { day: tomorrow, timestamp: now + 25 * 3_600_000 }),
    task("earlier", { day: tomorrow, timestamp: now + 24 * 3_600_000 })
  ], now);
  assert.equal(groups["No Due Date"].length, 500);
  assert.deepEqual(groups.Upcoming.map(t => t.id), ["earlier", "later"]);
});

test("All-day end is exclusive and cross-day event labels show their final day", () => {
  const base = { id: "fixture", title: "Practice", calendar: "Inbox", allDay: true,
    start: now, end: now + 86_400_000, allDayStart: today, allDayEnd: tomorrow };
  assert.deepEqual(eventLabel(base, now), { day: "Today", time: "All day" });
  assert.deepEqual(eventLabel({ ...base, allDayStart: yesterday }, now), {
    day: new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" })
      .format(new Date(2026, 10, 20, 12)),
    time: "All day · through Today"
  });
  const timed = { ...base, allDay: false, allDayStart: undefined, allDayEnd: undefined };
  assert.match(eventLabel(timed, now).time, /Tomorrow/);
  assert.equal(priorityLabel(1), "High");
  assert.equal(priorityLabel(5), "Medium");
  assert.equal(priorityLabel(9), "Low");
  assert.equal(priorityLabel(0), undefined);
});
