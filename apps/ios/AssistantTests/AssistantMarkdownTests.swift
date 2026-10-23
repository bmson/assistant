import XCTest
import SwiftUI
@testable import Assistant

@MainActor
private final class LiftedTranscriptFixtureState: ObservableObject {
    @Published var reveal: CGFloat = 0
    @Published var composerHeight: CGFloat = 60
    @Published var availableHeight: CGFloat = 852
    @Published var jumpRequest = 0
    @Published var noticeHeight: CGFloat = 0
    @Published var showsJumpChrome = false
    var transcriptViewport: CGRect = .zero
    var composer: CGRect = .zero
    var notice: CGRect = .zero
    var lastCard: CGRect = .zero
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
                                    .onGeometryChange(for: CGRect.self) {
                                        $0.frame(in: .global)
                                    } action: {
                                        state.lastCard = $0
                                    }
                            }
                            .padding(.bottom, state.composerHeight + 30
                                + (state.noticeHeight > 0 ? state.noticeHeight + 8 : 0))
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .scrollClipDisabled()
                        .scrollPosition($position)
                        .transaction {
                            if state.reveal > 0 {
                                $0.scrollContentOffsetAdjustmentBehavior = .disabled
                            }
                        }
                        .defaultScrollAnchor(.bottom)
                        .onGeometryChange(for: CGRect.self) {
                            $0.frame(in: .global)
                        } action: {
                            state.transcriptViewport = $0
                        }
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
        let model = AppModel(initialMessages: messages)
        window.rootViewController = UIHostingController(rootView:
            ChatView(safeAreaTopInset: 62, safeAreaBottomInset: 34,
                safeAreaLeadingInset: 0, safeAreaTrailingInset: 0)
                .environment(model).environment(\.colorScheme, .light))
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
        let initialMessageCount = model.messages.count
        // Drive the real UITextView delegate/binding path so the send affordance
        // is in its ready state. This only changes the draft; it never taps or
        // invokes the send action.
        input.text = "Layout interaction probe"
        input.delegate?.textViewDidChange?(input)
        func accessibilityFrame(containing marker: String, in view: UIView) -> CGRect? {
            if view.accessibilityLabel?.contains(marker) == true, !view.bounds.isEmpty {
                return view.convert(view.bounds, to: window)
            }
            for index in 0..<max(view.accessibilityElementCount(), 0) {
                guard let element = view.accessibilityElement(at: index) else { continue }
                if let childView = element as? UIView {
                    if childView !== view,
                       let frame = accessibilityFrame(containing: marker, in: childView) {
                        return frame
                    }
                } else if let element = element as? UIAccessibilityElement,
                          element.accessibilityLabel?.contains(marker) == true,
                          !element.accessibilityFrame.isEmpty {
                    return window.convert(element.accessibilityFrame, from: nil)
                }
            }
            for childView in view.subviews {
                if let frame = accessibilityFrame(containing: marker, in: childView) { return frame }
            }
            return nil
        }
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
        struct AccessibilityNodeReceipt {
            let identifier: String
            let elementType: String
            let isAccessibilityElement: Bool
            let hasLabel: Bool
            let frame: CGRect
        }
        struct AccessibilityReceipt {
            let sendFrame: CGRect?
            let sendFrameSource: String?
            let nodes: [AccessibilityNodeReceipt]
            let visitedObjectCount: Int
            let depthTruncated: Bool
            let objectBudgetTruncated: Bool
            let elementCountTruncated: Bool
            let arrayCountTruncated: Bool
            let nodeArrayTruncated: Bool
            let missingDeclaredChildCount: Int
            let unknownCountContainerCount: Int
            var publicEnumerationComplete: Bool {
                !depthTruncated && !objectBudgetTruncated && !elementCountTruncated
                    && !arrayCountTruncated && !nodeArrayTruncated && missingDeclaredChildCount == 0
            }
        }
        func accessibilityReceipt(in root: UIView) -> AccessibilityReceipt {
            var visited = Set<ObjectIdentifier>()
            var nodes: [AccessibilityNodeReceipt] = []
            var sendFrame: CGRect?
            var sendFrameSource: String?
            var depthTruncated = false
            var objectBudgetTruncated = false
            var elementCountTruncated = false
            var arrayCountTruncated = false
            var nodeArrayTruncated = false
            var missingDeclaredChildCount = 0
            var unknownCountContainerCount = 0
            let objectBudget = 10_000
            let childBudget = 2_000

            func visit(_ object: AnyObject, depth: Int) {
                let objectID = ObjectIdentifier(object)
                guard !visited.contains(objectID) else { return }
                guard visited.count < objectBudget else { objectBudgetTruncated = true; return }
                visited.insert(objectID)
                guard depth < 32 else { depthTruncated = true; return }

                if let view = object as? UIView {
                    let identifier = view.accessibilityIdentifier ?? ""
                    let frame = view.convert(view.bounds, to: window)
                    if view.isAccessibilityElement || !identifier.isEmpty || view.accessibilityLabel != nil {
                        nodes.append(.init(
                            identifier: identifier,
                            elementType: String(describing: type(of: view)),
                            isAccessibilityElement: view.isAccessibilityElement,
                            hasLabel: !(view.accessibilityLabel ?? "").isEmpty,
                            frame: frame
                        ))
                    }
                    if identifier == "assistant.chat.send", !view.bounds.isEmpty {
                        sendFrame = frame
                        sendFrameSource = "UIView"
                    }
                    for child in view.subviews { visit(child, depth: depth + 1) }
                } else if let element = object as? UIAccessibilityElement {
                    let identifier = element.accessibilityIdentifier ?? ""
                    let frame = window.convert(element.accessibilityFrame, from: nil)
                    nodes.append(.init(
                        identifier: identifier,
                        elementType: String(describing: type(of: element)),
                        isAccessibilityElement: element.isAccessibilityElement,
                        hasLabel: !(element.accessibilityLabel ?? "").isEmpty,
                        frame: frame
                    ))
                    if identifier == "assistant.chat.send", !element.accessibilityFrame.isEmpty {
                        sendFrame = frame
                        sendFrameSource = "UIAccessibilityElement"
                    }
                } else if let generic = object as? NSObject,
                          let identified = generic as? UIAccessibilityIdentification,
                          let identifier = identified.accessibilityIdentifier, !identifier.isEmpty {
                    let frame = window.convert(generic.accessibilityFrame, from: nil)
                    nodes.append(.init(
                        identifier: identifier,
                        elementType: String(describing: type(of: generic)),
                        isAccessibilityElement: generic.isAccessibilityElement,
                        hasLabel: !(generic.accessibilityLabel ?? "").isEmpty,
                        frame: frame
                    ))
                    if identifier == "assistant.chat.send", !generic.accessibilityFrame.isEmpty {
                        sendFrame = frame
                        sendFrameSource = "identified-NSObject"
                    }
                }

                // SwiftUI may vend virtual elements from an NSObject container
                // rather than expose them as UIView descendants. Visit both
                // public container elements and UIKit subviews, with the object
                // identity set above preventing cycles and duplicate traversal.
                if let container = object as? NSObject {
                    let count = container.accessibilityElementCount()
                    if count != NSNotFound {
                        if count > childBudget { elementCountTruncated = true }
                        for index in 0..<min(max(count, 0), childBudget) {
                            if let child = container.accessibilityElement(at: index) as AnyObject? {
                                visit(child, depth: depth + 1)
                            } else {
                                missingDeclaredChildCount += 1
                            }
                        }
                    } else {
                        unknownCountContainerCount += 1
                    }
                    let elements = container.accessibilityElements ?? []
                    if elements.count > childBudget { arrayCountTruncated = true }
                    for child in elements.prefix(childBudget) {
                        visit(child as AnyObject, depth: depth + 1)
                    }
                    let automationElements = container.automationElements ?? []
                    if automationElements.count > childBudget { arrayCountTruncated = true }
                    for child in automationElements.prefix(childBudget) {
                        visit(child as AnyObject, depth: depth + 1)
                    }
                }
            }

            visit(root, depth: 0)
            nodeArrayTruncated = nodes.count > childBudget
            return AccessibilityReceipt(
                sendFrame: sendFrame, sendFrameSource: sendFrameSource, nodes: nodes,
                visitedObjectCount: visited.count, depthTruncated: depthTruncated,
                objectBudgetTruncated: objectBudgetTruncated,
                elementCountTruncated: elementCountTruncated,
                arrayCountTruncated: arrayCountTruncated,
                nodeArrayTruncated: nodeArrayTruncated,
                missingDeclaredChildCount: missingDeclaredChildCount,
                unknownCountContainerCount: unknownCountContainerCount
            )
        }

        // Wait briefly for SwiftUI to publish the nonempty-draft accessibility
        // tree. The bounded capture below is attached even when lookup fails.
        var accessibility = accessibilityReceipt(in: window)
        let sendDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while accessibility.sendFrame == nil && ContinuousClock.now < sendDeadline {
            try await Task.sleep(for: .milliseconds(100))
            window.layoutIfNeeded()
            accessibility = accessibilityReceipt(in: window)
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
        let accessibilityState: [String: Any] = [
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
            "messageCountUnchanged": model.messages.count == initialMessageCount,
            "isSending": model.isSending,
            "accessibilityReceipt": [
                "publicEnumerationComplete": accessibility.publicEnumerationComplete,
                "sendFrameSource": accessibility.sendFrameSource ?? "",
                "visitedObjectCount": accessibility.visitedObjectCount,
                "objectBudget": 10_000,
                "childBudget": 2_000,
                "depthTruncated": accessibility.depthTruncated,
                "objectBudgetTruncated": accessibility.objectBudgetTruncated,
                "elementCountTruncated": accessibility.elementCountTruncated,
                "arrayCountTruncated": accessibility.arrayCountTruncated,
                "nodeArrayTruncated": accessibility.nodeArrayTruncated,
                "missingDeclaredChildCount": accessibility.missingDeclaredChildCount,
                "unknownCountContainerCount": accessibility.unknownCountContainerCount
            ],
            "accessibilityNodes": accessibility.nodes.prefix(2_000).map { node in
                ["identifier": node.identifier, "elementType": node.elementType,
                 "isAccessibilityElement": node.isAccessibilityElement, "hasLabel": node.hasLabel,
                 "frame": rectReceipt(node.frame)] as [String: Any]
            }
        ]
        if let data = try? JSONSerialization.data(withJSONObject: accessibilityState,
                                                   options: [.sortedKeys, .prettyPrinted]) {
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = "chat-send-control-accessibility-state"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        let accessibilityImage = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let accessibilityScreenshot = XCTAttachment(image: accessibilityImage)
        accessibilityScreenshot.name = "chat-send-control-accessibility-screenshot"
        accessibilityScreenshot.lifetime = .keepAlways
        add(accessibilityScreenshot)

        guard let sendFrame = accessibility.sendFrame else {
            XCTFail("The bounded public UIKit enumeration did not expose assistant.chat.send; diagnostics: complete=\(accessibility.publicEnumerationComplete), visited=\(accessibility.visitedObjectCount), depthTruncated=\(accessibility.depthTruncated), objectBudgetTruncated=\(accessibility.objectBudgetTruncated), elementCountTruncated=\(accessibility.elementCountTruncated), arrayCountTruncated=\(accessibility.arrayCountTruncated), nodeArrayTruncated=\(accessibility.nodeArrayTruncated), missingDeclaredChildCount=\(accessibility.missingDeclaredChildCount), unknownCountContainerCount=\(accessibility.unknownCountContainerCount)")
            return
        }
        XCTAssertFalse(input.isDescendant(of: transcript),
            "The native text view must be a sibling of the transcript")
        assertHitReceiverIsOutsideTranscript(input)
        let sendReceiver = window.hitTest(
            CGPoint(x: sendFrame.midX, y: sendFrame.midY), with: nil
        )
        XCTAssertNotNil(sendReceiver, "The send control must receive its own hit test")
        if let sendReceiver {
            XCTAssertFalse(sendReceiver === transcript || sendReceiver.isDescendant(of: transcript),
                "Send touches must not enter the transcript pan-recognizer subtree")
        }
        for focused in [false, true, false] {
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
                let bottomError = abs(transcript.contentOffset.y + transcript.bounds.height
                    - transcript.contentSize.height - transcript.adjustedContentInset.bottom)
                let settled = bottomError <= 2
                    && viewportFrame.intersects(inputFrame)
                    && inputFrame.maxY <= window.bounds.maxY && input.isFirstResponder == focused
                settledSamples = settled ? settledSamples + 1 : 0
            } while settledSamples < 3 && ContinuousClock.now < deadline
            window.layoutIfNeeded()
            let inputFrame = input.convert(input.bounds, to: window)
            let viewportFrame = transcript.convert(transcript.bounds, to: window)
            let actualLastRowFrame = try XCTUnwrap(
                accessibilityFrame(containing: "LATEST_LAYOUT_ROW_MARKER", in: window),
                "Measure the actual final transcript row, not contentSize's composer clearance"
            )
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
        func sampleLayout(_ phase: String) {
            let scroll = diagnosticScroll
            let superview = scroll?.superview
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
                "transcriptViewport": rectReceipt(state.transcriptViewport),
                "composerFrameInWindow": rectReceipt(state.composer),
                "latestRowFrameInWindow": rectReceipt(state.lastCard),
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
        let baseline = state.composer.minY - state.lastCard.maxY
        let cardBottom = state.lastCard.maxY
        func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
        let scroll = try XCTUnwrap(descendants(window).compactMap { $0 as? UIScrollView }.first)
        diagnosticScroll = scroll
        sampleLayout("baseline")
        XCTAssertEqual(baseline, 18, accuracy: 1)
        XCTAssertEqual(state.transcriptViewport.height, 852, accuracy: 1,
            "The composer overlays the viewport instead of reducing its height")
        XCTAssertGreaterThan(state.transcriptViewport.maxY, state.composer.minY)
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

            let transcriptViewport = state.transcriptViewport
            let latestCard = state.lastCard
            let notice = state.notice
            let offset = scroll.contentOffset
            sampleLayout("notice-\(Int(noticeHeight))-baseline")
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
            sampleLayout("notice-\(Int(noticeHeight))-jump-visible")
            XCTAssertEqual(state.transcriptViewport, transcriptViewport,
                "Showing Jump must not shorten the transcript viewport")
            XCTAssertEqual(state.lastCard, latestCard,
                "Showing Jump must not move the reader's current content")
            XCTAssertEqual(state.notice, notice,
                "Jump must not change the notice stack's measured clearance")
            XCTAssertEqual(scroll.contentOffset, offset,
                "Showing Jump must not change the transcript offset")

            state.showsJumpChrome = false
            try await Task.sleep(for: .milliseconds(120))
            window.layoutIfNeeded()
            sampleLayout("notice-\(Int(noticeHeight))-jump-hidden")
            XCTAssertEqual(state.transcriptViewport, transcriptViewport)
            XCTAssertEqual(state.lastCard, latestCard)
            XCTAssertEqual(scroll.contentOffset, offset)
        }
        state.noticeHeight = 0
        state.jumpRequest += 1
        try await Task.sleep(for: .milliseconds(180))
        window.layoutIfNeeded()
        sampleLayout("lift-release-baseline")
        XCTAssertEqual(state.composer.minY - state.lastCard.maxY, baseline, accuracy: 1)
        for distance: CGFloat in [1, 5, 10, 20, 34, 80, 200, 450, 200, 34, 10, 0, 20, 0, 10, 0] {
            state.reveal = distance
            try await Task.sleep(for: .milliseconds(100))
            window.layoutIfNeeded()
            sampleLayout("lift-\(Int(distance))")
            XCTAssertEqual(scroll.bounds.height, state.availableHeight, accuracy: 1,
                "The actual native viewport must remain fixed while crossing the window safe-area edge")
            XCTAssertEqual(
                state.composer.minY - state.lastCard.maxY, baseline, accuracy: 1,
                "The gap must survive a \(distance)pt live lift")
            XCTAssertEqual(state.transcriptViewport.height, 852, accuracy: 1,
                "Moving the shared surface must not resize the transcript viewport")
            XCTAssertEqual(state.lastCard.maxY, cardBottom - distance, accuracy: 1)
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
                sampleLayout("available-\(Int(height))-composer-\(Int(input))-lift-\(Int(distance))")
                XCTAssertEqual(state.composer.minY - state.lastCard.maxY, baseline, accuracy: 1)
                XCTAssertEqual(state.transcriptViewport.height, height, accuracy: 1,
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
        sampleLayout("reading-older-before-lift")
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
            sampleLayout("reading-older-lift-\(Int(distance))")
            XCTAssertEqual(scroll.contentOffset.y, readingOffset, accuracy: 1)
        }
        // Repeated requests share the same native bottom edge.
        for _ in 0..<3 {
            state.jumpRequest += 1
            try await Task.sleep(for: .milliseconds(150))
            XCTAssertEqual(state.composer.minY - state.lastCard.maxY, baseline, accuracy: 1)
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
