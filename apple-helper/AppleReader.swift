import CoreGraphics
import EventKit
import Foundation

struct AppleDate: Encodable {
    let day: String
    let timestamp: Double?
    let timeZone: String?
}

struct UpcomingEvent: Encodable {
    let id: String
    let title: String
    let start: Double
    let end: Double
    let allDay: Bool
    let allDayStart: String?
    let allDayEnd: String?
    let calendar: String
    let color: String?
    let location: String?
    let notes: String?
    let url: String?
    let timeZone: String?
}

struct Reminder: Encodable {
    let id: String
    let title: String
    let list: String
    let due: AppleDate?
    let start: AppleDate?
    let priority: Int
    let notes: String?
    let url: String?
    let completed: Bool
}

struct Response: Encodable {
    let status: String
    var events: [UpcomingEvent]? = nil
    var reminders: [Reminder]? = nil
}

private func milliseconds(_ date: Date) -> Double {
    date.timeIntervalSince1970 * 1000
}

private func optionalText(_ string: String?) -> String? {
    guard let string, !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    return string
}

private func dayString(_ date: Date, zone: TimeZone) -> String {
    var gregorian = Calendar(identifier: .gregorian)
    gregorian.timeZone = zone
    let ymd = gregorian.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", ymd.year ?? 0, ymd.month ?? 0, ymd.day ?? 0)
}

private func dateValue(_ components: DateComponents?) -> AppleDate? {
    guard var components, components.year != nil, components.month != nil, components.day != nil else { return nil }
    let hasTime = components.hour != nil || components.minute != nil || components.second != nil
    let zone = components.timeZone ?? .current
    var calendar = components.calendar ?? Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    components.timeZone = zone
    // Date-only values are floating civil dates. Noon avoids midnight time-zone transitions.
    if !hasTime { components.hour = 12 }
    guard let date = calendar.date(from: components) else { return nil }
    return AppleDate(
        day: dayString(date, zone: zone),
        timestamp: hasTime ? milliseconds(date) : nil,
        timeZone: hasTime ? zone.identifier : nil
    )
}

private func hexColor(_ color: CGColor?) -> String? {
    guard let converted = color?.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!,
                                           intent: .defaultIntent, options: nil),
          let components = converted.components, components.count >= 3 else { return nil }
    let rgb = components.prefix(3).map { Int((255 * min(max($0, 0), 1)).rounded()) }
    return String(format: "#%02X%02X%02X", rgb[0], rgb[1], rgb[2])
}

private func upcoming(_ store: EKEventStore, now: Date) -> [UpcomingEvent] {
    let calendar = Calendar.current
    var matching: [EKEvent] = []
    // Predicate matches occurrences intersecting the window. Ignore those that have ended.
    let start = calendar.startOfDay(for: now)
    for days in [90, 365, 730] {
        guard let end = calendar.date(byAdding: .day, value: days, to: now) else { break }
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
        matching = store.events(matching: predicate).filter {
            $0.endDate > now && $0.status != .canceled
        }
        if matching.count >= 5 { break }
    }
    return matching.sorted {
        if $0.startDate != $1.startDate { return $0.startDate < $1.startDate }
        return $0.calendarItemIdentifier < $1.calendarItemIdentifier
    }.prefix(5).map { event in
        let zone = event.timeZone ?? .current
        return UpcomingEvent(
            id: "\(event.eventIdentifier ?? event.calendarItemIdentifier):\(milliseconds(event.occurrenceDate ?? event.startDate))",
            title: optionalText(event.title) ?? "Untitled event",
            start: milliseconds(event.startDate), end: milliseconds(event.endDate), allDay: event.isAllDay,
            allDayStart: event.isAllDay ? dayString(event.startDate, zone: zone) : nil,
            allDayEnd: event.isAllDay ? dayString(event.endDate, zone: zone) : nil,
            calendar: event.calendar.title, color: hexColor(event.calendar.cgColor),
            location: optionalText(event.location), notes: optionalText(event.notes),
            url: event.url?.absoluteString, timeZone: event.timeZone?.identifier
        )
    }
}

private func unfinished(_ store: EKEventStore) async -> [Reminder]? {
    // The unbounded predicate also includes reminders without a due date.
    let predicate = store.predicateForReminders(in: nil)
    return await withCheckedContinuation { continuation in
        _ = store.fetchReminders(matching: predicate) { reminders in
            continuation.resume(returning: reminders?.filter { !$0.isCompleted }.map {
                Reminder(id: $0.calendarItemIdentifier, title: optionalText($0.title) ?? "Untitled reminder",
                         list: $0.calendar.title, due: dateValue($0.dueDateComponents),
                         start: dateValue($0.startDateComponents), priority: $0.priority,
                         notes: optionalText($0.notes), url: $0.url?.absoluteString,
                         completed: $0.isCompleted)
            })
        }
    }
}

@available(macOS 14.0, *)
private func accessStatus(_ entity: EKEntityType) -> String {
    switch EKEventStore.authorizationStatus(for: entity) {
    case .fullAccess: return "ok"
    case .notDetermined: return "notDetermined"
    case .denied, .writeOnly: return "denied"
    case .restricted: return "restricted"
    @unknown default: return "failed"
    }
}

@main
struct AppleReader {
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        guard #available(macOS 14.0, *) else { send(Response(status: "unsupported")); return }
        guard args.count == 2, ["read", "authorize"].contains(args[0]),
              ["calendar", "reminders"].contains(args[1]) else {
            send(Response(status: "invalidCommand"))
            return
        }

        let entity: EKEntityType = args[1] == "calendar" ? .event : .reminder
        if args[0] == "authorize" && accessStatus(entity) == "notDetermined" {
            let requester = EKEventStore()
            do {
                if entity == .event { _ = try await requester.requestFullAccessToEvents() }
                else { _ = try await requester.requestFullAccessToReminders() }
            } catch {
                let current = accessStatus(entity)
                send(Response(status: current == "notDetermined" || current == "ok" ? "failed" : current))
                return
            }
        }
        let status = accessStatus(entity)
        guard status == "ok" else { send(Response(status: status)); return }
        let store = EKEventStore()
        if entity == .event {
            send(Response(status: "ok", events: upcoming(store, now: Date())))
        } else if let reminders = await unfinished(store) {
            send(Response(status: "ok", reminders: reminders))
        } else {
            send(Response(status: "failed"))
        }
    }

    private static func send(_ value: Response) {
        guard let encoded = try? JSONEncoder().encode(value) else {
            print("{\"status\":\"failed\"}")
            return
        }
        FileHandle.standardOutput.write(encoded)
    }
}
