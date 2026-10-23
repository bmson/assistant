import XCTest
import SwiftUI
import Observation
@testable import Assistant

@MainActor
private final class LiftedTranscriptFixtureState: ObservableObject {
    @Published var reveal: CGFloat = 0
    @Published var composerHeight: CGFloat = 60
    @Published var availableHeight: CGFloat = 852
    @Published var jumpRequest = 0
    @Published var noticeHeight: CGFloat = 0
    @Published var showsJumpChrome = false
    var transcriptViewport: TranscriptGeometryMeasurement?
    var composer: CGRect = .zero
    var notice: CGRect = .zero
    var lastCard: TranscriptGeometryMeasurement?
}

private struct LiftedTranscriptFixture: View {
    @ObservedObject var state: LiftedTranscriptFixtureState
    @State private var position = ScrollPosition()
    var body: some View {
        GeometryReader { viewport in
            ZStack(alignment: .bottom) {
                Color.gray.frame(height: 450)
                ConversationColumn {
                    Group {
                        ScrollView {
                            // Eager, as the transcript is: content can draw
                            // behind the chrome while its final row keeps a
                            // real clearance above the composer.
                            VStack(spacing: 0) {
                                ForEach(0..<20) { _ in Color.white.frame(height: 200) }
                                Color.red.frame(height: 100)
                                    .onTranscriptGeometryChange { measurement in
                                        state.lastCard = measurement
                                    }
                            }
                            .padding(.bottom, state.composerHeight + 30
                                + (state.noticeHeight > 0 ? state.noticeHeight + 8 : 0))
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .onTranscriptGeometryChange { measurement in
                            state.transcriptViewport = measurement
                        }
                        .scrollPosition($position)
                        .transaction {
                            if state.reveal > 0 {
                                $0.scrollContentOffsetAdjustmentBehavior = .disabled
                            }
                        }
                        .defaultScrollAnchor(.bottom)
                        .onChange(of: state.jumpRequest) { _, _ in
                            position.scrollTo(edge: .bottom)
                        }
                    }
                } composer: {
                    Color.blue.frame(height: state.composerHeight)
                        .padding(.bottom, 12)
                        .onGeometryChange(for: CGRect.self) {
                            $0.frame(in: .global)
                        } action: {
                            state.composer = $0
                        }
                }
                .frame(width: viewport.size.width, height: viewport.size.height)
                .overlay(alignment: .bottom) {
                    if state.noticeHeight > 0 {
                        Color.purple
                            .frame(height: state.noticeHeight)
                            .onGeometryChange(for: CGRect.self) {
                                $0.frame(in: .global)
                            } action: {
                                state.notice = $0
                            }
                            .padding(.bottom, state.composerHeight + 20)
                    }
                }
                .overlay(alignment: .bottomTrailing) {
                    if state.showsJumpChrome {
                        Color.orange
                            .frame(width: 120, height: 44)
                            .padding(.bottom, state.composerHeight + 30
                                + (state.noticeHeight > 0 ? state.noticeHeight : 0))
                    }
                }
                .background(Color.green.ignoresSafeArea(.container))
                .clipShape(RoundedRectangle(cornerRadius: 34))
                .offset(y: -state.reveal)
            }
        }
        .frame(height: state.availableHeight, alignment: .top)
        .ignoresSafeArea(.container)
    }
}

@MainActor
private final class SourcesScrollFixtureState: ObservableObject {
    @Published var expanded = false
}

private struct SourcesScrollFixture: View {
    @ObservedObject var state: SourcesScrollFixtureState
    var body: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                Color.clear.frame(height: 900)
                Text("Sources and details").frame(height: 44)
                if state.expanded { Text("Evidence").frame(height: 450) }
                Text("Newest answer").frame(height: 360)
                Color.clear.frame(height: 80)
            }
        }
        .defaultScrollAnchor(.bottom)
    }
}

