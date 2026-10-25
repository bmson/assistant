import SwiftUI

/// The daily briefing: its one-line lead, then short labelled sections — the
/// schedule by day, the weather in one line, and lists for what needs the
/// owner. Every value arrives pre-formatted in the owner's zone, so this view
/// only lays it out. Mirrors `BriefingCard` in the web transcript.
struct BriefingCardView: View {
    let card: MessageResponseCard.BriefingCard

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.conversationViewportWidth) private var conversationViewportWidth

    private var stacksEventRows: Bool {
        guard let width = conversationViewportWidth, width.isFinite, width > 0 else { return true }
        return dynamicTypeSize.isAccessibilitySize || width <= 360
    }

#if DEBUG
    @Environment(\.eventRhythmReview) private var eventReview
#endif
    private var expandsEventOverflowForReview: Bool {
#if DEBUG
        eventReview?.expandsOverflow == true
#else
        false
#endif
    }

    private var stacksRows: Bool { dynamicTypeSize.isAccessibilitySize }

    var body: some View {
        if card.presentation == .calendarAgenda {
            calendarAgendaBody
        } else {
            legacyBody
        }
    }

    private var legacyBody: some View {
        VStack(alignment: .leading, spacing: 14) {
            if stacksRows {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Briefing")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                        .accessibilityAddTraits(.isHeader)
                    if !card.date.isEmpty {
                        Text(card.date)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("Briefing")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 8)
                    if !card.date.isEmpty {
                        Text(card.date)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                            .lineLimit(1)
                    }
                }
            }

            if !card.lead.isEmpty {
                Text(card.lead)
                    .font(.body.weight(.medium))
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }

            ForEach(Array(card.sections.enumerated()), id: \.offset) { _, section in
                Divider().overlay(AssistantTheme.inkMuted(for: colorScheme).opacity(0.16))
                sectionView(section)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var calendarAgendaBody: some View {
        VStack(alignment: .leading, spacing: 12) {
            calendarAgendaHeader
            if !card.lead.isEmpty {
                Text(card.lead)
                    .font(.body.weight(.medium))
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(Array(card.sections.enumerated()), id: \.offset) { _, section in
                switch section {
                case let .agenda(title, complete, omittedCount, items):
                    calendarAgendaSection(title: title, complete: complete, omittedCount: omittedCount, items: items)
                case let .list(kind, title, items, overlaps, overlapCount, overlapsTruncated, itemCount, itemsTruncated):
                    if kind == "attention" && (!overlaps.isEmpty || itemCount != nil) {
                        attentionSection(
                            title: title,
                            items: items,
                            overlaps: overlaps,
                            overlapCount: overlapCount,
                            overlapsTruncated: overlapsTruncated,
                            itemCount: itemCount,
                            itemsTruncated: itemsTruncated
                        )
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            heading(title)
                            ForEach(Array(items.enumerated()), id: \.offset) { _, item in listRow(item) }
                        }
                    }
                case let .weather(title, location, temperature, condition, symbol, detail):
                    sectionView(.weather(title: title, location: location, temperature: temperature, condition: condition, symbol: symbol, detail: detail))
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var calendarAgendaHeader: some View {
        let title = Text(card.title.isEmpty ? "Agenda" : card.title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
            .accessibilityAddTraits(.isHeader)
        let date = Text(card.date)
            .font(.caption.weight(.medium))
            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            .fixedSize(horizontal: false, vertical: true)
        return Group {
            if stacksRows {
                VStack(alignment: .leading, spacing: 4) {
                    title
                    if !card.date.isEmpty { date }
                }
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        title
                        Spacer(minLength: 4)
                        if !card.date.isEmpty { date.multilineTextAlignment(.trailing) }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        title
                        if !card.date.isEmpty { date }
                    }
                }
            }
        }
    }

    private func calendarAgendaSection(
        title: String,
        complete: Bool,
        omittedCount: Int?,
        items: [MessageResponseCard.BriefingCard.AgendaItem]
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            heading(title)
            let mixedCalendars = Set(items.flatMap(\.calendars)).count > 1
            let initial = Array(items.prefix(6))
            groupedCalendarRows(initial, showCalendarAttribution: mixedCalendars)
            if items.count > 6 {
                CardDisclosure(collapsedLabel: "Showing 6 of \(items.count) · Show all", expandedLabel: "Show fewer", standalone: false,
                               initiallyExpanded: expandsEventOverflowForReview) {
                    VStack(alignment: .leading, spacing: 16) {
                        ForEach(Array(items.dropFirst(6))) { item in
                            calendarAgendaRow(item, showCalendarAttribution: mixedCalendars)
                        }
                    }
                }
            }
            if let omittedCount {
                Text("\(omittedCount) additional \(omittedCount == 1 ? "event is" : "events are") not shown.")
                    .font(.caption).foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !complete {
                Text("Some calendars could not be read, so this may be incomplete.")
                    .font(.caption).foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func groupedCalendarRows(
        _ items: [MessageResponseCard.BriefingCard.AgendaItem],
        showCalendarAttribution: Bool
    ) -> some View {
        let groups: [MessageResponseCard.BriefingCard.AgendaItem.TimeCategory] = [.allDay, .timed, .timeUnavailable]
            .filter { group in
                items.contains { $0.timeCategory == group }
        }
        return VStack(alignment: .leading, spacing: 20) {
            ForEach(groups, id: \.self) { group in
                VStack(alignment: .leading, spacing: 12) {
                    heading(group.title)
                        .eventRhythmFrame("new.heading:\(group.title)")
                    VStack(alignment: .leading, spacing: 16) {
                        ForEach(items.filter { $0.timeCategory == group }) { item in
                            calendarAgendaRow(item, showCalendarAttribution: showCalendarAttribution)
                        }
                    }
                }
                .eventRhythmFrame("new.group:\(group.title)")
            }
        }
    }

    private func calendarAgendaRow(
        _ item: MessageResponseCard.BriefingCard.AgendaItem,
        showCalendarAttribution: Bool
    ) -> some View {
        let calendarNames = item.calendars.reduce(into: [String]()) { names, name in
            if !names.contains(name) { names.append(name) }
        }
        let timeLabel: String
        if item.timeCategory == .allDay {
            timeLabel = item.time.isEmpty ? "All day" : item.time
        } else if item.timeCategory == .timeUnavailable {
            timeLabel = "Time unavailable"
        } else {
            timeLabel = item.time
        }
        let time = Text(timeLabel)
            .font(.caption.weight(.medium))
            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
        let details = VStack(alignment: .leading, spacing: 4) {
            Text(item.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
                .eventRhythmFrame("new.title:\(item.id)")
            if !item.location.isEmpty {
                Text(item.location).font(.caption).foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
                    .eventRhythmFrame("new.location:\(item.id)")
            }
            if !item.note.isEmpty {
                Text(item.note).font(.caption.weight(.medium)).foregroundStyle(AssistantTheme.accent(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
                    .eventRhythmFrame("new.note:\(item.id)")
                    .padding(.top, 4)
            }
            if showCalendarAttribution && !calendarNames.isEmpty {
                Text(calendarNames.joined(separator: " · "))
                    .font(.caption).foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
            calendarActions(item)
        }
        .eventRhythmFrame("new.details:\(item.id)")
        let layout = stacksEventRows
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
        return layout {
            time
                .frame(width: stacksEventRows ? nil : 74, alignment: .leading)
                .eventRhythmFrame("new.clock:\(item.id)")
            details
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .eventRhythmFrame("new.row:\(item.id)")
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func calendarActions(_ item: MessageResponseCard.BriefingCard.AgendaItem) -> some View {
        if stacksRows {
            VStack(alignment: .leading, spacing: 2) { calendarActionLinks(item) }
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { calendarActionLinks(item) }
                VStack(alignment: .leading, spacing: 2) { calendarActionLinks(item) }
            }
        }
    }

    @ViewBuilder
    private func calendarActionLinks(_ item: MessageResponseCard.BriefingCard.AgendaItem) -> some View {
        ForEach(Array(item.calendarLinks.enumerated()), id: \.offset) { _, link in
            if let url = URL(string: link.url) {
                Link(destination: url) {
                    Label("Open event", systemImage: "calendar")
                        .font(.caption.weight(.medium)).frame(minHeight: 44, alignment: .leading)
                }
                .accessibilityLabel("Open \(item.title) in \(link.label)")
            }
        }
        if let meeting = item.meetingLink, let url = URL(string: meeting.url) {
            Link(destination: url) {
                Label(meeting.label.isEmpty ? "Join meeting" : meeting.label, systemImage: "video.fill")
                    .font(.caption.weight(.medium)).frame(minHeight: 44, alignment: .leading)
            }
            .accessibilityLabel("Join meeting for \(item.title)")
        }
    }

    private func attentionSection(
        title: String,
        items: [MessageResponseCard.BriefingCard.ListItem],
        overlaps: [MessageResponseCard.BriefingCard.Overlap],
        overlapCount: Int?,
        overlapsTruncated: Bool,
        itemCount: Int?,
        itemsTruncated: Bool
    ) -> some View {
        let availableItems = itemsTruncated && !items.isEmpty ? Array(items.dropLast()) : items
        let limitNotice = itemsTruncated ? items.last : nil
        return VStack(alignment: .leading, spacing: 8) {
            heading(title)
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                if item.title == title && itemCount == nil {
                    VStack(alignment: .leading, spacing: 2) {
                        if !item.detail.isEmpty {
                            Text(item.detail)
                                .font(.caption)
                                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if !item.meta.isEmpty {
                            Text(item.meta)
                                .font(.caption2.monospaced().weight(.semibold))
                                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        }
                    }
                } else if itemCount == nil {
                    listRow(item)
                }
            }
            if itemCount != nil {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(availableItems.prefix(3).enumerated()), id: \.offset) { _, item in
                        listRow(item)
                    }
                }
                if availableItems.count > 3 {
                    CardDisclosure(
                        collapsedLabel: "Show \(availableItems.count) available details",
                        expandedLabel: "Show fewer",
                        standalone: false
                    ) {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(availableItems.dropFirst(3).enumerated()), id: \.offset) { _, item in
                                listRow(item)
                            }
                        }
                    }
                }
                if let limitNotice {
                    Text(limitNotice.title)
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(overlaps.prefix(3).enumerated()), id: \.offset) { _, overlap in
                    overlapRow(overlap)
                }
            }
            if overlaps.count > 3 {
                CardDisclosure(
                    collapsedLabel: "Show \(overlaps.count) available details",
                    expandedLabel: "Show fewer",
                    standalone: false
                ) {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(overlaps.dropFirst(3).enumerated()), id: \.offset) { _, overlap in
                            overlapRow(overlap)
                        }
                    }
                }
            }
            if overlapsTruncated {
                let total = overlapCount ?? overlaps.count
                Text("\(overlaps.count) overlap details available of \(total) possible overlaps.")
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func overlapRow(_ overlap: MessageResponseCard.BriefingCard.Overlap) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(overlap.title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
            if !overlap.detail.isEmpty {
                Text(overlap.detail)
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func sectionView(_ section: MessageResponseCard.BriefingCard.Section) -> some View {
        switch section {
        case let .agenda(_, complete, omittedCount, items):
            agenda(items, complete: complete, omittedCount: omittedCount)
        case let .weather(title, location, temperature, condition, symbol, detail):
            VStack(alignment: .leading, spacing: 6) {
                heading(title.isEmpty ? "Weather" : title)
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: symbolName(symbol))
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                        .accessibilityHidden(true)
                    Text(temperature)
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    Text([condition, detail, location].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.subheadline)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
        case let .list(_, title, items, _, _, _, _, _):
            VStack(alignment: .leading, spacing: 8) {
                heading(title)
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    listRow(item)
                }
            }
        }
    }

    private func heading(_ text: String) -> some View {
        CardEyebrow(text)
            .accessibilityAddTraits(.isHeader)
    }

    private func agenda(
        _ items: [MessageResponseCard.BriefingCard.AgendaItem],
        complete: Bool,
        omittedCount: Int?
    ) -> some View {
        var days: [String] = []
        for item in items where !days.contains(item.day) { days.append(item.day) }
        return VStack(alignment: .leading, spacing: 20) {
            ForEach(days, id: \.self) { day in
                VStack(alignment: .leading, spacing: 12) {
                    heading(day)
                        .eventRhythmFrame("legacy.heading:\(day)")
                    VStack(alignment: .leading, spacing: 16) {
                        ForEach(Array(items.filter { $0.day == day }.enumerated()), id: \.offset) { _, item in
                            agendaRow(item)
                        }
                    }
                }
                .eventRhythmFrame("legacy.group:\(day)")
            }
            if let omittedCount {
                Text("\(omittedCount) additional \(omittedCount == 1 ? "event is" : "events are") not shown.")
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !complete {
                Text("Some calendars could not be read, so this may be incomplete.")
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            }
        }
    }

    @ViewBuilder
    private func agendaRow(_ item: MessageResponseCard.BriefingCard.AgendaItem) -> some View {
        // "9:30 AM – 10:30 AM" stacks start over end, so the column stays
        // narrow and neither half is ever cut off.
        let bounds = item.time.components(separatedBy: " – ")
        let time = VStack(alignment: .leading, spacing: 1) {
            Text(bounds.first ?? item.time)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
                .eventRhythmClockText("legacy.clock.start:\(item.id)", sourceText: bounds.first ?? item.time)
                .eventRhythmFrame("legacy.clock.start:\(item.id)")
            if bounds.count > 1 {
                Text(bounds.dropFirst().joined(separator: " – "))
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
                    .eventRhythmClockText("legacy.clock.end:\(item.id)", sourceText: bounds.dropFirst().joined(separator: " – "))
                    .eventRhythmFrame("legacy.clock.end:\(item.id)")
            }
        }
        .monospacedDigit()
        let details = VStack(alignment: .leading, spacing: 4) {
            Text(item.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
                .eventRhythmFrame("legacy.title:\(item.id)")
            if !item.location.isEmpty {
                Text(item.location)
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                    .fixedSize(horizontal: false, vertical: true)
                    .eventRhythmFrame("legacy.location:\(item.id)")
            }
            if !item.note.isEmpty {
                Label(item.note, systemImage: item.flag == "conflict" ? "exclamationmark.triangle.fill" : "sparkle")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(item.flag == "conflict"
                                     ? AssistantTheme.warningInk(for: colorScheme)
                                     : AssistantTheme.accent(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
                    .eventRhythmFrame("legacy.note:\(item.id)")
                    .padding(.top, 4)
            }
        }
        .eventRhythmFrame("legacy.details:\(item.id)")
        if stacksEventRows {
            VStack(alignment: .leading, spacing: 8) {
                time.eventRhythmFrame("legacy.clock:\(item.id)")
                details
            }
            .eventRhythmFrame("legacy.row:\(item.id)")
            .accessibilityElement(children: .combine)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                // The clock column keeps its own width so titles line up.
                time
                    .frame(width: 74, alignment: .leading)
                    .eventRhythmFrame("legacy.clock:\(item.id)")
                details
            }
            .eventRhythmFrame("legacy.row:\(item.id)")
            .accessibilityElement(children: .combine)
        }
    }

    private func listRow(_ item: MessageResponseCard.BriefingCard.ListItem) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
                if !item.detail.isEmpty {
                    Text(item.detail)
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .lineLimit(3)
                }
            }
            Spacer(minLength: 0)
            if !item.meta.isEmpty {
                Text(item.meta)
                    .font(.caption2.monospaced().weight(.semibold))
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .lineLimit(1)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func symbolName(_ symbol: String) -> String {
        switch symbol {
        case "thunderstorm": "cloud.bolt.rain.fill"
        case "snow": "cloud.snow.fill"
        case "sleet": "cloud.sleet.fill"
        case "drizzle": "cloud.drizzle.fill"
        case "rain": "cloud.rain.fill"
        case "fog": "cloud.fog.fill"
        case "partly-cloudy": "cloud.sun.fill"
        case "cloudy": "cloud.fill"
        default: "sun.max.fill"
        }
    }
}

#if DEBUG
/// Observe the original native layout only during the opt-in event review.
/// Public CharacterIndex values do not provide a String/Unicode terminal map.
private struct EventRhythmClockTextRenderer: TextRenderer {
    let id: String
    let sourceText: String
    let report: @Sendable (String, EventRhythmTextSample) -> Void

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        // The public SDK draws Line/Run/RunSlice, not a complete Text.Layout.
        // Forward every original line without changing its layout or graphics state.
        for line in layout { context.draw(line) }
        report(id, .init(sourceText: sourceText, isTruncated: layout.isTruncated,
                         lineBounds: layout.map { $0.typographicBounds.rect },
                         runBounds: layout.flatMap { line in line.map { $0.typographicBounds.rect } }))
    }
}
private struct EventRhythmClockTextReview: ViewModifier {
    let id: String
    let sourceText: String
    @Environment(\.eventRhythmReview) private var review

    @ViewBuilder func body(content: Content) -> some View {
        if let review {
            content.textRenderer(EventRhythmClockTextRenderer(id: id, sourceText: sourceText, report: review.reportText))
        } else {
            content
        }
    }
}
#endif
private extension View {
    @ViewBuilder func eventRhythmClockText(_ id: String, sourceText: String) -> some View {
#if DEBUG
        modifier(EventRhythmClockTextReview(id: id, sourceText: sourceText))
#else
        self
#endif
    }
}
