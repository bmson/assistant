import EventKit
import EventKitUI
import SwiftUI

/// A saved permission deserves its own review, rather than a paragraph-sized button.
struct AssistantAlwaysApproveButton: View {
    let scope: String
    var fillsWidth = false
    let action: () async -> Void

    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.scenePhase) private var scenePhase
    @State private var reviewing = false
    @State private var working = false

    var body: some View {
        Button {
            reviewing = true
        } label: {
            HStack(spacing: 8) {
                ZStack {
                    Image(systemName: "checkmark.shield").opacity(working ? 0 : 1)
                    if working { ProgressView().controlSize(.small) }
                }
                .frame(width: 16)
                Text("Always approve")
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .buttonStyle(AssistantActionButtonStyle(kind: .neutral, compact: true, fillsWidth: fillsWidth))
        .disabled(working)
        .accessibilityLabel(working ? "Saving approval rule" : "Always approve")
        .accessibilityHint("Reviews the permission before approving this request and saving it for future matching actions.")
        .confirmationDialog("Always approve matching actions?", isPresented: $reviewing, titleVisibility: .visible) {
            Button("Approve and save") {
                guard !working, isEnabled else { return }
                working = true
                Task {
                    await action()
                    working = false
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(scope)\n\nThis approves the current request and saves this permission for future matching actions. You can pause or remove it in More → Standing approvals.")
        }
        .onChange(of: isEnabled) { _, enabled in
            if !enabled { reviewing = false }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { reviewing = false }
        }
    }
}

/// A calendar entry a card proposes: the owner sees it in the system sheet,
/// can change anything, and nothing is written unless they tap Add. The
/// sheet runs outside the app, so no calendar permission is asked for.
struct CalendarDraft: Identifiable {
    let id: String
    let title: String
    let start: Date
    let end: Date
    let location: String
    let timeZone: TimeZone

    /// From a card's `add_to_calendar` facts: zoned instants, which the server
    /// has already insisted on. An entry with no end runs an hour.
    init?(identity: String = UUID().uuidString, title: String, start: String, end: String?, location: String?) {
        guard let begin = GeneratedCardValue.instant(start) else { return nil }
        id = identity
        let finish = end.flatMap(GeneratedCardValue.instant)?.date
        self.title = title
        self.start = begin.date
        self.end = max(finish ?? begin.date.addingTimeInterval(3600), begin.date)
        self.location = location ?? ""
        timeZone = begin.zone
    }
}

struct AddToCalendarButton: View {
    let label: String
    let draft: CalendarDraft
    @State private var presented: CalendarDraft?

    var body: some View {
        Button {
            presented = draft
        } label: {
            Label(label, systemImage: "calendar.badge.plus")
        }
        .buttonStyle(CardActionButtonStyle())
        .accessibilityHint("Opens a new calendar event with these details for you to review.")
        .sheet(item: $presented) { draft in
            CalendarEventEditor(draft: draft) { presented = nil }
                .ignoresSafeArea()
        }
    }
}

/// `EKEventEditViewController`, prefilled. On iOS 17 and later it runs out of
/// process, so the app needs no calendar access to offer it.
private struct CalendarEventEditor: UIViewControllerRepresentable {
    let draft: CalendarDraft
    let done: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(done: done) }

    func makeUIViewController(context: Context) -> EKEventEditViewController {
        let store = EKEventStore()
        let event = EKEvent(eventStore: store)
        event.title = draft.title
        event.startDate = draft.start
        event.endDate = draft.end
        event.timeZone = draft.timeZone
        event.location = draft.location.isEmpty ? nil : draft.location
        let controller = EKEventEditViewController()
        controller.eventStore = store
        controller.event = event
        controller.editViewDelegate = context.coordinator
        return controller
    }

    func updateUIViewController(_: EKEventEditViewController, context _: Context) {}

    final class Coordinator: NSObject, EKEventEditViewDelegate {
        let done: () -> Void
        init(done: @escaping () -> Void) { self.done = done }

        func eventEditViewController(
            _ controller: EKEventEditViewController,
            didCompleteWith _: EKEventEditViewAction
        ) {
            done()
        }
    }
}

extension GeneratedCardValue {
    /// Apple Maps directions to a place as the card names it.
    static func directionsURL(_ place: String) -> URL? {
        var components = URLComponents(string: "https://maps.apple.com/")
        components?.queryItems = [.init(name: "daddr", value: place)]
        return components?.url
    }

    /// A card as plain text for the share sheet: its title, then each fact on
    /// its own line with times on their own clocks. Sensitive facts stay out —
    /// sharing is not a way around their reveal control.
    static func shareText(_ card: MessageResponseCard.GeneratedCard) -> String {
        let facts = card.facts
            .filter { !$0.sensitive }
            .map { fact in
                let value = displayInstant(fact.value) ?? fact.value
                return "\(CardText.presentationLabel(fact.label)): \(value)"
            }
        return ([card.title, card.subtitle].filter { !$0.isEmpty } + facts).joined(separator: "\n")
    }
}