/// Locks in the block parser's behavior on the shapes LLM replies actually
/// take — nested bullets, mixed lists, fenced code, and tables — so a
/// regression in the chat bubble's markdown is caught by a test instead of a
/// blank screenshot.
final class AssistantMarkdownTests: XCTestCase {
    @MainActor
    func testStyledDecisionReceiptSnapshots() throws {
        for (name, scheme, size, width) in [
            ("light", ColorScheme.light, DynamicTypeSize.large, CGFloat(390)),
            ("dark", .dark, .large, 390),
            ("narrow", .light, .large, 320),
            ("accessible", .light, .accessibility3, 390)
        ] {
            let view = VStack(spacing: 12) {
                ForEach([false, true], id: \.self) { expanded in
                    DecisionReceiptCard(title: "Declined",
                        summary: "Fetch the public web page https://www.yelp.com/search?find_desc=Restaurants&find_loc=San%20Francisco",
                        detail: "No action was taken from this request.", code: "A123",
                        symbol: "xmark.circle.fill", tint: AssistantTheme.errorInk(for: scheme),
                        initiallyExpanded: expanded)
                }
                DecisionReceiptCard(title: "Approved", summary: "Send the updated soccer schedule to Katie",
                    detail: "This request was approved.", code: nil, symbol: "checkmark.circle.fill",
                    tint: AssistantTheme.success(for: scheme), initiallyExpanded: true)
            }
            .padding(16).frame(width: width).background(AssistantTheme.stage)
            .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.uiImage)
            XCTAssertEqual(image.size.width, width)
            let attachment = XCTAttachment(image: image)
            attachment.name = "styled-decision-receipts-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    @MainActor
    func testExpandedCardDisclosureSnapshots() throws {
        let cards: [MessageResponseCard] = [
            .search(id: "search", title: "Web results", query: "Frontend engineering roles in San Francisco",
                results: [.init(id: "one", title: "Frontend engineer — design systems and accessibility",
                    url: "https://example.com/jobs", snippet: "Build reusable components with a small product team. Help make the interface work well for everyone.")]),
            .proactiveAlert(id: "event", category: "event", urgency: "Tomorrow",
                title: "Soccer match at Morgan Hill Outdoor Sports Center", summary: "",
                startsAt: "2026-09-06T18:00:00-07:00", dueAt: "",
                details: [.init(label: "Location", value: "16500 Condit Road, Morgan Hill, CA")])
        ]
        for (name, scheme, size, width) in [
            ("light", ColorScheme.light, DynamicTypeSize.large, CGFloat(390)),
            ("dark", .dark, .large, 390),
            ("narrow", .light, .large, 320),
            ("accessible", .light, .accessibility3, 390)
        ] {
            for expanded in [false, true] {
                let view = CardDisclosure(collapsedLabel: "Show 2 more results",
                    expandedLabel: "Showing all 5 results", standalone: true,
                    showsBottomCollapse: true, initiallyExpanded: expanded) {
                    RichResponseCards(cards: cards)
                }
                .padding(16).frame(width: width).background(AssistantTheme.stage)
                .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
                let renderer = ImageRenderer(content: view)
                renderer.scale = 2
                let image = try XCTUnwrap(renderer.uiImage)
                XCTAssertEqual(image.size.width, width)
                if expanded { XCTAssertGreaterThan(image.size.height, 300) }
                let attachment = XCTAttachment(image: image)
                attachment.name = "card-disclosure-\(name)-\(expanded ? "expanded" : "collapsed")"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
    }

    @MainActor
    func testExpandedDisclosureKeepsCompactControlSpacing() throws {
        for standalone in [false, true] {
            let view = CardDisclosure(collapsedLabel: "More", expandedLabel: "Show fewer",
                standalone: standalone, showsBottomCollapse: true, initiallyExpanded: true) {
                Color.red.frame(height: 40)
            }.frame(width: 320)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 1
            let image = try XCTUnwrap(renderer.uiImage)
            let gap: CGFloat = standalone ? 8 : 10
            XCTAssertEqual(image.size, CGSize(width: 320, height: 44 * 2 + gap * 2 + 40),
                "Two 44pt controls, two \(gap)pt gaps, and 40pt of full-width content")
        }
    }

    @MainActor
    func testPolishedResultCardSnapshots() throws {
        let data = Data(#"""
        {"id":"polish","role":"assistant","parts":[
          {"type":"data-card","data":{"kind":"proactive-alert","id":"event","category":"event","urgencyLabel":"Starts in 30 min","title":"26/27 U13B Azul @ Almaden FC U13B Mercury Black","summary":"","startsAt":"2026-09-05T18:00:00-07:00","details":[{"label":"Location","value":"Morgan Hill Outdoor Sports Center, 16500 Condit Road, Morgan Hill, CA"},{"label":"Calendar","value":"Family · Soccer season 2026–2027"}]}},
          {"type":"data-card","data":{"kind":"web-search-results","id":"search","title":"Web results","query":"frontend engineer Next.js TypeScript San Francisco 2026 jobs","results":[{"id":"one","title":"Best <strong>Front End</strong> Developer Jobs &amp; Careers","url":"https://example.com/jobs","snippet":"Build <strong>accessible</strong> interfaces &amp; reusable components. Work with design &mdash; and ship thoughtful products."}]}},
          {"type":"data-card","data":{"kind":"email-results","id":"mail","title":"Email results","query":"hotel reservation confirmation","messages":[{"id":"abc123","sender":"Travel Team <travel@example.com>","subject":"Your upcoming hotel reservation","date":"2026-09-04T12:00:00Z","snippet":"From: Travel &lt;travel@example.com&gt; <br> Your reservation is confirmed &amp; ready to view."}]}}
        ]}
        """#.utf8)
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        XCTAssertEqual(message.parts.compactMap(MessageResponseCard.init(part:)).count, 3)
        for (name, scheme, size, width) in [
            ("light", ColorScheme.light, DynamicTypeSize.large, CGFloat(390)),
            ("dark", .dark, .large, 390),
            ("narrow", .light, .large, 320),
            ("accessible", .light, .accessibility3, 390)
        ] {
            let view = RichResponseCards(cards: message.parts.compactMap(MessageResponseCard.init(part:)))
                .padding(16).frame(width: width).background(AssistantTheme.stage)
                .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.uiImage)
            XCTAssertEqual(image.size.width, width)
            let attachment = XCTAttachment(image: image)
            attachment.name = "polished-result-cards-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    /// Numeric forecast days render as fixed-column single-line rows; the
    /// same card without `days` keeps its older text layout.
    @MainActor
    func testWeatherForecastRowsSnapshots() throws {
        let data = Data(#"""
        {"id":"weather","role":"assistant","parts":[
          {"type":"data-card","data":{"kind":"weather","id":"w","location":"San Francisco","temperature":"18°C","condition":"Partly cloudy with scattered showers","symbol":"partly-cloudy",
            "current":{"tempC":18,"lowC":14,"highC":21,"precipPct":40,"windKmh":18,"humidity":70},
            "days":[
              {"weekday":"Today","lowC":14,"highC":21,"precipPct":40,"description":"partly cloudy","symbol":"partly-cloudy"},
              {"weekday":"Wed","lowC":12,"highC":17,"precipPct":80,"description":"light rain","symbol":"rain"},
              {"weekday":"Thu","lowC":11,"highC":19,"description":"overcast","symbol":"cloudy"},
              {"weekday":"Fri","lowC":13,"highC":24,"description":"clear","symbol":"clear"}
            ],
            "details":[{"label":"Today","value":"14–21°C"},{"label":"Wind","value":"18 km/h"},{"label":"Wed","value":"12–17°C, light rain, 80% chance of rain","symbol":"rain"}]}}
        ]}
        """#.utf8)
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        let cards = message.parts.compactMap(MessageResponseCard.init(part:))
        guard case let .weather(_, _, _, _, _, forecast)? = cards.first else {
            return XCTFail("expected a weather card")
        }
        XCTAssertEqual(forecast.days.map(\.weekday), ["Today", "Wed", "Thu", "Fri"])
        XCTAssertNil(forecast.days[2].precipPct)
        XCTAssertEqual(forecast.current?.windKmh, 18)

        let legacy = try JSONDecoder().decode(ChatMessage.self, from: Data(#"{"id":"old","role":"assistant","parts":[{"type":"data-card","data":{"kind":"weather","id":"w","temperature":"18°C","condition":"Clear","details":[{"label":"Tue","value":"16–23°C, clear"}]}}]}"#.utf8))
        guard case let .weather(_, _, _, details, _, oldForecast)? = legacy.parts.compactMap(MessageResponseCard.init(part:)).first else {
            return XCTFail("expected a legacy weather card")
        }
        XCTAssertTrue(oldForecast.days.isEmpty)
        XCTAssertEqual(details.count, 1)

        for (name, size, width) in [
            ("390", DynamicTypeSize.large, CGFloat(390)),
            ("320", .large, 320),
            ("accessible", .accessibility3, 390),
        ] {
            let view = RichResponseCards(cards: cards)
                .padding(16).frame(width: width).background(AssistantTheme.stage)
                .environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.uiImage)
            XCTAssertEqual(image.size.width, width)
            let attachment = XCTAttachment(image: image)
            attachment.name = "weather-rows-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    /// The briefing renders as a lead and labelled sections and stays the
    /// primary surface even when a conflicts card rides along with it.
    @MainActor
    func testBriefingCardSnapshots() throws {
        let data = Data(#"""
        {"id":"brief","role":"assistant","parts":[
          {"type":"text","text":"Two overlapping events this morning.\n\n**Today**\n- **9:30 AM – 10:30 AM** — Dentist"},
          {"type":"data-card","data":{"kind":"briefing","id":"b1","date":"Tuesday, Sep 22","timeZone":"America/Los_Angeles",
            "lead":"Two overlapping events this morning, and one approval is waiting on you.",
            "sections":[
            {"type":"agenda","title":"Schedule","complete":true,"omittedCount":3,"items":[
                {"day":"Today","time":"9:30 AM – 10:30 AM","title":"Dentist","location":"Laugavegur 12, Reykjavík","flag":"conflict","note":"Overlaps another event"},
                {"day":"Today","time":"10:00 AM – 11:00 AM","title":"Interview with Linear","flag":"conflict","note":"Overlaps another event"},
                {"day":"Tomorrow","time":"All day","title":"Team offsite"}]},
              {"type":"weather","title":"Weather","location":"San Francisco","temperature":"18°C","condition":"overcast","symbol":"cloudy","range":"14–21°C"},
              {"type":"attention","title":"Needs you","items":[{"title":"Fetch public web page en.wikipedia.org/wiki/Berlin","meta":"A128DY"},{"title":"Job search","detail":"Waiting on whether to search remote only or specific locations."}]},
              {"type":"mail","title":"Mail worth reading","items":[{"title":"Delta","detail":"Your itinerary changed for Friday"}]}
            ]}},
          {"type":"data-card","data":{"kind":"calendar-conflicts","id":"c1","title":"Possible schedule conflict","complete":false,"conflicts":[{"id":"one","overlapStart":"2026-10-07T19:00:00Z","overlapEnd":"2026-10-07T20:00:00Z","evidenceNote":"Keep the earlier arrival time; identity is unverified.","groups":[{"events":[{"id":"a","title":"Arrival","start":"2026-10-07T18:15:00Z","calendar":"Family"}]},{"events":[{"id":"b","title":"Kickoff","start":"2026-10-07T19:00:00Z","calendar":"Team"}]}]}]}}
        ]}
        """#.utf8)
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        XCTAssertFalse(message.hasSupportingResultCards)
        let cards = message.parts.compactMap(MessageResponseCard.init(part:))
        guard case let .briefing(briefing)? = cards.first else { return XCTFail("expected a briefing card") }
        XCTAssertEqual(briefing.sections.count, 4)
        guard case let .agenda(_, _, omittedCount, _)? = briefing.sections.first else {
            return XCTFail("expected a briefing agenda section")
        }
        XCTAssertEqual(omittedCount, 3)
        guard case let .calendarConflicts(_, _, conflicts, complete)? = cards.last else { return XCTFail("expected overlap evidence") }
        XCTAssertFalse(complete)
        XCTAssertEqual(conflicts.first?.evidenceNote, "Keep the earlier arrival time; identity is unverified.")
        XCTAssertEqual(conflicts.first?.groups.first?.first?.start, "2026-10-07T18:15:00Z")
        XCTAssertTrue(MessageResponseCard.replacesProse(cards))

        for (name, size, width) in [
            ("390", DynamicTypeSize.large, CGFloat(390)),
            ("320", .large, 320),
            ("accessible", .accessibility3, 390),
        ] {
            let view = RichResponseCards(cards: [.briefing(briefing)])
                .padding(16).frame(width: width).background(AssistantTheme.stage)
                .environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.uiImage)
            let attachment = XCTAttachment(image: image)
            attachment.name = "briefing-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    func testBriefingAgendaOmittedCountRejectsMalformedValues() throws {
        for (index, value) in ["0", "-1", "1.5", "\"2\"", "9007199254740992", "9223372036854775808"].enumerated() {
            let payload = """
            {"kind":"briefing","id":"brief-\(index)","lead":"Schedule","sections":[{"type":"agenda","omittedCount":\(value),"items":[{"day":"Today","time":"9 AM","title":"Check-in"}]}]}
            """
            let message = try JSONDecoder().decode(ChatMessage.self, from: Data(#"{"id":"message","role":"assistant","parts":[{"type":"data-card","data":\#(payload)}]}"#.utf8))
            let cards = message.parts.compactMap(MessageResponseCard.init(part:))
            guard case let .briefing(briefing)? = cards.first,
                  case let .agenda(_, _, omittedCount, _)? = briefing.sections.first else {
                return XCTFail("expected a decoded agenda for omittedCount \(value)")
            }
            XCTAssertNil(omittedCount, "Malformed omittedCount \(value) must not be shown")
        }
    }

    @MainActor
    func testCalendarAgendaMarkedBriefingSnapshotsAllRowsAtNarrowAndAXSizes() throws {
        let rows = (0..<8).map { index in
            """
            {"id":"review-\(index)","day":"\(index == 0 ? "All day" : "Timed")","time":"\(index == 0 ? "All day" : "9:\(index)0 AM")","title":"\(index == 0 ? "City holiday" : "Long planning session with the design team \(index)")","location":"\(index == 0 ? "" : "Conference room \(index)")","note":"\(index == 1 ? "Needs response" : "")","calendars":["Personal","Work"],"calendarLinks":[{"label":"Open in Work","url":"https://calendar.google.com/event/\(index)"}],"meetingLink":{"label":"Join meeting","url":"https://meet.google.com/review-\(index)"}}
            """
        }.joined(separator: ",")
        let json = """
        {"id":"agenda-review","role":"assistant","parts":[{"type":"data-card","data":{"kind":"briefing","id":"agenda-review","presentation":"calendar-agenda","title":"Agenda","date":"Tuesday, October 27 · Pacific Time","lead":"Eight events across Personal and Work; all calendars checked.","sections":[{"type":"agenda","title":"Tuesday, October 27","complete":true,"items":[\(rows)]}]}}]}
        """
        let message = try JSONDecoder().decode(ChatMessage.self, from: Data(json.utf8))
        let cards = message.parts.compactMap(MessageResponseCard.init(part:))
        guard case let .briefing(briefing)? = cards.first,
              case let .agenda(_, _, _, items)? = briefing.sections.first else {
            return XCTFail("Expected the marked calendar agenda")
        }
        XCTAssertEqual(items.count, 8)

        for (name, scheme, size) in [
            ("narrow-light", ColorScheme.light, DynamicTypeSize.large),
            ("narrow-dark-accessibility3", .dark, .accessibility3),
        ] {
            let view = RichResponseCards(cards: [.briefing(briefing)])
                .padding(12).frame(width: 320).background(AssistantTheme.stage)
                .environment(\.colorScheme, scheme)
                .environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.uiImage)
            let attachment = XCTAttachment(image: image)
            attachment.name = "calendar-agenda-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    /// A scoreboard decodes both teams, keeps the reply above it, asks the
    /// live endpoint only for games that can still change, and renders.
    @MainActor
    func testScoreboardCardSnapshots() throws {
        let data = Data(#"""
        {"id":"scores","role":"assistant","parts":[
          {"type":"text","text":"The Giants lead the Twins 5-2 in the 7th."},
          {"type":"data-card","data":{"kind":"scoreboard","id":"s1","title":"MLB","fetchedAt":"2026-09-22T02:10:00Z","accompaniesProse":true,
            "live":{"provider":"espn","pollSeconds":30,"leagues":[{"league":"mlb","eventIds":["2"]}]},
            "games":[
              {"id":"1","league":"mlb","leagueLabel":"MLB","state":"post","statusText":"Final","startsAt":"2026-09-21T01:45Z",
               "home":{"id":"10","name":"New York Yankees","shortName":"Yankees","abbreviation":"NYY","score":"2","winner":true,"record":"90-66"},
               "away":{"id":"30","name":"Tampa Bay Rays","shortName":"Rays","abbreviation":"TB","score":"0","winner":false,"record":"72-84"}},
              {"id":"2","league":"mlb","leagueLabel":"MLB","state":"in","statusText":"Top 7th","startsAt":"2026-09-22T01:45Z","venue":"Oracle Park","broadcast":"NBC Sports Bay Area",
               "link":"https://www.espn.com/mlb/game/_/gameId/2","home":{"id":"26","name":"San Francisco Giants","shortName":"Giants","abbreviation":"SF","score":"5"},
               "away":{"id":"9","name":"Minnesota Twins","shortName":"Twins","abbreviation":"MIN","score":"2","logo":"https://attacker.example/x.png"}}
            ]}}
        ]}
        """#.utf8)
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        let cards = message.parts.compactMap(MessageResponseCard.init(part:))
        guard case let .scoreboard(_, title, games, fetchedAt, poll, live)? = cards.first else {
            return XCTFail("expected a scoreboard")
        }
        XCTAssertEqual(title, "MLB")
        XCTAssertNotNil(fetchedAt)
        XCTAssertNotNil(ISO8601DateFormatter.flexible("2026-09-22T02:10:00.123Z"), "server stamps carry milliseconds")
        XCTAssertNotNil(ISO8601DateFormatter.flexible("2026-09-22T01:45Z"), "the provider writes minutes only")
        XCTAssertEqual(poll, 30)
        XCTAssertTrue(live)
        XCTAssertEqual(games.map(\.state), ["post", "in"])
        XCTAssertNil(games[1].away.logo, "logos only from the provider CDN")
        XCTAssertNil(ScoreGame.approvedLogoURL("https://attackerespncdn.com/logo.png"))
        XCTAssertNil(ScoreGame.approvedLogoURL("https://espncdn.com.attacker.test/logo.png"))
        XCTAssertNil(ScoreGame.approvedLogoURL("https://user@espncdn.com/logo.png"))
        XCTAssertNil(ScoreGame.approvedLogoURL("https://espncdn.com:8443/logo.png"))
        XCTAssertEqual(ScoreGame.approvedLogoURL("https://a.espncdn.com/logo.png")?.host, "a.espncdn.com")
        XCTAssertEqual(liveScoreQuery(games), "mlb:2")
        XCTAssertFalse(MessageResponseCard.replacesProse(cards), "the reply stays above the board")

        for (name, size, width) in [
            ("390", DynamicTypeSize.large, CGFloat(390)),
            ("320", .large, 320),
            ("accessible", .accessibility3, 390),
        ] {
            let view = RichResponseCards(cards: cards)
                .padding(16).frame(width: width).background(AssistantTheme.stage)
                .environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.uiImage)
            let attachment = XCTAttachment(image: image)
            attachment.name = "scoreboard-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    /// A multi-part answer marks every card to sit under the reply. A weather
    /// card alone replaces its prose; beside a scoreboard it must not, or the
    /// words answering the other part disappear.
    func testMultiPartCardsKeepTheReply() throws {
        let data = Data(#"""
        {"id":"multi","role":"assistant","parts":[
          {"type":"text","text":"The Giants won 5-2. It is 18°C and foggy in San Francisco."},
          {"type":"data-card","data":{"kind":"scoreboard","id":"s1","title":"MLB","accompaniesProse":true,"games":[]}},
          {"type":"data-card","data":{"kind":"weather","id":"w1","place":"San Francisco","temperature":"18°C","accompaniesProse":true}}
        ]}
        """#.utf8)
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        XCTAssertTrue(MessageResponseCard.allSitUnderProse(message.parts))

        let alone = Data(#"""
        {"id":"weather","role":"assistant","parts":[
          {"type":"text","text":"It is 18°C and foggy."},
          {"type":"data-card","data":{"kind":"weather","id":"w1","place":"San Francisco","temperature":"18°C"}}
        ]}
        """#.utf8)
        let single = try JSONDecoder().decode(ChatMessage.self, from: alone)
        XCTAssertFalse(MessageResponseCard.allSitUnderProse(single.parts), "a lone weather card still stands in")
        XCTAssertFalse(MessageResponseCard.allSitUnderProse([]))
    }

    /// A route decodes both ends and its line, keeps the reply above it, and
    /// formats time and distance by the device's measurement system.
    @MainActor
    func testRouteCardDecodesAndRenders() throws {
        let data = Data(#"""
        {"id":"trip","role":"assistant","parts":[
          {"type":"text","text":"About 9 minutes by car; leave by 11:50 for noon."},
          {"type":"data-card","data":{"kind":"route","id":"r1","mode":"driving","accompaniesProse":true,
            "origin":{"label":"Current Location","lat":37.7857,"lng":-122.4011,"current":true},
            "destination":{"label":"Oracle Park","address":"24 Willie Mays Plaza, San Francisco","lat":37.7786,"lng":-122.3893},
            "durationSeconds":540,"distanceMeters":1850,"departAt":"2026-09-22T18:51:00.000Z","arriveAt":"2026-09-22T19:00:00.000Z",
            "routeName":"King St","steps":[{"instruction":"Turn right onto Howard St","distanceMeters":900}],
            "polyline":"_p~iF~ps|U_ulLnnqC_mqNvxq`@",
            "mapsUrl":"https://maps.apple.com/?saddr=37.7857%2C-122.4011&daddr=37.7786%2C-122.3893&dirflg=d"}}
        ]}
        """#.utf8)
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        let cards = message.parts.compactMap(MessageResponseCard.init(part:))
        guard case let .route(route)? = cards.first else { return XCTFail("expected a route") }
        XCTAssertEqual(route.destination.label, "Oracle Park")
        XCTAssertTrue(route.origin.current)
        XCTAssertEqual(route.line.count, 3)
        XCTAssertEqual(route.line[0].latitude, 38.5, accuracy: 0.00001)
        XCTAssertEqual(route.line[2].longitude, -126.453, accuracy: 0.00001)
        XCTAssertNotNil(route.mapsURL)
        XCTAssertFalse(MessageResponseCard.replacesProse(cards), "the reply stays above the map")
        XCTAssertEqual(RouteCardView.duration(540), "9 min")
        XCTAssertEqual(RouteCardView.duration(5400), "1 hr 30 min")
        XCTAssertEqual(RouteCardView.distance(1850, locale: Locale(identifier: "en_US")), "1.1 mi")
        XCTAssertEqual(RouteCardView.distance(1850, locale: Locale(identifier: "is_IS")), "1,9 km")

        let renderer = ImageRenderer(content: RichResponseCards(cards: cards).padding(16).frame(width: 390)
            .background(AssistantTheme.stage))
        renderer.scale = 2
        let attachment = XCTAttachment(image: try XCTUnwrap(renderer.uiImage))
        attachment.name = "route-390"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    func testApprovalSummaryDecisionTransitionSnapshots() throws {
        let pending = ChatMessage(id: "approval-summary", role: .assistant, parts: [
            .init(type: "approval-summary", purpose: "Find an open cafe nearby", approvalCount: 1,
                approvalIds: ["qa-approval"], pendingCount: 1,
                outcomes: [.init(id: "qa-approval", summary: "Search for a cafe nearby", status: "pending")])
        ])
        for (name, scheme, size) in [
            ("light", ColorScheme.light, DynamicTypeSize.large),
            ("dark", .dark, .large),
            ("accessible", .light, .accessibility3)
        ] {
            let messages = [pending,
                pending.applyingApprovalDecisions(["qa-approval": "approved"]),
                pending.applyingApprovalDecisions(["qa-approval": "denied"])]
            let view = VStack(spacing: 16) {
                ForEach(messages.indices, id: \.self) { index in
                    MessageBubble(message: messages[index], userPrompt: nil,
                        isStreaming: false, openApprovals: {}, runForReal: nil, retry: nil, decideApproval: nil)
                }
            }
            .padding(16).frame(width: 390).background(AssistantTheme.stage)
            .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 3
            let image = try XCTUnwrap(renderer.uiImage)
            let attachment = XCTAttachment(image: image)
            attachment.name = "approval-summary-transitions-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    @MainActor
    func testHiddenReferenceLayoutDoesNotDependOnSecretLength() throws {
        for size in [DynamicTypeSize.large, .accessibility3] {
            var images: [UIImage] = []
            for value in ["A", "TEST-123456789012345678901234567890"] {
                let view = SensitiveCardValue(fact: .init(id: "ref", label: "Booking reference",
                    value: value, sensitive: true))
                    .frame(width: 160).environment(\.dynamicTypeSize, size)
                let renderer = ImageRenderer(content: view)
                images.append(try XCTUnwrap(renderer.uiImage))
            }
            XCTAssertEqual(images[0].size, images[1].size)
            XCTAssertEqual(images[0].pngData(), images[1].pngData(),
                "A hidden value must neither wrap nor disclose its character count")
        }
    }

    @MainActor
    func testChatViewportDrawsBehindComposerWithoutOwningItsTouches() async throws {
        let testCaseID = UUID().uuidString
        StubURLProtocol.beginTestCase(testCaseID)
        defer { StubURLProtocol.endTestCase(testCaseID) }
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousKeyWindow = scene.keyWindow
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        let messages = (0..<16).map { index in
            ChatMessage(id: "layout-\(index)", role: .assistant,
                parts: [.init(type: "text", text: index == 15
                    ? "LATEST_LAYOUT_ROW_MARKER\nKeep the newest answer comfortably above the input while opening the menu."
                    : "Message \(index + 1)\nKeep the newest answer comfortably above the input while opening the menu.")])
        }
        let stamp = "2026-10-03T09:00:00Z"
        let conversation = ConversationView(
            conversation: .init(id: "layout-main", title: "Layout review", modelOverride: nil,
                                archivedAt: nil, isPrimary: true),
            agentName: "Assistant", agentTimezone: "UTC", messages: messages, models: [],
            goalTitle: nil, canArchive: false, cursor: nil, asyncTurn: nil)
        let bootstrap = BootstrapResponse(
            generatedAt: stamp,
            identity: .init(id: "layout-owner", name: "Assistant", avatarUrl: nil),
            shell: .init(dashboard: .init(pendingApprovals: 0, needsAttention: 0, presence: .idle),
                         memoryHealth: .init(totalUsable: 0, notYetOrganized: 0, awaitingReview: 0,
                                             ownerConfirmed: 0, lastOrganizedAt: nil)),
            conversation: conversation)
        let bootstrapData = try JSONEncoder().encode(bootstrap)
        StubURLProtocol.prime([], paths: [
            "/api/mobile/v1/bootstrap": [.success(status: 200, body: bootstrapData)],
            "/api/mobile/v1/overview": [.success(status: 401, body: Data())],
        ])
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Assistant-Test-Case": testCaseID]
        let client = APIClient(configuration: .init(baseURL: URL(string: "https://assistant.test")!, token: "fixture-only"),
                               session: URLSession(configuration: configuration))
        let suite = "assistant.chat-viewport-review.\(testCaseID)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        defaults.set("https://assistant.test", forKey: "assistant.server-url")
        defaults.set(true, forKey: "assistant.push-prompted")
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = AppModel(apiClient: client, defaults: defaults, storeConnectionToken: { _ in })
        model.scenePhaseDidChange(.background)
        await model.refreshAll(reportFailure: false)
        XCTAssertEqual(model.bootstrap?.identity.id, "layout-owner")
        XCTAssertEqual(model.messages.map(\.id), messages.map(\.id))
        let scope = try XCTUnwrap(model.composerDraftScope)
        var actualLastRowMeasurement: TranscriptGeometryMeasurement?
        var rowGeometryReportCount = 0
        window.rootViewController = UIHostingController(rootView:
            ChatView(safeAreaTopInset: 62, safeAreaBottomInset: 34,
                safeAreaLeadingInset: 0, safeAreaTrailingInset: 0)
                .environment(model)
                .environment(\.colorScheme, .light)
                .environment(\.chatTranscriptRowGeometryProbe,
                    ChatTranscriptRowGeometryProbe(messageID: messages[messages.count - 1].id) { measurement in
                        actualLastRowMeasurement = measurement
                        rowGeometryReportCount += 1
                    }))
        window.makeKeyAndVisible()
        defer {
            window.endEditing(true)
            window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKey()
        }
        try await Task.sleep(for: .milliseconds(500))
        func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
        let views = descendants(window)
        let transcript = try XCTUnwrap(views.compactMap { $0 as? UIScrollView }.first { !($0 is UITextView) })
        let input = try XCTUnwrap(views.compactMap { $0 as? UITextView }.first)
        XCTAssertEqual(input.accessibilityIdentifier, "assistant.chat.composer")
        let initialMessageCount = model.messages.count
        let typedDraft = "Layout interaction probe"
        // Exercise the actual UIKit delegate-to-model binding without looking
        // up or activating SwiftUI's send control.
        input.text = typedDraft
        let inputDelegate = try XCTUnwrap(input.delegate)
        inputDelegate.textViewDidChange?(input)
        let draftDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while model.composerDraft(in: scope) != typedDraft && ContinuousClock.now < draftDeadline {
            try await Task.sleep(for: .milliseconds(30))
        }
        XCTAssertEqual(model.composerDraft(in: scope), typedDraft,
            "A native UITextView delegate change must update the paired conversation's draft scope")
        XCTAssertFalse(model.isSending)
        XCTAssertEqual(model.messages.count, initialMessageCount,
            "The draft-binding check does not submit the message")
        func assertHitReceiverIsOutsideTranscript(_ control: UIView, file: StaticString = #filePath, line: UInt = #line) {
            let center = control.convert(CGPoint(x: control.bounds.midX, y: control.bounds.midY), to: window)
            let receiver = window.hitTest(center, with: nil)
            XCTAssertNotNil(receiver, "The overlaid control must receive its own hit test", file: file, line: line)
            if let receiver {
                XCTAssertFalse(
                    receiver === transcript || receiver.isDescendant(of: transcript),
                    "Composer and send touches must not enter the transcript pan-recognizer subtree",
                    file: file,
                    line: line
                )
            }
        }
        func rectReceipt(_ rect: CGRect) -> [String: CGFloat] {
            guard !rect.isNull, !rect.isInfinite,
                  rect.minX.isFinite, rect.minY.isFinite,
                  rect.width.isFinite, rect.height.isFinite,
                  rect.maxX.isFinite, rect.maxY.isFinite else {
                return ["x": 0, "y": 0, "width": 0, "height": 0, "maxX": 0, "maxY": 0]
            }
            return ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height,
                    "maxX": rect.maxX, "maxY": rect.maxY]
        }
        let composerState: [String: Any] = [
            "windowFrame": rectReceipt(window.frame),
            "windowSafeAreaInsets": ["top": window.safeAreaInsets.top, "left": window.safeAreaInsets.left,
                                     "bottom": window.safeAreaInsets.bottom, "right": window.safeAreaInsets.right],
            "rootSafeAreaInsets": ["top": window.rootViewController?.view.safeAreaInsets.top ?? 0,
                                   "left": window.rootViewController?.view.safeAreaInsets.left ?? 0,
                                   "bottom": window.rootViewController?.view.safeAreaInsets.bottom ?? 0,
                                   "right": window.rootViewController?.view.safeAreaInsets.right ?? 0],
            "transcriptFrameInWindow": rectReceipt(transcript.convert(transcript.bounds, to: window)),
            "transcriptContentOffset": ["x": transcript.contentOffset.x, "y": transcript.contentOffset.y],
            "inputFrameInWindow": rectReceipt(input.convert(input.bounds, to: window)),
            "inputIsFirstResponder": input.isFirstResponder,
            "inputDraftLength": input.text?.count ?? 0,
            "scopedDraft": model.composerDraft(in: scope),
            "draftScopeConversationID": scope.conversationID,
            "messageCountUnchanged": model.messages.count == initialMessageCount,
            "isSending": model.isSending,
            "controlActivationEvidence": "Send and VoiceOver activation were not exercised."
        ]
        if let data = try? JSONSerialization.data(withJSONObject: composerState,
                                                   options: [.sortedKeys, .prettyPrinted]) {
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = "chat-composer-draft-state"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        let accessibilityImage = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let accessibilityScreenshot = XCTAttachment(image: accessibilityImage)
        accessibilityScreenshot.name = "chat-composer-screenshot"
        accessibilityScreenshot.lifetime = .keepAlways
        add(accessibilityScreenshot)

        XCTAssertFalse(input.isDescendant(of: transcript),
            "The native text view must be a sibling of the transcript")
        assertHitReceiverIsOutsideTranscript(input)
        for (stage, focused) in [false, true, false].enumerated() {
            let stageStartingReportCount = rowGeometryReportCount
            let stageStartingInputFrame = input.convert(input.bounds, to: window)
            let stageStartingViewportFrame = transcript.convert(transcript.bounds, to: window)
            let stageStartingViewportSize = transcript.bounds.size
            let stageStartingContentSize = transcript.contentSize
            let stageStartingInputSize = input.bounds.size
            var childViewportSizeChanged = false
            var contentSizeChanged = false
            var inputSizeChanged = false
            if focused { input.becomeFirstResponder() } else { input.resignFirstResponder() }
            // Keyboard presentation and LazyVStack measurement can outlast a
            // fixed animation delay on a cold CI simulator. Wait for the actual
            // viewport contract, without changing the geometry or forcing a scroll.
            let deadline = ContinuousClock.now.advanced(by: .seconds(3))
            var settledSamples = 0
            repeat {
                try await Task.sleep(for: .milliseconds(100))
                window.layoutIfNeeded()
                let inputFrame = input.convert(input.bounds, to: window)
                let viewportFrame = transcript.convert(transcript.bounds, to: window)
                childViewportSizeChanged = childViewportSizeChanged
                    || transcript.bounds.size != stageStartingViewportSize
                contentSizeChanged = contentSizeChanged || transcript.contentSize != stageStartingContentSize
                inputSizeChanged = inputSizeChanged || input.bounds.size != stageStartingInputSize
                let actualLayoutChanged = childViewportSizeChanged || contentSizeChanged || inputSizeChanged
                let rowMeasurementIsCurrent = actualLastRowMeasurement != nil
                    && (!actualLayoutChanged || rowGeometryReportCount > stageStartingReportCount)
                let bottomError = abs(transcript.contentOffset.y + transcript.bounds.height
                    - transcript.contentSize.height - transcript.adjustedContentInset.bottom)
                let settled = bottomError <= 2
                    && viewportFrame.intersects(inputFrame)
                    && inputFrame.maxY <= window.bounds.maxY && input.isFirstResponder == focused
                    && rowMeasurementIsCurrent
                settledSamples = settled ? settledSamples + 1 : 0
            } while settledSamples < 3 && ContinuousClock.now < deadline
            window.layoutIfNeeded()
            let rowFrameDeadline = ContinuousClock.now.advanced(by: .seconds(2))
            while (actualLastRowMeasurement == nil
                || ((childViewportSizeChanged || contentSizeChanged || inputSizeChanged)
                    && rowGeometryReportCount <= stageStartingReportCount))
                && ContinuousClock.now < rowFrameDeadline {
                try await Task.sleep(for: .milliseconds(30))
                window.layoutIfNeeded()
            }
            let inputFrame = input.convert(input.bounds, to: window)
            let viewportFrame = transcript.convert(transcript.bounds, to: window)
            let rowMeasurementWindowFrame = actualLastRowMeasurement?.frame(in: window)
            let rowState: [String: Any] = [
                "stage": stage, "focused": focused,
                "messageID": messages[messages.count - 1].id,
                "rowObserved": actualLastRowMeasurement != nil,
                "stageStartingReportCount": stageStartingReportCount,
                "childViewportSizeChanged": childViewportSizeChanged,
                "contentSizeChanged": contentSizeChanged,
                "inputSizeChanged": inputSizeChanged,
                "contentSizeAtStageStart": ["width": stageStartingContentSize.width,
                                             "height": stageStartingContentSize.height],
                "inputSizeAtStageStart": ["width": stageStartingInputSize.width,
                                           "height": stageStartingInputSize.height],
                "rowGeometryReportCount": rowGeometryReportCount,
                "childViewportSizeAtStageStart": ["width": stageStartingViewportSize.width,
                                                   "height": stageStartingViewportSize.height],
                "inputFrameAtStageStart": rectReceipt(stageStartingInputFrame),
                "viewportFrameAtStageStart": rectReceipt(stageStartingViewportFrame),
                "actualRowFrameInWindow": rowMeasurementWindowFrame.map(rectReceipt) ?? [:],
                "inputFrameInWindow": rectReceipt(inputFrame),
                "viewportFrameInWindow": rectReceipt(viewportFrame)
            ]
            let rowData = try JSONSerialization.data(withJSONObject: rowState, options: [.sortedKeys])
            let rowAttachment = XCTAttachment(data: rowData, uniformTypeIdentifier: "public.json")
            rowAttachment.name = "chat-clearance-row-stage-\(stage)"
            rowAttachment.lifetime = .keepAlways
            add(rowAttachment)
            if childViewportSizeChanged || contentSizeChanged || inputSizeChanged {
                XCTAssertGreaterThan(rowGeometryReportCount, stageStartingReportCount,
                    "A transcript viewport, content or native-input size change requires a new actual-row measurement")
            }
            let rowMeasurement = try XCTUnwrap(actualLastRowMeasurement,
                "The opt-in SwiftUI observer must report the actual final transcript row")
            let actualLastRowFrame = try XCTUnwrap(rowMeasurement.frame(in: window),
                "The owned transcript host must still convert the actual row into this window")
            // The transcript owns the whole drawing viewport; the composer
            // sits over its lower region as a sibling hit target.
            XCTAssertGreaterThan(viewportFrame.height, inputFrame.height)
            XCTAssertGreaterThan(viewportFrame.maxY, inputFrame.minY)
            XCTAssertTrue(viewportFrame.intersects(inputFrame))
            XCTAssertTrue(viewportFrame.intersects(actualLastRowFrame))
            XCTAssertLessThan(actualLastRowFrame.maxY, inputFrame.minY,
                "The real newest message must remain clear of the overlaid input")
            XCTAssertFalse(input.isDescendant(of: transcript),
                "Composer text and send touches must stay outside the transcript pan-recognizer subtree")
            // Verify the actual ChatView remains at its canonical bottom,
            // not a stale offset from before the composer was measured.
            XCTAssertEqual(transcript.contentOffset.y + transcript.bounds.height,
                transcript.contentSize.height + transcript.adjustedContentInset.bottom, accuracy: 2,
                "The newest message and its composer clearance must remain visible")
            XCTAssertLessThanOrEqual(inputFrame.maxY, window.bounds.maxY)
            XCTAssertEqual(input.isFirstResponder, focused)
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = focused ? "chat-clearance-keyboard" : "chat-clearance-rest"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    @MainActor
    func testLiftedTranscriptKeepsFullViewportAndComposerClearance() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousKeyWindow = scene.keyWindow
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        let state = LiftedTranscriptFixtureState()
        window.rootViewController = UIHostingController(
            rootView: LiftedTranscriptFixture(state: state))
        window.makeKeyAndVisible()
        var diagnosticScroll: UIScrollView?
        var layoutSamples: [[String: Any]] = []
        func rectReceipt(_ rect: CGRect) -> [String: CGFloat] {
            ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height,
             "maxX": rect.maxX, "maxY": rect.maxY]
        }
        func measuredFrame(_ measurement: TranscriptGeometryMeasurement?, _ label: String) throws -> CGRect {
            let measurement = try XCTUnwrap(measurement, "Missing owned-host geometry measurement: \(label)")
            return try XCTUnwrap(measurement.frame(in: window),
                "Owned-host geometry measurement is invalid for this window: \(label)")
        }
        func sampleLayout(_ phase: String) throws {
            let scroll = diagnosticScroll
            let superview = scroll?.superview
            let transcriptViewport = try measuredFrame(state.transcriptViewport, "\(phase) viewport")
            let lastCard = try measuredFrame(state.lastCard, "\(phase) latest row")
            layoutSamples.append([
                "phase": phase,
                "reveal": state.reveal,
                "availableHeight": state.availableHeight,
                "composerHeight": state.composerHeight,
                "noticeHeight": state.noticeHeight,
                "windowFrame": rectReceipt(window.frame),
                "windowSafeAreaInsets": ["top": window.safeAreaInsets.top,
                                         "left": window.safeAreaInsets.left,
                                         "bottom": window.safeAreaInsets.bottom,
                                         "right": window.safeAreaInsets.right],
                "rootSafeAreaInsets": ["top": window.rootViewController?.view.safeAreaInsets.top ?? 0,
                                       "left": window.rootViewController?.view.safeAreaInsets.left ?? 0,
                                       "bottom": window.rootViewController?.view.safeAreaInsets.bottom ?? 0,
                                       "right": window.rootViewController?.view.safeAreaInsets.right ?? 0],
                "transcriptViewport": rectReceipt(transcriptViewport),
                "composerFrameInWindow": rectReceipt(state.composer),
                "latestRowFrameInWindow": rectReceipt(lastCard),
                "noticeFrameInWindow": rectReceipt(state.notice),
                "scrollSuperviewType": superview.map { String(describing: type(of: $0)) } ?? "missing",
                "scrollFrameInSuperview": scroll.map { rectReceipt($0.frame) } ?? [:],
                "scrollFrameInWindow": scroll.map { rectReceipt($0.convert($0.bounds, to: window)) } ?? [:],
                "scrollBounds": scroll.map { rectReceipt($0.bounds) } ?? [:],
                "contentSize": ["width": scroll?.contentSize.width ?? 0,
                                "height": scroll?.contentSize.height ?? 0],
                "contentOffset": ["x": scroll?.contentOffset.x ?? 0,
                                  "y": scroll?.contentOffset.y ?? 0],
                "contentInset": ["top": scroll?.contentInset.top ?? 0,
                                 "left": scroll?.contentInset.left ?? 0,
                                 "bottom": scroll?.contentInset.bottom ?? 0,
                                 "right": scroll?.contentInset.right ?? 0],
                "scrollSafeAreaInsets": ["top": scroll?.safeAreaInsets.top ?? 0,
                                          "left": scroll?.safeAreaInsets.left ?? 0,
                                          "bottom": scroll?.safeAreaInsets.bottom ?? 0,
                                          "right": scroll?.safeAreaInsets.right ?? 0],
                "contentInsetAdjustmentBehavior": scroll?.contentInsetAdjustmentBehavior.rawValue ?? -1,
                "adjustedContentInset": ["top": scroll?.adjustedContentInset.top ?? 0,
                                         "left": scroll?.adjustedContentInset.left ?? 0,
                                         "bottom": scroll?.adjustedContentInset.bottom ?? 0,
                                         "right": scroll?.adjustedContentInset.right ?? 0],
            ])
        }
        defer {
            let receipt: [String: Any] = ["test": "lifted-transcript-layout-diagnostics",
                                          "sampleCount": layoutSamples.count,
                                          "samples": layoutSamples]
            if let data = try? JSONSerialization.data(withJSONObject: receipt,
                                                       options: [.sortedKeys, .prettyPrinted]) {
                let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
                attachment.name = "lifted-transcript-layout-samples"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
            window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKey()
        }
        try await Task.sleep(for: .milliseconds(400))
        let initialLastCard = try measuredFrame(state.lastCard, "initial latest row")
        let initialViewport = try measuredFrame(state.transcriptViewport, "initial viewport")
        let baseline = state.composer.minY - initialLastCard.maxY
        let cardBottom = initialLastCard.maxY
        func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
        let scroll = try XCTUnwrap(descendants(window).compactMap { $0 as? UIScrollView }.first)
        diagnosticScroll = scroll
        try sampleLayout("baseline")
        XCTAssertEqual(baseline, 18, accuracy: 1)
        XCTAssertEqual(initialViewport.height, 852, accuracy: 1,
            "The composer overlays the viewport instead of reducing its height")
        XCTAssertGreaterThan(initialViewport.maxY, state.composer.minY)
        func centerColumn() throws -> [(red: UInt8, green: UInt8, blue: UInt8)] {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let cgImage = try XCTUnwrap(image.cgImage)
            let width = cgImage.width, height = cgImage.height
            var pixels = [UInt8](repeating: 0, count: width * height * 4)
            let context = try XCTUnwrap(CGContext(data: &pixels, width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
            return (0..<height).map { y in
                let i = (y * width + width / 2) * 4
                return (red: pixels[i], green: pixels[i + 1], blue: pixels[i + 2])
            }
        }
        func isCard(_ pixel: (red: UInt8, green: UInt8, blue: UInt8)) -> Bool {
            pixel.red > 180 && pixel.green < 120 && pixel.blue < 120
        }
        func renderedEdges() throws -> (card: CGFloat, input: CGFloat) {
            let column = try centerColumn()
            var red: [Int] = [], blue: [Int] = []
            for (y, pixel) in column.enumerated() {
                if isCard(pixel) { red.append(y) }
                if pixel.red < 100 && pixel.blue > 180 { blue.append(y) }
            }
            return (CGFloat(try XCTUnwrap(red.last)) + 1, CGFloat(try XCTUnwrap(blue.first)))
        }
        let renderedBaseline = try renderedEdges()
        for noticeHeight: CGFloat in [0, 36, 120] {
            state.noticeHeight = noticeHeight
            state.jumpRequest += 1
            try await Task.sleep(for: .milliseconds(180))
            window.layoutIfNeeded()

            let transcriptViewport = try measuredFrame(state.transcriptViewport, "notice baseline viewport")
            let latestCard = try measuredFrame(state.lastCard, "notice baseline latest row")
            let notice = state.notice
            let offset = scroll.contentOffset
            try sampleLayout("notice-\(Int(noticeHeight))-baseline")
            let clearanceTarget = noticeHeight > 0 ? notice.minY : state.composer.minY
            XCTAssertEqual(transcriptViewport.height, 852, accuracy: 1,
                "Notice height must change content clearance, never viewport height")
            XCTAssertEqual(clearanceTarget - latestCard.maxY, 18, accuracy: 1,
                "The newest row keeps 18pt of clearance below the notice stack or composer")
            if noticeHeight > 0 {
                XCTAssertEqual(notice.height, noticeHeight, accuracy: 1)
            }

            state.showsJumpChrome = true
            try await Task.sleep(for: .milliseconds(150))
            window.layoutIfNeeded()
            try sampleLayout("notice-\(Int(noticeHeight))-jump-visible")
            let viewportWithJump = try measuredFrame(state.transcriptViewport, "notice with Jump viewport")
            let cardWithJump = try measuredFrame(state.lastCard, "notice with Jump latest row")
            XCTAssertEqual(viewportWithJump, transcriptViewport,
                "Showing Jump must not shorten the transcript viewport")
            XCTAssertEqual(cardWithJump, latestCard,
                "Showing Jump must not move the reader's current content")
            XCTAssertEqual(state.notice, notice,
                "Jump must not change the notice stack's measured clearance")
            XCTAssertEqual(scroll.contentOffset, offset,
                "Showing Jump must not change the transcript offset")

            state.showsJumpChrome = false
            try await Task.sleep(for: .milliseconds(120))
            window.layoutIfNeeded()
            try sampleLayout("notice-\(Int(noticeHeight))-jump-hidden")
            XCTAssertEqual(try measuredFrame(state.transcriptViewport, "notice after Jump viewport"), transcriptViewport)
            XCTAssertEqual(try measuredFrame(state.lastCard, "notice after Jump latest row"), latestCard)
            XCTAssertEqual(scroll.contentOffset, offset)
        }
        state.noticeHeight = 0
        state.jumpRequest += 1
        try await Task.sleep(for: .milliseconds(180))
        window.layoutIfNeeded()
        try sampleLayout("lift-release-baseline")
        let releaseBaselineLastCard = try measuredFrame(state.lastCard, "lift release latest row")
        XCTAssertEqual(state.composer.minY - releaseBaselineLastCard.maxY, baseline, accuracy: 1)
        let liftBaselineOffset = scroll.contentOffset
        let liftBaselineAdjustedInset = scroll.adjustedContentInset
        for distance: CGFloat in [1, 5, 10, 20, 34, 80, 200, 450, 200, 34, 10, 0, 20, 0, 10, 0] {
            state.reveal = distance
            try await Task.sleep(for: .milliseconds(100))
            window.layoutIfNeeded()
            try sampleLayout("lift-\(Int(distance))")
            let viewportFrame = try measuredFrame(state.transcriptViewport, "lift viewport")
            let latestCardFrame = try measuredFrame(state.lastCard, "lift latest row")
            XCTAssertEqual(scroll.bounds.height, state.availableHeight, accuracy: 1,
                "The actual native viewport must remain fixed while crossing the window safe-area edge")
            XCTAssertEqual(scroll.contentOffset.x, liftBaselineOffset.x, accuracy: 1)
            XCTAssertEqual(scroll.contentOffset.y, liftBaselineOffset.y, accuracy: 1,
                "Lift/release must not re-anchor the transcript content")
            XCTAssertEqual(scroll.adjustedContentInset.top, liftBaselineAdjustedInset.top, accuracy: 1)
            XCTAssertEqual(scroll.adjustedContentInset.bottom, liftBaselineAdjustedInset.bottom, accuracy: 1)
            XCTAssertEqual(
                state.composer.minY - latestCardFrame.maxY, baseline, accuracy: 1,
                "The gap must survive a \(distance)pt live lift")
            XCTAssertEqual(viewportFrame.height, 852, accuracy: 1,
                "Moving the shared surface must not resize the transcript viewport")
            XCTAssertEqual(latestCardFrame.maxY, cardBottom - distance, accuracy: 1)
            let edges = try renderedEdges()
            XCTAssertEqual(edges.input - edges.card, 18, accuracy: 1)
            XCTAssertEqual(edges.card, renderedBaseline.card - distance, accuracy: 1,
                "Rendered content must track the finger immediately, without consuming the gap")
        }
        // The same viewport must adapt to a taller composer and keyboard-sized
        // available regions; never bake a device inset into the clearance.
        for (height, input): (CGFloat, CGFloat) in [(600, 60), (600, 120), (540, 160), (852, 60)] {
            state.availableHeight = height
            state.composerHeight = input
            try await Task.sleep(for: .milliseconds(200))
            state.jumpRequest += 1
            try await Task.sleep(for: .milliseconds(150))
            for distance: CGFloat in [10, 450, 0] {
                state.reveal = distance
                try await Task.sleep(for: .milliseconds(100))
                window.layoutIfNeeded()
                try sampleLayout("available-\(Int(height))-composer-\(Int(input))-lift-\(Int(distance))")
                let latestCardFrame = try measuredFrame(state.lastCard, "available-size latest row")
                let viewportFrame = try measuredFrame(state.transcriptViewport, "available-size viewport")
                XCTAssertEqual(state.composer.minY - latestCardFrame.maxY, baseline, accuracy: 1)
                XCTAssertEqual(viewportFrame.height, height, accuracy: 1,
                    "Changing composer/chrome height must not reserve space out of the viewport")
            }
        }
        // Reading an older message must not be turned into a jump to latest.
        scroll.setContentOffset(CGPoint(x: 0, y: scroll.contentOffset.y - 160), animated: false)
        try await Task.sleep(for: .milliseconds(100))
        let readingOffset = scroll.contentOffset.y
        // Reading upward moves the newest row behind the composer's transparent
        // lower gutter. The full-height scroll view must continue drawing there.
        window.layoutIfNeeded()
        try sampleLayout("reading-older-before-lift")
        let underComposer = try centerColumn()
        for y in (Int(state.composer.maxY) - 10)..<(Int(state.composer.maxY) - 2) {
            XCTAssertTrue(
                isCard(underComposer[y]),
                "A message must keep being drawn below the composer, all the way off the screen")
        }
        for distance: CGFloat in [20, 80, 450, 80, 0] {
            state.reveal = distance
            try await Task.sleep(for: .milliseconds(100))
            window.layoutIfNeeded()
            try sampleLayout("reading-older-lift-\(Int(distance))")
            XCTAssertEqual(scroll.contentOffset.y, readingOffset, accuracy: 1)
        }
        // Repeated requests share the same native bottom edge.
        for _ in 0..<3 {
            state.jumpRequest += 1
            try await Task.sleep(for: .milliseconds(150))
            let latestCardFrame = try measuredFrame(state.lastCard, "repeated jump latest row")
            XCTAssertEqual(state.composer.minY - latestCardFrame.maxY, baseline, accuracy: 1)
        }
    }

    @MainActor
    func testSourcesDisclosurePreservesNativeScrollOffset() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousKeyWindow = scene.keyWindow
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        let state = SourcesScrollFixtureState()
        window.rootViewController = UIHostingController(rootView: SourcesScrollFixture(state: state))
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKey()
        }
        try await Task.sleep(for: .milliseconds(200))
        func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
        let scroll = try XCTUnwrap(descendants(window).compactMap { $0 as? UIScrollView }.first)
        // Read an older answer at a legal, explicit offset. The initial lazy
        // bottom estimate can still be settling and is not the reading state
        // this disclosure regression is intended to protect.
        scroll.setContentOffset(CGPoint(x: 0, y: 200), animated: false)
        try await Task.sleep(for: .milliseconds(100))
        for _ in 0..<3 {
            let before = scroll.contentOffset.y
            let height = scroll.contentSize.height
            withTransaction(TranscriptDisclosure.transaction()) {
                state.expanded = true
            }
            try await Task.sleep(for: .milliseconds(350))
            window.layoutIfNeeded()
            XCTAssertGreaterThan(scroll.contentSize.height, height + 300)
            XCTAssertEqual(scroll.contentOffset.y, before, accuracy: 1,
                "Expanding an older answer must not bottom-anchor away from its footer")
            withTransaction(TranscriptDisclosure.transaction()) {
                state.expanded = false
            }
            try await Task.sleep(for: .milliseconds(350))
            XCTAssertEqual(scroll.contentOffset.y, before, accuracy: 1)
        }
    }

    @MainActor
    func testCompactSensitiveValueAndPeopleGroupSnapshots() throws {
        let data = Data(#"{"id":"m1","role":"assistant","parts":[{"type":"data-card","data":{"kind":"generated-card","id":"c1","spec":{"version":1,"title":"Hotel Reservation","subtitle":"Tomorrow","sourceLabel":"Source message","accessibilityLabel":"Hotel reservation","facts":[{"id":"reference","label":"Booking reference","value":"TEST-12345678901234567890","sensitive":true}],"blocks":[{"type":"facts","factIds":["reference"]}]}}}]}"#.utf8)
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        let card = try XCTUnwrap(message.parts.compactMap(MessageResponseCard.init(part:)).first)
        let rows = [
            PersonRelationSummary(id: "1", sentence: "Alex is Robin's father.", otherLabel: "Alex Morgan",
                otherInitials: "AM", otherContactId: nil, span: "", unreviewed: false),
            PersonRelationSummary(id: "2", sentence: "Alex visited with Robin.", otherLabel: "Alex Morgan",
                otherInitials: "AM", otherContactId: nil, span: "", unreviewed: true),
        ]
        let group = PersonRelationGroup(id: "alex", relations: rows, roles: ["Father"], relationshipIDs: ["1"])
        for (name, scheme, size, width) in [
            ("light", ColorScheme.light, DynamicTypeSize.large, CGFloat(390)),
            ("dark", .dark, .large, 390),
            ("narrow", .light, .large, 320),
            ("accessible", .light, .accessibility3, 390)
        ] {
            let view = VStack(spacing: 16) {
                SavedResponseCard(card: card, dismiss: {})
                PersonRelationGroupCard(group: group)
            }
            .padding(16).frame(width: width).background(AssistantTheme.canvas(for: scheme))
            .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 3
            let image = try XCTUnwrap(renderer.uiImage)
            let attachment = XCTAttachment(image: image)
            attachment.name = "compact-mask-and-people-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    @MainActor
    func testSubpageChromeKeepsTitleWhileContentScrollsUnderToolbar() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        let content = NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    ForEach(0..<20) { index in
                        Text("Activity item \(index + 1)")
                            .frame(maxWidth: .infinity, minHeight: 120)
                            .background(.white, in: RoundedRectangle(cornerRadius: 22))
                    }
                }.padding(16)
            }
            .navigationTitle("Activity")
            .assistantSubmenuChrome()
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Image(systemName: "archivebox") } }
        }
        .environment(\.colorScheme, .light)
        .ignoresSafeArea(.container, edges: .top)
        .statusBarHidden(true)
        window.rootViewController = UIHostingController(rootView: content)
        window.isHidden = false
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(200))
        window.layoutIfNeeded()
        func descendants(_ view: UIView) -> [UIView] {
            [view] + view.subviews.flatMap(descendants)
        }
        let scroll = try XCTUnwrap(descendants(window).compactMap { $0 as? UIScrollView }
            .first { $0.contentSize.height > $0.bounds.height })
        let bar = try XCTUnwrap(descendants(window).compactMap { $0 as? UINavigationBar }.first)
        for offset in [CGFloat(0), 160, 520] {
            scroll.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
            try await Task.sleep(for: .milliseconds(100))
            window.layoutIfNeeded()
            XCTAssertEqual(bar.topItem?.title, "Activity")
            XCTAssertEqual(scroll.contentOffset.y, offset, accuracy: 1)
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "subpage-toolbar-scroll-\(Int(offset))"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    @MainActor
    func testAttachedSourcesAndSavedCardSnapshots() throws {
        let data = Data(#"{"id":"m1","role":"assistant","parts":[{"type":"text","text":"These two events overlap. Review the calendar details below."},{"type":"data-card","data":{"kind":"calendar-event","id":"e1","title":"Soccer game","time":"2:00 PM–3:00 PM","start":"2026-09-05T14:00:00-07:00","calendars":["Family"]}}]}"#.utf8)
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        let card = try XCTUnwrap(message.parts.compactMap(MessageResponseCard.init(part:)).first)
        for (name, scheme, size) in [
            ("light", ColorScheme.light, DynamicTypeSize.large),
            ("dark", .dark, .large),
            ("accessible", .light, .accessibility3)
        ] {
            let view = VStack(spacing: 24) {
                MessageBubble(message: message, userPrompt: nil,
                    isStreaming: false, openApprovals: {}, runForReal: nil, retry: nil, decideApproval: nil)
                SavedResponseCard(card: card, dismiss: {})
            }
            .padding(16).frame(width: 390).background(AssistantTheme.stage)
            .environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 3
            renderer.proposedSize = ProposedViewSize(width: 390, height: nil)
            let image = try XCTUnwrap(renderer.uiImage)
            XCTAssertEqual(image.size.width, 390)
            XCTAssertGreaterThan(image.size.height, 250)
            let attachment = XCTAttachment(image: image)
            attachment.name = "attached-card-controls-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    @MainActor
    func testReplyCardSnapshots() throws {
        let prose = "Here are two places to stop along the way. Check the opening hours before leaving."
        for (name, scheme, size, width) in [
            ("light", ColorScheme.light, DynamicTypeSize.large, CGFloat(390)),
            ("dark", .dark, .large, 390),
            ("narrow", .light, .large, 320),
            ("accessible", .light, .accessibility3, 390)
        ] {
            func render(role: ChatRole) throws -> UIImage {
                let view = MessageBubble(
                    message: .optimistic(role: role, text: prose),
                    userPrompt: "Can you find a place somewhere along the way?",
                    isStreaming: false, openApprovals: {},
                    runForReal: nil, retry: nil, decideApproval: nil
                )
                .padding(16).frame(width: width).background(AssistantTheme.stage)
                .environment(\.colorScheme, scheme)
                .environment(\.dynamicTypeSize, size)
                let renderer = ImageRenderer(content: view)
                renderer.scale = 3
                renderer.proposedSize = ProposedViewSize(width: width, height: nil)
                return try XCTUnwrap(renderer.uiImage)
            }
            let image = try render(role: .assistant)
            let userImage = try render(role: .user)
            XCTAssertEqual(image.size.width, width)
            XCTAssertEqual(image.size, userImage.size,
                "Identical plain prose must use the same content insets for either speaker")
            XCTAssertGreaterThan(image.size.height, 16 * 2 + 16 * 2,
                "Prose must contribute intrinsic height beyond bubble insets and fixture padding")
            let attachment = XCTAttachment(image: image)
            attachment.name = "reply-card-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    /// A suggestion is offered on paper in the accent, never on the amber
    /// approval surface; its prose stays above it; answered ones leave the
    /// same receipt an approval does.
    @MainActor
    func testSuggestionCardSnapshots() throws {
        let open = ChatMessage(id: "open", role: .assistant, parts: [
            .init(type: "text", text: "One more thing from your \"Flights\" watch:"),
            .init(type: "suggestion", suggestionId: "s1",
                summary: "Fares to Lisbon dropped to €89 for the weekend of the 4th — want me to hold the cheapest one?"),
        ])
        let mixed = ChatMessage(id: "mixed", role: .assistant, parts: [
            .init(type: "text", text: "Two dates coming up this week."),
            .init(type: "suggestion", suggestionId: "s2", summary: "Book a table for Robin's birthday on Friday?",
                status: "accepted", acceptedTaskId: "t1"),
            .init(type: "suggestion", suggestionId: "s3", summary: "Renew the car insurance before it lapses on the 30th?"),
        ])
        let settled = ChatMessage(id: "settled", role: .assistant, parts: [
            .init(type: "text", text: "The dentist has an opening next week."),
            .init(type: "suggestion", suggestionId: "s4", summary: "Book the Tuesday 9am check-up?", status: "snoozed"),
        ])
        for (name, scheme, size, width) in [
            ("light", ColorScheme.light, DynamicTypeSize.large, CGFloat(390)),
            ("dark", .dark, .large, 390),
            ("narrow", .light, .xxxLarge, 320),
            ("accessible", .light, .accessibility3, 390)
        ] {
            let view = VStack(spacing: 16) {
                ForEach([open, mixed, settled]) { message in
                    MessageBubble(message: message, userPrompt: nil,
                        isStreaming: false, openApprovals: {}, runForReal: nil, retry: nil, decideApproval: nil,
                        decideSuggestion: { _, _ in nil }, openActivity: {})
                }
            }
            .padding(16).frame(width: width).background(AssistantTheme.stage)
            .environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 3
            renderer.proposedSize = ProposedViewSize(width: width, height: nil)
            let image = try XCTUnwrap(renderer.uiImage)
            XCTAssertEqual(image.size.width, width)
            XCTAssertGreaterThan(image.size.height, 400)
            let attachment = XCTAttachment(image: image)
            attachment.name = "suggestion-card-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    @MainActor
    func testUnifiedSuggestionAndLiveRichCardSnapshots() throws {
        var dismissed = RichMessageFixture.suggestion
        dismissed.suggestionId = "dismissed"
        dismissed.status = "dismissed"
        var completed = RichMessageFixture.suggestion
        completed.suggestionId = "completed"
        completed.status = "accepted"
        completed.acceptedTaskId = "task-1"
        completed.acceptedTaskStatus = "done"
        completed.acceptedTaskSummary = "Reviewed the report and highlighted Friday’s test."
        let open = ChatMessage(id: "unified", role: .assistant, parts: [
            RichMessageFixture.suggestion, .init(type: "data-card", data: RichMessageFixture.alert)
        ])
        let settled = ChatMessage(id: "settled", role: .assistant, parts: [dismissed, completed])
        for (name, scheme, size, width) in [
            ("light", ColorScheme.light, DynamicTypeSize.large, CGFloat(390)),
            ("dark", .dark, .large, 390),
            ("narrow", .light, .xxxLarge, 320),
            ("accessible", .light, .accessibility3, 390)
        ] {
            let view = VStack(spacing: 14) {
                ForEach([open, settled]) { message in
                    MessageBubble(message: message, userPrompt: nil,
                        isStreaming: false, openApprovals: {}, runForReal: nil, retry: nil, decideApproval: nil,
                        decideSuggestion: { _, _ in nil }, openActivity: {})
                }
                ForEach(["idle", "refreshing", "failed"], id: \.self) { state in
                    if let card = MessageResponseCard(part: RichMessageFixture.generated(state: state, stale: true)) {
                        RichResponseCards(cards: [card], onRefresh: { _, _ in nil })
                    }
                }
            }
            .padding(16).frame(width: width).background(AssistantTheme.stage)
            .environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            renderer.proposedSize = ProposedViewSize(width: width, height: nil)
            let image = try XCTUnwrap(renderer.uiImage)
            XCTAssertEqual(image.size.width, width)
            XCTAssertGreaterThan(image.size.height, 500)
            let attachment = XCTAttachment(image: image)
            attachment.name = "unified-rich-card-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    func testSpreadsheetPasteKeepsFirstRowAndMissingValues() {
        let source = "Family birthdays\n\nAda\tApril 20, 1918\tMonkey\n\t\t\nBaby\t\tHorse"
        let blocks = AssistantMarkdown.blocks(in: source)
        XCTAssertEqual(blocks.first, .paragraph("Family birthdays"))
        XCTAssertEqual(blocks.last, .table(headers: [], rows: [
            ["Ada", "April 20, 1918", "Monkey"], ["", "", ""], ["Baby", "", "Horse"]
        ]))
    }

    func testTabDetectionLeavesCodeAndSingleTabLineAlone() {
        XCTAssertEqual(AssistantMarkdown.blocks(in: "Name\tValue"), [.paragraph("Name\tValue")])
        XCTAssertEqual(AssistantMarkdown.blocks(in: "```\nA\tB\nC\tD\n```"), [.code(language: nil, text: "A\tB\nC\tD")])
        let blocks = AssistantMarkdown.blocks(in: "A\tB\nC\tD\nNot\ta\tmatching row")
        XCTAssertEqual(blocks.last, .paragraph("Not\ta\tmatching row"))
    }

    @MainActor
    func testCompactCalendarSnapshots() throws {
        let data = Data(#"{"id":"m1","role":"assistant","parts":[{"type":"data-card","data":{"kind":"calendar-event","id":"e1","title":"Google Phone Interview","time":"2:00 PM–2:30 PM","start":"2014-05-05T14:00:00-07:00","calendars":["Personal"]}},{"type":"data-card","data":{"kind":"calendar-event","id":"e2","title":"Twitter Phone Interview","time":"3:00 PM–4:00 PM","start":"2014-05-19T15:00:00-07:00","calendars":["Personal"]}}]}"#.utf8)
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        for scheme in [ColorScheme.light, .dark] {
            let view = MessageBubble(message: message, userPrompt: nil,
                isStreaming: false, openApprovals: {}, runForReal: nil, retry: nil, decideApproval: nil)
                .padding(16).frame(width: 390).background(AssistantTheme.stage)
                .environment(\.colorScheme, scheme)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            renderer.proposedSize = ProposedViewSize(width: 390, height: nil)
            let image = try XCTUnwrap(renderer.uiImage)
            XCTAssertGreaterThan(image.size.height, 150)
            XCTAssertLessThan(image.size.height, 330)
            let attachment = XCTAttachment(image: image)
            attachment.name = "compact-calendar-\(scheme)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    @MainActor
    func testUserFormattingSnapshots() throws {
        let source = "Family birthdays\n\nAda\tApril 20, 1918\tMetal Monkey\nAlexandra\tNovember 21, 2020\tMetal Rat\nBaby\t\tFire Horse\n\nOur order\n- [ ] Bean & Cheese\n- [ ] Mushroom"
        for (name, scheme, size) in [
            ("light", ColorScheme.light, DynamicTypeSize.large),
            ("dark", .dark, .large),
            ("accessible", .light, .accessibility3)
        ] {
            let view = MessageBubble(message: .optimistic(role: .user, text: source), userPrompt: nil,
                isStreaming: false, openApprovals: {},
                runForReal: nil, retry: nil, decideApproval: nil)
                .padding(16).frame(width: 390).background(AssistantTheme.stage)
                .environment(\.colorScheme, scheme)
                .environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            renderer.proposedSize = ProposedViewSize(width: 390, height: nil)
            let image = try XCTUnwrap(renderer.uiImage)
            XCTAssertGreaterThan(image.size.height, 200)
            let attachment = XCTAttachment(image: image)
            attachment.name = "user-table-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }
    /// Both clients split an overlong paragraph at the same places: the web
    /// renderer and this one run the same fixture file.
    func testParagraphReflowMatchesSharedFixtures() throws {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let url = repository.appendingPathComponent("apps/web/lib/paragraph-reflow.fixtures.json")
        struct Fixture: Decodable { let name: String; let input: String; let expected: String }
        let fixtures = try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: url))
        XCTAssertFalse(fixtures.isEmpty)
        for fixture in fixtures {
            XCTAssertEqual(ParagraphReflow.reflow(fixture.input), fixture.expected, fixture.name)
            XCTAssertEqual(ParagraphReflow.reflow(fixture.expected), fixture.expected, "\(fixture.name) (idempotent)")
        }
    }

    func testOverlongParagraphRendersAsSeveralBlocks() {
        let sentence = "The review moved to Thursday because finance needs two more days to close."
        let blocks = AssistantMarkdown.blocks(in: Array(repeating: sentence, count: 8).joined(separator: " "))
        XCTAssertGreaterThan(blocks.count, 1)
    }

    /// Reuses the two generated prompt runs without bundling private QA output
    /// into the app. XCTest keeps the native renders as reviewable attachments.
    @MainActor
    func testReadabilityCorpusSnapshots() throws {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let corpusDirectory = repository.appendingPathComponent(".artifacts/chat-readability")
        guard FileManager.default.fileExists(atPath: corpusDirectory.appendingPathComponent("baseline-responses.json").path) else {
            throw XCTSkip("Generate the optional readability corpus before running visual QA")
        }
        struct Corpus: Decodable {
            struct Response: Decodable {
                let index: Int
                let prompt: String
                let response: String
            }
            let responses: [Response]
        }
        for run in ["baseline", "reframed"] {
            let data = try Data(contentsOf: corpusDirectory.appendingPathComponent("\(run)-responses.json"))
            let corpus = try JSONDecoder().decode(Corpus.self, from: data)
            XCTAssertEqual(corpus.responses.count, 30)
            for item in corpus.responses {
                let view = MessageBubble(
                    message: .optimistic(role: .assistant, text: item.response),
                    userPrompt: item.prompt,
                    isStreaming: false,
                    openApprovals: {}, runForReal: nil, retry: nil, decideApproval: nil
                )
                .padding(16)
                .frame(width: 390)
                .background(AssistantTheme.stage)
                .environment(\.colorScheme, .light)
                let renderer = ImageRenderer(content: view)
                renderer.scale = 2
                renderer.proposedSize = ProposedViewSize(width: 390, height: nil)
                let image = try XCTUnwrap(renderer.uiImage, "Could not render \(run) \(item.index)")
                XCTAssertGreaterThan(image.size.height, 70)
                let attachment = XCTAttachment(image: image)
                attachment.name = "\(run)-\(String(format: "%02d", item.index))-native"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
    }

    func testParsesNestedUnorderedList() {
        let source = """
        - Flights from KEF, direct
          - Depart Oct 12
          - Around $420
        - Stay near Alfama
        """
        let blocks = AssistantMarkdown.blocks(in: source)
        guard case let .list(nodes) = blocks.first, blocks.count == 1 else {
            return XCTFail("expected a single list block, got \(blocks)")
        }
        XCTAssertEqual(nodes.count, 2)
        XCTAssertEqual(nodes[0].text, "Flights from KEF, direct")
        XCTAssertEqual(nodes[0].children.map(\.text), ["Depart Oct 12", "Around $420"])
        XCTAssertEqual(nodes[1].text, "Stay near Alfama")
        XCTAssertTrue(nodes[1].children.isEmpty)
    }

    func testParsesMixedListMarkersAndTasks() {
        let source = """
        1. First step
        2. Second step
        - [x] Done thing
        - [ ] Todo thing
        """
        let blocks = AssistantMarkdown.blocks(in: source)
        guard case let .list(nodes) = blocks.first else {
            return XCTFail("expected a list block, got \(blocks)")
        }
        XCTAssertEqual(nodes.count, 4)
        XCTAssertEqual(nodes[0].marker, .number(1))
        XCTAssertEqual(nodes[2].marker, .task(isComplete: true))
        XCTAssertEqual(nodes[3].marker, .task(isComplete: false))
    }

    func testParsesFencedCodeBlockWithLanguage() {
        let source = """
        Intro.

        ```ts
        const a = 1;
        const b = 2;
        ```
        """
        let blocks = AssistantMarkdown.blocks(in: source)
        guard case let .code(language, text) = blocks.last else {
            return XCTFail("expected a code block, got \(blocks)")
        }
        XCTAssertEqual(language, "ts")
        XCTAssertEqual(text, "const a = 1;\nconst b = 2;")
    }

    func testParsesMermaidFenceAsARecognizableDiagramBlock() {
        let source = """
        ```mermaid
        graph LR
          A --> B
        ```
        """
        guard case let .code(language, text) = AssistantMarkdown.blocks(in: source).first else {
            return XCTFail("expected a diagram code block")
        }
        XCTAssertEqual(language, "mermaid")
        XCTAssertEqual(text, "graph LR\n  A --> B")
    }

    func testParsesTableHeadersAndRows() {
        let source = """
        | Item | Estimate |
        | --- | --- |
        | Flights | $420 |
        | Stay | $680 |
        """
        let blocks = AssistantMarkdown.blocks(in: source)
        guard case let .table(headers, rows) = blocks.first else {
            return XCTFail("expected a table block, got \(blocks)")
        }
        XCTAssertEqual(headers, ["Item", "Estimate"])
        XCTAssertEqual(rows, [["Flights", "$420"], ["Stay", "$680"]])
    }

    func testPromotesStandaloneBoldQuotationToCallout() {
        let source = "**“Clarity is kindness.”**"
        let blocks = AssistantMarkdown.blocks(in: source)
        XCTAssertEqual(blocks, [.quote(source)])
        XCTAssertTrue(AssistantMarkdown.isStandaloneBoldQuote(source))
    }

    func testLeavesOrdinaryBoldParagraphAsParagraph() {
        let source = "**Important:** keep the copy short."
        XCTAssertEqual(AssistantMarkdown.blocks(in: source), [.paragraph(source)])
        XCTAssertFalse(AssistantMarkdown.isStandaloneBoldQuote(source))
    }

    func testShortBoldListLabelBecomesSectionHeading() {
        let blocks = AssistantMarkdown.blocks(in: "**Risks**\n\n- Delay")
        XCTAssertEqual(blocks.first, .heading(level: 2, text: "Risks"))
        let sentence = AssistantMarkdown.blocks(in: "**Keep it simple.**\n\n- Next")
        XCTAssertEqual(sentence.first, .paragraph("**Keep it simple.**"))
    }

    func testDisplayArithmeticKeepsCurrencyAndFormatsOperators() {
        let blocks = AssistantMarkdown.blocks(in: "$$\nA = P \\times (1 + r)^t\n$$")
        XCTAssertEqual(blocks, [.equation("A = P \\times (1 + r)^t")])
        XCTAssertEqual(AssistantMarkdown.readableEquation("A = P \\times (1 + r)^t"), "A = P × (1 + r)ᵗ")
        XCTAssertEqual(AssistantMarkdown.readableInlineVariables("$A$ is $1,000, not $1,050"), "A is $1,000, not $1,050")
        XCTAssertEqual(AssistantMarkdown.readableInlineVariables("`const x = $A$` then $A$"), "`const x = $A$` then A")
    }

    func testCurrencyIsNotInterpretedAsMarkdownMath() {
        let source = "Budget: $1,000; forecast: $1,050."
        let rendered = AssistantMarkdown.inlineAttributed(source)
        XCTAssertEqual(String(rendered.characters), source)
    }

    func testMessageLinksKeepDestinationsAndNonColorAffordance() {
        for inline in [true, false] {
            let rendered = AssistantMarkdown.attributed("Read [the guide](https://example.com/guide) first.", inline: inline)
            XCTAssertEqual(String(rendered.characters), "Read the guide first.")
            let links = rendered.runs.filter { $0.link != nil }
            XCTAssertEqual(links.count, 1)
            XCTAssertEqual(links.first?.link, URL(string: "https://example.com/guide"))
            XCTAssertEqual(links.first?.underlineStyle, .single)
            XCTAssertTrue(rendered.runs.filter { $0.link == nil }.allSatisfy { $0.underlineStyle == nil })
        }
    }

    func testTablePadsShortRowsToHeaderWidth() {
        let source = """
        | A | B | C |
        | --- | --- | --- |
        | 1 | 2 |
        """
        guard case let .table(_, rows) = AssistantMarkdown.blocks(in: source).first else {
            return XCTFail("expected a table block")
        }
        XCTAssertEqual(rows[0], ["1", "2", ""])
    }

    func testOrphanedIndentDegradesToSibling() {
        // A deeper-indented first line has no parent to attach to; it must not
        // be dropped (partially streamed lists hit this mid-render).
        let source = "  - lone child"
        guard case let .list(nodes) = AssistantMarkdown.blocks(in: source).first else {
            return XCTFail("expected a list block")
        }
        XCTAssertEqual(nodes.map(\.text), ["lone child"])
    }

    func testParagraphKeepsSoftLineBreaks() {
        // The chat convention: one found item per line must survive as lines,
        // not fold into a run-on paragraph.
        let source = """
        Found 3 receipts:
        Amazon — $45.99, yesterday
        Delta — flight confirmation
        """
        let blocks = AssistantMarkdown.blocks(in: source)
        guard case let .paragraph(text) = blocks.first, blocks.count == 1 else {
            return XCTFail("expected a single paragraph, got \(blocks)")
        }
        XCTAssertEqual(
            text,
            "Found 3 receipts:\nAmazon — $45.99, yesterday\nDelta — flight confirmation"
        )
        // The bubble renders through AttributedString(markdown:), which folds
        // soft breaks into spaces — the view's hard-break conversion is what
        // must keep the newline real.
        let rendered = try? AttributedString(markdown: AssistantMarkdown.preservingSoftBreaks(text))
        XCTAssertNotNil(rendered)
        let plain = rendered.map { String($0.characters) } ?? ""
        XCTAssertTrue(plain.contains("receipts:\nAmazon"))
    }

    func testTableHTMLBreaksRenderAsLinesAndPreserveCodeExamples() {
        let text = AssistantMarkdown.tableCellText("Press high<br>Switch play<BR />Keep width; code: `<br>`")
        XCTAssertEqual(text, "Press high\nSwitch play\nKeep width; code: `<br>`")
        let rendered = try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
        XCTAssertEqual(rendered.map { String($0.characters) }, "Press high\nSwitch play\nKeep width; code: <br>")
    }

    func testInlineMarkdownForCardDetailsDoesNotExposeDelimiters() {
        let rendered = AssistantMarkdown.inlineAttributed("- 💨 **Wind:** 15 km/h")
        XCTAssertEqual(String(rendered.characters), "- 💨 Wind: 15 km/h")
    }

    func testFutureScoreboardBecomesPollEligibleAtTenMinuteBoundary() throws {
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(#"""
        {
            "id":"game-1","league":"mlb","state":"pre",
            "startsAt":"2026-10-06T20:00:00Z",
            "home":{"name":"Home"},"away":{"name":"Away"}
        }
        """#.utf8))
        let game = try XCTUnwrap(ScoreGame(value))
        let kickoff = try XCTUnwrap(game.startsAt)
        XCTAssertFalse(game.canChange(at: kickoff.addingTimeInterval(-601)))
        XCTAssertTrue(game.canChange(at: kickoff.addingTimeInterval(-600)))
    }
}

extension AssistantMarkdownTests {
    @MainActor
    func testOwnedTranscriptHostPreservesIdentityStateAndInheritedUpdates() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousKeyWindow = scene.keyWindow
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        let state = OwnedTranscriptHostRegressionState()
        let boundaryProbe = TranscriptHostBoundaryProbe(
            marker: { $0[OwnedTranscriptHostMarkerKey.self] },
            contentRevision: { [weak state] in state?.contentRevision ?? -1 }
        )
        state.boundaryProbe = boundaryProbe
        let rowID = "approved-receipts-receipt-one-receipt-two"
        let probe = ChatTranscriptRowGeometryProbe(messageID: rowID) { measurement in
            state.receiptMeasurement = measurement
        }
        let root = UIHostingController(
            rootView: OwnedTranscriptHostRegressionFixture(state: state)
                .environment(\.chatTranscriptRowGeometryProbe, probe)
                .environment(\.transcriptHostBoundaryProbe, boundaryProbe)
        )
        window.rootViewController = root
        window.makeKeyAndVisible()
        defer {
            window.endEditing(true)
            window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKey()
        }

        try await waitForTranscriptHostCondition("initial environment and actual receipt geometry") {
            state.environmentSnapshots.last?.localeIdentifier == "en_US"
                && state.receiptMeasurement?.frame(in: window) != nil
                && state.systemEnvironmentSnapshots[0] != nil
        }
        XCTAssertEqual(boundaryProbe.hostingControllerInitializationCount, 1,
            "The child UIHostingController is constructed once for this owned host.")
        XCTAssertEqual(boundaryProbe.parentSnapshotGeneration, boundaryProbe.parentSnapshotCommitCount,
            "Snapshot generation counts committed parent updates independently of root-value assignments.")
        XCTAssertEqual(boundaryProbe.rootValueUpdateCount, boundaryProbe.parentSnapshotCommitCount,
            "Each committed parent snapshot updates the root value once; initialization is counted separately.")
        let initialScroll = try XCTUnwrap(ownedTranscriptScrollView(in: window))
        let initialHierarchy = ownedTranscriptControllerIdentities(root: root, containing: initialScroll)
        XCTAssertGreaterThanOrEqual(initialHierarchy.count, 3,
            "The root, owned container and child transcript host must all be present.")
        let input = try XCTUnwrap(ownedTextField(in: window), "The test-owned transcript input must expose its UITextField.")
        XCTAssertTrue(input.isDescendant(of: initialScroll), "The test-owned input must be inside the transcript host.")
        XCTAssertTrue(input.window === window, "The test-owned input must belong to the measured window.")
        let inputFrameBeforeFocus = input.convert(input.bounds, to: window)
        XCTAssertTrue(inputFrameBeforeFocus.minX.isFinite && inputFrameBeforeFocus.minY.isFinite)
        XCTAssertTrue(inputFrameBeforeFocus.maxX.isFinite && inputFrameBeforeFocus.maxY.isFinite)
        XCTAssertGreaterThan(inputFrameBeforeFocus.width, 0)
        XCTAssertGreaterThan(inputFrameBeforeFocus.height, 0)
        XCTAssertTrue(input.becomeFirstResponder(), "The native transcript field should focus before the parent update.")
        var previousFocusedGeometry: [CGFloat]?
        var stableFocusedGeometrySamples = 0
        try await waitForTranscriptHostCondition("focused keyboard geometry to settle") {
            let inputFrame = input.convert(input.bounds, to: window)
            let geometry: [CGFloat] = [
                initialScroll.bounds.width, initialScroll.bounds.height,
                initialScroll.contentSize.width, initialScroll.contentSize.height,
                initialScroll.adjustedContentInset.top, initialScroll.adjustedContentInset.bottom,
                initialScroll.contentOffset.x, initialScroll.contentOffset.y,
                inputFrame.minY, inputFrame.width, inputFrame.height,
            ]
            if geometry == previousFocusedGeometry {
                stableFocusedGeometrySamples += 1
            } else {
                previousFocusedGeometry = geometry
                stableFocusedGeometrySamples = 0
            }
            return stableFocusedGeometrySamples >= 3
        }
        let typedDraft = "Typed but unsent transcript draft"
        input.text = typedDraft
        input.sendActions(for: .editingChanged)
        try await waitForTranscriptHostCondition("the native editing event updates the scoped draft") {
            state.draft == typedDraft
        }
        XCTAssertEqual(input.text, typedDraft)
        let selectionStart = try XCTUnwrap(input.position(from: input.beginningOfDocument, offset: 3))
        let selectionEnd = try XCTUnwrap(input.position(from: input.beginningOfDocument, offset: 9))
        input.selectedTextRange = input.textRange(from: selectionStart, to: selectionEnd)
        let expectedSelection = [3, 9]
        XCTAssertEqual(try XCTUnwrap(ownedTextSelectionOffsets(input)), expectedSelection)
        let outerComposer = try XCTUnwrap(ownedView(in: window, accessibilityIdentifier: "transcript-host.outer-composer"))
        XCTAssertFalse(outerComposer.isDescendant(of: initialScroll), "The sibling composer must remain outside the transcript scroll subtree.")

        XCTAssertEqual(state.environmentSnapshots.last?.colorScheme, .light)
        XCTAssertEqual(state.environmentSnapshots.last?.dynamicTypeSize, .large)
        let initialSystemEnvironment = try XCTUnwrap(state.systemEnvironmentSnapshots[0])
        XCTAssertEqual(state.environmentSnapshots.last?.contrast, initialSystemEnvironment.contrast)
        XCTAssertEqual(state.environmentSnapshots.last?.reduceMotion, initialSystemEnvironment.reduceMotion)
        XCTAssertEqual(state.environmentSnapshots.last?.reduceTransparency, initialSystemEnvironment.reduceTransparency)
        XCTAssertEqual(state.environmentSnapshots.last?.layoutDirection, .leftToRight)
        XCTAssertEqual(state.environmentSnapshots.last?.scenePhase, .active)
        XCTAssertEqual(state.environmentSnapshots.last?.modelIdentity, ObjectIdentifier(state.model))

        let collapsedDisclosureHeight = try XCTUnwrap(state.disclosureHeight)
        XCTAssertGreaterThan(try XCTUnwrap(state.receiptMeasurement?.localFrame.height), 0)
        state.disclosureRequest += 1
        try await waitForTranscriptHostCondition("the row-local disclosure expands") {
            (state.disclosureHeight ?? 0) > collapsedDisclosureHeight + 24
        }
        state.openURLRequest += 1
        try await waitForTranscriptHostCondition("the child receives the inherited OpenURL action") {
            state.openedURLs.last == URL(string: "https://transcript-host.test/child")
        }

        let viewportBeforeReveal = try XCTUnwrap(state.viewportMeasurement?.frame(in: window))
        let boundsBeforeReveal = initialScroll.bounds
        let insetBeforeReveal = initialScroll.adjustedContentInset
        let offsetBeforeReveal = initialScroll.contentOffset

        var updateTransaction = Transaction(animation: nil)
        updateTransaction[OwnedTranscriptHostMarkerKey.self] = 73
        attachOwnedTranscriptBoundarySnapshot(
            stage: "reveal-update-start", state: state, root: root,
            window: window, scroll: initialScroll, input: input
        )
        withTransaction(updateTransaction) {
            state.reveal = 18
        }
        try await waitForTranscriptHostCondition("the owned viewport follows the parent reveal") {
            guard let frame = state.viewportMeasurement?.frame(in: window) else { return false }
            return abs(frame.minY - (viewportBeforeReveal.minY - 18)) < 1
        }
        let viewportAfterReveal = try XCTUnwrap(state.viewportMeasurement?.frame(in: window))
        XCTAssertEqual(viewportAfterReveal.minY, viewportBeforeReveal.minY - 18, accuracy: 1)
        XCTAssertEqual(initialScroll.bounds, boundsBeforeReveal)
        XCTAssertEqual(initialScroll.adjustedContentInset, insetBeforeReveal)
        XCTAssertEqual(initialScroll.contentOffset, offsetBeforeReveal)

        attachOwnedTranscriptBoundarySnapshot(
            stage: "updated-child-environment-start", state: state, root: root,
            window: window, scroll: initialScroll, input: input
        )
        withTransaction(updateTransaction) {
            state.contentRevision += 1
            state.colorScheme = .dark
            state.dynamicTypeSize = .accessibility2
            state.locale = Locale(identifier: "fr_FR")
            state.layoutDirection = .rightToLeft
            state.scenePhase = .inactive
            state.model.revision += 1
            state.openURLGeneration = 1
        }

        attachOwnedTranscriptBoundarySnapshot(
            stage: "updated-child-environment-requested", state: state, root: root,
            window: window, scroll: initialScroll, input: input
        )
        try await waitForTranscriptHostCondition("updated child environment reaches the owned host", onTimeout: {
            attachOwnedTranscriptBoundarySnapshot(
                stage: "updated-child-environment", state: state, root: root,
                window: window, scroll: initialScroll, input: input, includeScreenshot: true
            )
        }) {
            let environment = state.environmentSnapshots.last
            let checks: [String: Bool] = [
                "locale": environment?.localeIdentifier == "fr_FR",
                "modelRevision": environment?.modelRevision == 1,
                "marker73": state.transactionMarkers.contains(73),
                "disclosure": state.disclosureStates[state.contentRevision] == true,
                "systemEnvironment": state.systemEnvironmentSnapshots[state.contentRevision] != nil,
                "measurement": state.receiptMeasurement?.frame(in: window) != nil,
            ]
            state.recordPredicateSample(stage: "updated-child-environment", checks: checks)
            return checks.values.allSatisfy { $0 }
        }
        attachOwnedTranscriptBoundarySnapshot(
            stage: "updated-child-environment-result", state: state, root: root,
            window: window, scroll: initialScroll, input: input
        )
        state.openURLRequest += 1
        try await waitForTranscriptHostCondition("the replacement inherited OpenURL action is used") {
            state.openedURLGenerations.last == 1
        }
        let updatedScroll = try XCTUnwrap(ownedTranscriptScrollView(in: window))
        XCTAssertTrue(updatedScroll === initialScroll, "The production transcript UIScrollView must retain identity.")
        XCTAssertEqual(ownedTranscriptControllerIdentities(root: root, containing: updatedScroll), initialHierarchy,
            "The public controller ancestry hosting the scroll view must retain identity.")
        XCTAssertTrue(ownedTextField(in: window) === input,
            "The focused native transcript input must retain its UIKit identity.")
        XCTAssertTrue(input.window === window)
        XCTAssertTrue(input.isFirstResponder, "Environment and content updates must not discard focused native input.")
        XCTAssertEqual(input.text, typedDraft, "The unsent draft must remain in the test-owned native input.")
        XCTAssertEqual(state.draft, typedDraft, "The editingChanged draft binding must survive host updates.")
        XCTAssertEqual(try XCTUnwrap(ownedTextSelectionOffsets(input)), expectedSelection,
            "An unrelated host/environment update must preserve the native text selection.")
        XCTAssertTrue(outerComposer.isDescendant(of: window))
        XCTAssertFalse(outerComposer.isDescendant(of: updatedScroll))
        let updatedEnvironment = try XCTUnwrap(state.environmentSnapshots.last)
        XCTAssertEqual(updatedEnvironment.colorScheme, .dark)
        XCTAssertEqual(updatedEnvironment.dynamicTypeSize, .accessibility2)
        let updatedSystemEnvironment = try XCTUnwrap(state.systemEnvironmentSnapshots[state.contentRevision])
        XCTAssertEqual(updatedEnvironment.contrast, updatedSystemEnvironment.contrast)
        XCTAssertEqual(updatedEnvironment.reduceMotion, updatedSystemEnvironment.reduceMotion)
        XCTAssertEqual(updatedEnvironment.reduceTransparency, updatedSystemEnvironment.reduceTransparency)
        XCTAssertEqual(updatedEnvironment.localeIdentifier, "fr_FR")
        XCTAssertEqual(updatedEnvironment.layoutDirection, .rightToLeft)
        XCTAssertEqual(updatedEnvironment.scenePhase, .inactive)
        XCTAssertEqual(updatedEnvironment.modelIdentity, ObjectIdentifier(state.model))
        XCTAssertEqual(updatedEnvironment.modelRevision, 1)
        XCTAssertTrue(state.receiptMeasurement?.frame(in: window) != nil,
            "The DEBUG row-probe environment must continue converting the real grouped receipt through its current host.")
        XCTAssertGreaterThan(state.receiptMeasurement?.localFrame.height ?? 0, 0,
            "The actual receipt row must remain measurable through the same debug probe.")
        XCTAssertEqual(state.disclosureStates[state.contentRevision], true,
            "The child must report its expanded state for the updated parent content revision.")

        state.rowSheetRequest += 1
        try await waitForTranscriptHostCondition("the row-local sheet presents") {
            ownedPresentedController(in: root) != nil
        }
        let presentedSheet = try XCTUnwrap(ownedPresentedController(in: root))
        updateTransaction[OwnedTranscriptHostMarkerKey.self] = 74
        attachOwnedTranscriptBoundarySnapshot(
            stage: "row-sheet-update-start", state: state, root: root,
            window: window, scroll: initialScroll, input: input, expectedSheet: presentedSheet
        )
        withTransaction(updateTransaction) {
            state.contentRevision += 1
        }
        attachOwnedTranscriptBoundarySnapshot(
            stage: "row-sheet-update-requested", state: state, root: root,
            window: window, scroll: initialScroll, input: input, expectedSheet: presentedSheet
        )
        try await waitForTranscriptHostCondition("the row-local sheet survives a later content update", onTimeout: {
            attachOwnedTranscriptBoundarySnapshot(
                stage: "row-sheet-after-update", state: state, root: root,
                window: window, scroll: initialScroll, input: input,
                expectedSheet: presentedSheet, includeScreenshot: true
            )
        }) {
            let current = ownedPresentedController(in: root)
            let checks: [String: Bool] = [
                "sameController": current === presentedSheet,
                "marker74": state.transactionMarkers.contains(74),
                "rootPresentsController": root.presentedViewController === current,
                "controllerWindow": current?.viewIfLoaded?.window === window,
                "contentRevision": state.contentRevision == 2,
            ]
            state.recordPredicateSample(stage: "row-sheet-after-update", checks: checks)
            return checks["sameController"]! && checks["marker74"]!
        }
        attachOwnedTranscriptBoundarySnapshot(
            stage: "row-sheet-after-update-result", state: state, root: root,
            window: window, scroll: initialScroll, input: input, expectedSheet: presentedSheet
        )
        XCTAssertTrue(ownedTranscriptScrollView(in: window) === initialScroll)
        XCTAssertEqual(ownedTranscriptControllerIdentities(root: root, containing: initialScroll), initialHierarchy)

        try await waitForTranscriptHostCondition("the parent 74 transaction reaches the child-local leaf") {
            guard let observation = state.childTransactionObservations.last else { return false }
            return observation.parentContentRevision == 2 && observation.marker == 74
        }
        try await waitForTranscriptHostCondition("the row-local sheet finishes presenting before child-local updates", onTimeout: {
            attachOwnedTranscriptBoundarySnapshot(
                stage: "row-sheet-presentation-settle-timeout", state: state, root: root,
                window: window, scroll: initialScroll, input: input, expectedSheet: presentedSheet
            )
        }) {
            let currentSheet = ownedPresentedController(in: root)
            let leaf = state.childTransactionObservations.last
            return currentSheet === presentedSheet
                && presentedSheet.viewIfLoaded?.window === window
                && !presentedSheet.isBeingPresented
                && !presentedSheet.isBeingDismissed
                && leaf?.parentContentRevision == 2
                && leaf?.snapshotContentRevision == 2
        }
        attachOwnedTranscriptBoundarySnapshot(
            stage: "row-sheet-presentation-settle-result", state: state, root: root,
            window: window, scroll: initialScroll, input: input, expectedSheet: presentedSheet
        )
        let generationBeforeLocalUpdates = boundaryProbe.parentSnapshotGeneration
        let commitsBeforeLocalUpdates = boundaryProbe.parentSnapshotCommitCount
        let rootUpdatesBeforeLocalUpdates = boundaryProbe.rootValueUpdateCount
        let startingLocalRevision = try XCTUnwrap(state.childTransactionObservations.last?.localRevision)
        var childTransaction99 = Transaction(animation: nil)
        childTransaction99[OwnedTranscriptHostMarkerKey.self] = 99
        let updateChildLocalState = try XCTUnwrap(state.updateChildLocalTransaction)
        updateChildLocalState(childTransaction99)
        try await waitForTranscriptHostCondition("the child-local state observes transaction 99", onTimeout: {
            attachOwnedTranscriptBoundarySnapshot(
                stage: "child-local-transaction-99-timeout", state: state, root: root,
                window: window, scroll: initialScroll, input: input, expectedSheet: presentedSheet
            )
        }) {
            guard let observation = state.childTransactionObservations.last else { return false }
            return observation.parentContentRevision == 2
                && observation.snapshotContentRevision == 2
                && observation.localRevision == startingLocalRevision + 1
                && observation.marker == 99
                && observation.snapshotGeneration == generationBeforeLocalUpdates
        }
        attachOwnedTranscriptBoundarySnapshot(
            stage: "child-local-transaction-99-result", state: state, root: root,
            window: window, scroll: initialScroll, input: input, expectedSheet: presentedSheet
        )
        let observed99 = try XCTUnwrap(state.childTransactionObservations.last)
        XCTAssertEqual(observed99.parentContentRevision, 2)
        XCTAssertEqual(observed99.snapshotContentRevision, 2)
        XCTAssertEqual(observed99.localRevision, startingLocalRevision + 1)
        XCTAssertEqual(observed99.marker, 99)
        XCTAssertEqual(observed99.snapshotGeneration, generationBeforeLocalUpdates)
        XCTAssertEqual(boundaryProbe.parentSnapshotGeneration, generationBeforeLocalUpdates)
        XCTAssertEqual(boundaryProbe.parentSnapshotCommitCount, commitsBeforeLocalUpdates,
            "A child-local transaction must not commit a parent snapshot.")
        XCTAssertEqual(boundaryProbe.rootValueUpdateCount, rootUpdatesBeforeLocalUpdates,
            "A child-local transaction must not assign a new root value.")
        XCTAssertEqual(boundaryProbe.hostingControllerInitializationCount, 1,
            "A child-local transaction must retain the single hosting controller.")

        let generationBeforeDefaultLocalUpdate = boundaryProbe.parentSnapshotGeneration
        let commitsBeforeDefaultLocalUpdate = boundaryProbe.parentSnapshotCommitCount
        let rootUpdatesBeforeDefaultLocalUpdate = boundaryProbe.rootValueUpdateCount
        var childDefaultTransaction = Transaction()
        childDefaultTransaction[OwnedTranscriptHostMarkerKey.self] = 0
        updateChildLocalState(childDefaultTransaction)
        try await waitForTranscriptHostCondition("the child-local state observes default transaction 0", onTimeout: {
            attachOwnedTranscriptBoundarySnapshot(
                stage: "child-local-default-transaction-timeout", state: state, root: root,
                window: window, scroll: initialScroll, input: input, expectedSheet: presentedSheet
            )
        }) {
            guard let observation = state.childTransactionObservations.last else { return false }
            return observation.parentContentRevision == 2
                && observation.snapshotContentRevision == 2
                && observation.localRevision == startingLocalRevision + 2
                && observation.marker == 0
                && observation.snapshotGeneration == generationBeforeDefaultLocalUpdate
        }
        attachOwnedTranscriptBoundarySnapshot(
            stage: "child-local-default-transaction-result", state: state, root: root,
            window: window, scroll: initialScroll, input: input, expectedSheet: presentedSheet
        )
        let observedDefaultLocal = try XCTUnwrap(state.childTransactionObservations.last)
        XCTAssertEqual(observedDefaultLocal.parentContentRevision, 2)
        XCTAssertEqual(observedDefaultLocal.snapshotContentRevision, 2)
        XCTAssertEqual(observedDefaultLocal.localRevision, startingLocalRevision + 2)
        XCTAssertEqual(observedDefaultLocal.marker, 0)
        XCTAssertEqual(observedDefaultLocal.snapshotGeneration, generationBeforeDefaultLocalUpdate)
        XCTAssertEqual(boundaryProbe.parentSnapshotGeneration, generationBeforeDefaultLocalUpdate)
        XCTAssertEqual(boundaryProbe.parentSnapshotCommitCount, commitsBeforeDefaultLocalUpdate,
            "A second child-local transaction must not commit a parent snapshot.")
        XCTAssertEqual(boundaryProbe.rootValueUpdateCount, rootUpdatesBeforeDefaultLocalUpdate,
            "The default child-local transaction must not assign a new root value.")
        XCTAssertEqual(boundaryProbe.hostingControllerInitializationCount, 1,
            "Child-local transactions must retain the single hosting controller.")

        let generationBeforeDefaultParentUpdate = boundaryProbe.parentSnapshotGeneration
        let commitsBeforeDefaultParentUpdate = boundaryProbe.parentSnapshotCommitCount
        let rootUpdatesBeforeDefaultParentUpdate = boundaryProbe.rootValueUpdateCount
        state.contentRevision += 1
        try await waitForTranscriptHostCondition("a later default parent transaction reaches the child leaf", onTimeout: {
            attachOwnedTranscriptBoundarySnapshot(
                stage: "default-parent-transaction-timeout", state: state, root: root,
                window: window, scroll: initialScroll, input: input, expectedSheet: presentedSheet
            )
        }) {
            guard let observation = state.childTransactionObservations.last else { return false }
            return observation.parentContentRevision == 3
                && observation.snapshotContentRevision == 3
                && observation.localRevision == startingLocalRevision + 2
                && observation.marker == 0
                && observation.snapshotGeneration > generationBeforeDefaultParentUpdate
        }
        attachOwnedTranscriptBoundarySnapshot(
            stage: "default-parent-transaction-result", state: state, root: root,
            window: window, scroll: initialScroll, input: input, expectedSheet: presentedSheet
        )
        let observedDefaultParent = try XCTUnwrap(state.childTransactionObservations.last)
        XCTAssertEqual(observedDefaultParent.parentContentRevision, 3)
        XCTAssertEqual(observedDefaultParent.localRevision, startingLocalRevision + 2)
        XCTAssertEqual(observedDefaultParent.marker, 0)
        XCTAssertGreaterThan(boundaryProbe.parentSnapshotGeneration, generationBeforeDefaultParentUpdate)
        XCTAssertGreaterThan(boundaryProbe.parentSnapshotCommitCount, commitsBeforeDefaultParentUpdate)
        XCTAssertGreaterThan(boundaryProbe.rootValueUpdateCount, rootUpdatesBeforeDefaultParentUpdate)
        XCTAssertEqual(boundaryProbe.rootValueUpdateCount, boundaryProbe.parentSnapshotCommitCount)
        XCTAssertEqual(observedDefaultParent.snapshotGeneration, boundaryProbe.parentSnapshotGeneration)
        XCTAssertEqual(observedDefaultParent.snapshotContentRevision, 3,
            "The leaf reports the content revision captured in its rendered parent snapshot.")
        XCTAssertEqual(boundaryProbe.hostingControllerInitializationCount, 1,
            "Parent updates must retain the single hosting controller.")
        XCTAssertTrue(ownedTranscriptScrollView(in: window) === initialScroll,
            "A default parent transaction must preserve the transcript scroll view identity")
        XCTAssertEqual(ownedTranscriptControllerIdentities(root: root, containing: initialScroll), initialHierarchy)
        XCTAssertTrue(ownedPresentedController(in: root) === presentedSheet,
            "Child-local and default parent transaction checks must preserve the row-local sheet")

        state.rowSheetRequest += 1
        try await waitForTranscriptHostCondition("the row-local sheet dismisses") {
            ownedPresentedController(in: root) == nil
        }
    }
}

@Observable @MainActor
private final class OwnedTranscriptHostRegressionModel {
    var revision = 0
}

@MainActor
private final class OwnedTranscriptHostRegressionState: ObservableObject {
    @Published var reveal: CGFloat = 0
    @Published var contentRevision = 0
    @Published var colorScheme: ColorScheme = .light
    @Published var dynamicTypeSize: DynamicTypeSize = .large
    @Published var locale = Locale(identifier: "en_US")
    @Published var layoutDirection: LayoutDirection = .leftToRight
    @Published var scenePhase: ScenePhase = .active
    @Published var disclosureRequest = 0
    @Published var rowSheetRequest = 0
    @Published var openURLRequest = 0
    @Published var openURLGeneration = 0
    @Published var draft = "Unsent transcript draft"

    let model = OwnedTranscriptHostRegressionModel()
    var environmentSnapshots: [OwnedTranscriptEnvironmentSnapshot] = []
    var systemEnvironmentSnapshots: [Int: OwnedTranscriptSystemEnvironmentSnapshot] = [:]
    var transactionMarkers: [Int] = []
    var receiptMeasurement: TranscriptGeometryMeasurement?
    var viewportMeasurement: TranscriptGeometryMeasurement?
    var disclosureHeight: CGFloat?
    var disclosureStates: [Int: Bool] = [:]
    var openedURLs: [URL] = []
    var openedURLGenerations: [Int] = []
    var boundaryProbe: TranscriptHostBoundaryProbe?
    var predicateSamples: [[String: Any]] = []
    var childTransactionObservations: [OwnedTranscriptChildTransactionObservation] = []
    var updateChildLocalTransaction: (@MainActor (Transaction) -> Void)?

    func recordChildTransactionObservation(_ observation: OwnedTranscriptChildTransactionObservation) {
        childTransactionObservations.append(observation)
        if childTransactionObservations.count > 96 { childTransactionObservations.removeFirst() }
    }

    func recordPredicateSample(stage: String, checks: [String: Bool]) {
        if let last = predicateSamples.last,
           last["stage"] as? String == stage,
           last["checks"] as? [String: Bool] == checks,
           last["contentRevision"] as? Int == contentRevision {
            return
        }
        predicateSamples.append([
            "time": CACurrentMediaTime(),
            "stage": stage,
            "contentRevision": contentRevision,
            "checks": checks,
        ])
        if predicateSamples.count > 96 { predicateSamples.removeFirst() }
    }
}

private struct OwnedTranscriptChildTransactionObservation: Equatable {
    let parentContentRevision: Int
    let snapshotContentRevision: Int
    let localRevision: Int
    let marker: Int
    let snapshotGeneration: Int
}

private struct OwnedTranscriptEnvironmentSnapshot: Equatable {
    let colorScheme: ColorScheme
    let dynamicTypeSize: DynamicTypeSize
    let contrast: ColorSchemeContrast
    let reduceMotion: Bool
    let reduceTransparency: Bool
    let localeIdentifier: String
    let layoutDirection: LayoutDirection
    let scenePhase: ScenePhase
    let modelIdentity: ObjectIdentifier
    let modelRevision: Int
}

private struct OwnedTranscriptSystemEnvironmentSnapshot: Equatable {
    let contrast: ColorSchemeContrast
    let reduceMotion: Bool
    let reduceTransparency: Bool
}

private struct OwnedTranscriptSystemEnvironmentReader: View {
    let contentRevision: Int
    let report: (Int, OwnedTranscriptSystemEnvironmentSnapshot) -> Void
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    private var snapshot: OwnedTranscriptSystemEnvironmentSnapshot {
        .init(contrast: contrast, reduceMotion: reduceMotion, reduceTransparency: reduceTransparency)
    }

    var body: some View {
        Color.clear.frame(width: 1, height: 1)
            .onAppear { report(contentRevision, snapshot) }
            .onChange(of: contentRevision) { _, revision in report(revision, snapshot) }
            .onChange(of: snapshot) { _, value in report(contentRevision, value) }
    }
}

private struct OwnedTranscriptHostMarkerKey: TransactionKey {
    static var defaultValue: Int { 0 }
}

private struct OwnedTranscriptEnvironmentReader: View {
    @ObservedObject var state: OwnedTranscriptHostRegressionState
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.locale) private var locale
    @Environment(\.layoutDirection) private var layoutDirection
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @Environment(OwnedTranscriptHostRegressionModel.self) private var model

    private var snapshot: OwnedTranscriptEnvironmentSnapshot {
        .init(colorScheme: colorScheme, dynamicTypeSize: dynamicTypeSize, contrast: contrast,
              reduceMotion: reduceMotion, reduceTransparency: reduceTransparency,
              localeIdentifier: locale.identifier, layoutDirection: layoutDirection,
              scenePhase: scenePhase, modelIdentity: ObjectIdentifier(model), modelRevision: model.revision)
    }

    var body: some View {
        Color.clear.frame(width: 1, height: 1)
        .onAppear { state.environmentSnapshots.append(snapshot) }
        .onChange(of: snapshot) { _, value in state.environmentSnapshots.append(value) }
        .onChange(of: state.openURLRequest) { _, _ in
            _ = openURL(URL(string: "https://transcript-host.test/child")!)
        }
    }
}

private struct OwnedTranscriptHostRegressionFixture: View {
    @ObservedObject var state: OwnedTranscriptHostRegressionState

    private var receipts: [ChatMessage] {
        [
            ChatMessage(id: "receipt-one", role: .assistant, parts: [
                .init(type: "approval", approvalId: "approval-one", shortCode: "A21",
                      summary: "Confirm the first approved request", purpose: "Transcript host regression", status: "approved")
            ]),
            ChatMessage(id: "receipt-two", role: .assistant, parts: [
                .init(type: "approval", approvalId: "approval-two", shortCode: "A22",
                      summary: "Confirm the second approved request", purpose: "Transcript host regression", status: "approved")
            ]),
        ]
    }

    var body: some View {
        let openURLGeneration = state.openURLGeneration
        ZStack(alignment: .bottom) {
            ConversationColumn {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        OwnedTranscriptEnvironmentReader(state: state)
                        OwnedTranscriptDisclosureRow(state: state)
                        ChatTranscriptRows(
                            messages: receipts,
                            isSending: false,
                            openApprovals: {},
                            send: { _, _ in },
                            decideApproval: { _, _ in true },
                            rememberApproval: { _ in true },
                            decideSuggestion: { _, _ in nil },
                            openActivity: {},
                            refreshCard: { _, _ in nil },
                            hideMessage: { _ in },
                            setRecallSourceSuppressed: { _, _, _ in .discarded },
                            recallSourceSuppressed: { _, _ in nil },
                            acknowledgeMessageDelivery: { _ in false },
                            cardFormActions: nil,
                            cardFormStateRevision: 0,
                            cardFormTaskRevision: 0
                        )
                        .equatable()
                        OwnedTranscriptNativeInput(text: $state.draft)
                            .frame(maxWidth: .infinity, minHeight: 44, maxHeight: 44, alignment: .leading)
                        OwnedTranscriptTransactionLeaf(
                            state: state, parentContentRevision: state.contentRevision
                        )
                    }
                    .padding(.bottom, 100)
                }
                .scrollIndicators(.hidden)
                .onTranscriptGeometryChange { state.viewportMeasurement = $0 }
            } composer: {
                OwnedTranscriptNativeComposer()
                    .accessibilityIdentifier("transcript-host.outer-composer")
                    .frame(height: 52)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .offset(y: -state.reveal)
        }
        .overlay(alignment: .topLeading) {
            // These SDK values are system-owned and read-only. Observe the
            // actual parent environment without changing system preferences.
            OwnedTranscriptSystemEnvironmentReader(contentRevision: state.contentRevision) { revision, snapshot in
                state.systemEnvironmentSnapshots[revision] = snapshot
            }
            .allowsHitTesting(false)
        }
        .environment(state.model)
        .environment(\.colorScheme, state.colorScheme)
        .environment(\.dynamicTypeSize, state.dynamicTypeSize)
        .environment(\.locale, state.locale)
        .environment(\.layoutDirection, state.layoutDirection)
        .environment(\.scenePhase, state.scenePhase)
        .environment(\.openURL, OpenURLAction { url in
            state.openedURLs.append(url)
            state.openedURLGenerations.append(openURLGeneration)
            return .handled
        })
    }
}

private struct OwnedTranscriptDisclosureRow: View {
    @ObservedObject var state: OwnedTranscriptHostRegressionState
    @State private var isExpanded = false
    @State private var isSheetPresented = false

    var body: some View {
        DisclosureGroup("Row-local details", isExpanded: $isExpanded) {
            Text("Expanded row-local state survives the parent update.")
                .fixedSize(horizontal: false, vertical: true)
        }
        .onAppear { state.disclosureStates[state.contentRevision] = isExpanded }
        .onChange(of: state.disclosureRequest) { _, _ in isExpanded.toggle() }
        .onChange(of: isExpanded) { _, expanded in
            state.disclosureStates[state.contentRevision] = expanded
        }
        .onChange(of: state.contentRevision) { _, revision in
            state.disclosureStates[revision] = isExpanded
        }
        .onChange(of: state.rowSheetRequest) { _, _ in isSheetPresented.toggle() }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { state.disclosureHeight = $0 }
        .sheet(isPresented: $isSheetPresented) {
            Text("Row-local sheet survives transcript updates.")
        }
    }
}

private struct OwnedTranscriptTransactionLeaf: View {
    let state: OwnedTranscriptHostRegressionState
    let parentContentRevision: Int
    @Environment(\.transcriptHostSnapshotGeneration) private var snapshotGeneration
    @Environment(\.transcriptHostSnapshotContentRevision) private var snapshotContentRevision
    @State private var localRevision = 0

    var body: some View {
        Text("Transcript content revision \(parentContentRevision), child revision \(localRevision)")
            // This parent-owned leaf records the transaction actually reaching
            // the hosted content. The registered update changes only this
            // child's @State and does not publish a parent-state mutation.
            .transaction { transaction in
                let marker = transaction[OwnedTranscriptHostMarkerKey.self]
                let generation = snapshotGeneration ?? -1
                state.boundaryProbe?.record(
                    "child-leaf", transaction: transaction, generation: generation,
                    contentRevision: snapshotContentRevision ?? -1
                )
                state.recordChildTransactionObservation(.init(
                    parentContentRevision: parentContentRevision,
                    snapshotContentRevision: snapshotContentRevision ?? -1,
                    localRevision: localRevision,
                    marker: marker,
                    snapshotGeneration: generation
                ))
                if state.transactionMarkers.last != marker {
                    state.transactionMarkers.append(marker)
                }
            }
            .onAppear {
                let localRevisionBinding = $localRevision
                state.updateChildLocalTransaction = { transaction in
                    withTransaction(transaction) {
                        localRevisionBinding.wrappedValue += 1
                    }
                }
            }
            .onDisappear { state.updateChildLocalTransaction = nil }
    }
}

private struct OwnedTranscriptNativeComposer: UIViewRepresentable {
    func makeUIView(context: Context) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle("Outer composer", for: .normal)
        button.accessibilityIdentifier = "transcript-host.outer-composer"
        return button
    }

    func updateUIView(_ uiView: UIButton, context: Context) {}
}

private struct OwnedTranscriptNativeInput: UIViewRepresentable {
    @Binding var text: String

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text)
    }

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField(frame: .zero)
        field.borderStyle = .roundedRect
        field.accessibilityIdentifier = "transcript-host.native-input"
        field.text = text
        field.addTarget(context.coordinator, action: #selector(Coordinator.editingChanged(_:)), for: .editingChanged)
        return field
    }

    func updateUIView(_ uiView: UITextField, context: Context) {
        context.coordinator.text = $text
        if uiView.text != text {
            uiView.text = text
        }
    }

    @MainActor
    final class Coordinator: NSObject {
        var text: Binding<String>

        init(text: Binding<String>) {
            self.text = text
        }

        @objc func editingChanged(_ sender: UITextField) {
            text.wrappedValue = sender.text ?? ""
        }
    }
}

@MainActor
private func ownedTranscriptScrollView(in root: UIView) -> UIScrollView? {
    if let scroll = root as? UIScrollView, !(scroll is UITextView) { return scroll }
    for child in root.subviews {
        if let found = ownedTranscriptScrollView(in: child) { return found }
    }
    return nil
}

@MainActor
private func ownedTextField(in root: UIView) -> UITextField? {
    if let field = root as? UITextField,
       field.accessibilityIdentifier == "transcript-host.native-input" { return field }
    for child in root.subviews {
        if let found = ownedTextField(in: child) { return found }
    }
    return nil
}

@MainActor
private func ownedTextSelectionOffsets(_ field: UITextField) -> [Int]? {
    guard let selectedRange = field.selectedTextRange else { return nil }
    return [
        field.offset(from: field.beginningOfDocument, to: selectedRange.start),
        field.offset(from: field.beginningOfDocument, to: selectedRange.end),
    ]
}

@MainActor
private func ownedView(in root: UIView, accessibilityIdentifier: String) -> UIView? {
    if root.accessibilityIdentifier == accessibilityIdentifier { return root }
    for child in root.subviews {
        if let found = ownedView(in: child, accessibilityIdentifier: accessibilityIdentifier) { return found }
    }
    return nil
}

@MainActor
private func ownedTranscriptControllerIdentities(root: UIViewController, containing scroll: UIScrollView) -> [ObjectIdentifier] {
    func containsScroll(_ controller: UIViewController) -> Bool {
        guard controller.isViewLoaded else { return false }
        return ownedTranscriptScrollView(in: controller.view) === scroll
    }
    var result = [ObjectIdentifier(root)]
    var current = root
    while let child = current.children.first(where: containsScroll) {
        result.append(ObjectIdentifier(child))
        current = child
    }
    return result
}

@MainActor
private func ownedPresentedController(in root: UIViewController) -> UIViewController? {
    if let presented = root.presentedViewController { return presented }
    for child in root.children {
        if let presented = ownedPresentedController(in: child) { return presented }
    }
    return nil
}

@MainActor
private func waitForTranscriptHostCondition(
    _ label: String,
    timeout: Duration = .seconds(3),
    onTimeout: (() -> Void)? = nil,
    condition: @escaping @MainActor () -> Bool
) async throws {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while !condition(), ContinuousClock.now < deadline {
        try await Task.sleep(for: .milliseconds(25))
    }
    let succeeded = condition()
    if !succeeded { onTimeout?() }
    XCTAssertTrue(succeeded, "Timed out waiting for \(label)")
}

@MainActor
private func attachOwnedTranscriptBoundarySnapshot(
    stage: String,
    state: OwnedTranscriptHostRegressionState,
    root: UIViewController,
    window: UIWindow,
    scroll: UIScrollView,
    input: UITextField,
    expectedSheet: UIViewController? = nil,
    includeScreenshot: Bool = false
) {
    let presented = ownedPresentedController(in: root)
    let currentScroll = root.isViewLoaded ? ownedTranscriptScrollView(in: root.view) : nil
    let traits = root.viewIfLoaded?.traitCollection
    let payload: [String: Any] = [
        "stage": stage,
        "contentRevision": state.contentRevision,
        "rootControllerIdentity": ObjectIdentifier(root).hashValue,
        "windowIdentity": ObjectIdentifier(window).hashValue,
        "transactionMarkers": state.transactionMarkers,
        "boundaryEvents": state.boundaryProbe?.events ?? [],
        "parentSnapshotGeneration": state.boundaryProbe?.parentSnapshotGeneration ?? -1,
        "parentSnapshotCommitCount": state.boundaryProbe?.parentSnapshotCommitCount ?? -1,
        "hostingControllerInitializationCount": state.boundaryProbe?.hostingControllerInitializationCount ?? -1,
        "rootValueUpdateCount": state.boundaryProbe?.rootValueUpdateCount ?? -1,
        "childTransactionObservations": state.childTransactionObservations.suffix(16).map {
            ["parentContentRevision": $0.parentContentRevision,
             "snapshotContentRevision": $0.snapshotContentRevision,
             "localRevision": $0.localRevision,
             "marker": $0.marker,
             "snapshotGeneration": $0.snapshotGeneration]
        },
        "predicateSamples": state.predicateSamples,
        "environmentSnapshots": state.environmentSnapshots.suffix(8).map {
            ["locale": $0.localeIdentifier, "scheme": String(describing: $0.colorScheme),
             "dynamicType": String(describing: $0.dynamicTypeSize), "modelRevision": $0.modelRevision,
             "modelIdentity": $0.modelIdentity.hashValue,
             "layoutDirection": String(describing: $0.layoutDirection), "scenePhase": String(describing: $0.scenePhase)]
        },
        "systemEnvironmentSnapshots": Dictionary(uniqueKeysWithValues: state.systemEnvironmentSnapshots.map { revision, snapshot in
            (String(revision), ["contrast": String(describing: snapshot.contrast),
                                "reduceMotion": snapshot.reduceMotion,
                                "reduceTransparency": snapshot.reduceTransparency] as [String: Any])
        }),
        "disclosureStates": Dictionary(uniqueKeysWithValues: state.disclosureStates.map { (String($0.key), $0.value) }),
        "disclosureHeight": state.disclosureHeight ?? -1,
        "receiptLocalFrame": String(describing: state.receiptMeasurement?.localFrame),
        "receiptWindowFrameValid": state.receiptMeasurement?.frame(in: window) != nil,
        "scrollIdentity": ObjectIdentifier(scroll).hashValue,
        "currentScrollSameIdentity": currentScroll === scroll,
        "currentScrollAttached": currentScroll?.isDescendant(of: window) ?? false,
        "scrollWindow": scroll.window === window,
        "scrollBounds": String(describing: scroll.bounds),
        "scrollOffset": String(describing: scroll.contentOffset),
        "controllerHierarchy": ownedTranscriptControllerIdentities(root: root, containing: scroll).map(\.hashValue),
        "inputIdentity": ObjectIdentifier(input).hashValue,
        "inputInWindow": input.window === window,
        "inputFocused": input.isFirstResponder,
        "inputText": input.text ?? "",
        "inputSelection": ownedTextSelectionOffsets(input) ?? [],
        "presentedControllerExists": presented != nil,
        "presentedControllerMatchesExpected": expectedSheet.map { presented === $0 } ?? false,
        "presentedControllerIdentity": presented.map { ObjectIdentifier($0).hashValue } ?? -1,
        "expectedControllerIdentity": expectedSheet.map { ObjectIdentifier($0).hashValue } ?? -1,
        "rootPresentsCurrentController": root.presentedViewController === presented,
        "currentControllerPresentedByRoot": presented?.presentingViewController === root,
        "currentControllerInWindow": presented?.viewIfLoaded?.window === window,
        "currentControllerBeingPresented": presented?.isBeingPresented ?? false,
        "currentControllerBeingDismissed": presented?.isBeingDismissed ?? false,
        "currentControllerType": presented.map { String(describing: type(of: $0)) } ?? "none",
        "currentControllerPresenterType": presented?.presentingViewController.map { String(describing: type(of: $0)) } ?? "none",
        "expectedControllerInWindow": expectedSheet?.viewIfLoaded?.window === window,
        "expectedControllerBeingPresented": expectedSheet?.isBeingPresented ?? false,
        "expectedControllerBeingDismissed": expectedSheet?.isBeingDismissed ?? false,
        "expectedControllerPresenterType": expectedSheet?.presentingViewController.map { String(describing: type(of: $0)) } ?? "none",
        "windowSceneSession": window.windowScene?.session.persistentIdentifier ?? "none",
        "windowAccessibilityContrast": String(describing: window.traitCollection.accessibilityContrast),
        "rootAccessibilityContrast": String(describing: traits?.accessibilityContrast ?? .normal),
        "rootUserInterfaceStyle": String(describing: traits?.userInterfaceStyle ?? .unspecified),
        "rootPreferredContentSizeCategory": traits?.preferredContentSizeCategory.rawValue ?? "none",
    ]
    do {
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "Owned transcript host boundary snapshot — \(stage)"
        attachment.lifetime = .keepAlways
        XCTContext.runActivity(named: "Owned transcript host boundary snapshot") { activity in
            activity.add(attachment)
            if includeScreenshot {
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                let screenshot = XCTAttachment(image: image)
                screenshot.name = "Owned transcript host failure — \(stage)"
                screenshot.lifetime = .keepAlways
                activity.add(screenshot)
            }
        }
    } catch {
        XCTFail("Could not serialize owned transcript boundary receipt: \(error)")
    }
}
