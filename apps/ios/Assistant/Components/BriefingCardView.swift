import SwiftUI

/// The daily briefing: its one-line lead, then short labelled sections — the
/// schedule by day, the weather in one line, and lists for what needs the
/// owner. Every value arrives pre-formatted in the owner's zone, so this view
/// only lays it out. Mirrors `BriefingCard` in the web transcript.
struct BriefingCardView: View {
    let card: MessageResponseCard.BriefingCard

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var stacksRows: Bool { dynamicTypeSize.isAccessibilitySize }

    var body: some View {
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

    @ViewBuilder
    private func sectionView(_ section: MessageResponseCard.BriefingCard.Section) -> some View {
        switch section {
        case let .agenda(_, complete, items):
            agenda(items, complete: complete)
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
        case let .list(_, title, items):
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

    private func agenda(_ items: [MessageResponseCard.BriefingCard.AgendaItem], complete: Bool) -> some View {
        var days: [String] = []
        for item in items where !days.contains(item.day) { days.append(item.day) }
        return VStack(alignment: .leading, spacing: 14) {
            ForEach(days, id: \.self) { day in
                VStack(alignment: .leading, spacing: 8) {
                    heading(day)
                    ForEach(Array(items.filter { $0.day == day }.enumerated()), id: \.offset) { _, item in
                        agendaRow(item)
                    }
                }
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
            if bounds.count > 1 {
                Text(bounds.dropFirst().joined(separator: " – "))
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            }
        }
        .monospacedDigit()
        let details = VStack(alignment: .leading, spacing: 2) {
            Text(item.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
            if !item.location.isEmpty {
                Text(item.location)
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .lineLimit(2)
            }
            if !item.note.isEmpty {
                Label(item.note, systemImage: item.flag == "conflict" ? "exclamationmark.triangle.fill" : "sparkle")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(item.flag == "conflict"
                                     ? AssistantTheme.warningInk(for: colorScheme)
                                     : AssistantTheme.accent(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        if stacksRows {
            VStack(alignment: .leading, spacing: 2) {
                time
                details
            }
            .accessibilityElement(children: .combine)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                // The clock column keeps its own width so titles line up.
                time
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                    .frame(width: 74, alignment: .leading)
                details
            }
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
