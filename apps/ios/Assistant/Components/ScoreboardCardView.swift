import SwiftUI

/// A game as the scores tool reports it; parsed from both the card payload
/// and the live endpoint, which return the same shape.
struct ScoreGame: Hashable, Identifiable {
    struct Side: Hashable {
        let name: String
        let shortName: String
        let abbreviation: String
        let logo: URL?
        let score: String?
        let winner: Bool?
        let record: String?
    }

    let id: String
    let league: String
    let state: String
    let statusText: String
    let startsAt: Date?
    let venue: String
    let broadcast: String
    let link: URL?
    let home: Side
    let away: Side

    var key: String { "\(league):\(id)" }
    var isLive: Bool { state == "in" }
    var isFinal: Bool { state == "post" }

    init?(_ value: JSONValue) {
        guard case let .object(game) = value,
              let id = game["id"]?.string, !id.isEmpty,
              let home = Self.side(game["home"]), let away = Self.side(game["away"]) else { return nil }
        func text(_ key: String) -> String { game[key]?.string ?? "" }
        self.id = id
        self.league = text("league")
        self.state = ["in", "post"].contains(text("state")) ? text("state") : "pre"
        self.statusText = text("statusText")
        self.startsAt = ISO8601DateFormatter.flexible(text("startsAt"))
        self.venue = text("venue")
        self.broadcast = text("broadcast")
        let link = text("link")
        self.link = link.hasPrefix("https://www.espn.com/") ? URL(string: link) : nil
        self.home = home
        self.away = away
    }

    private static func side(_ value: JSONValue?) -> Side? {
        guard case let .object(team)? = value, let name = team["name"]?.string, !name.isEmpty else { return nil }
        let logo = team["logo"]?.string ?? ""
        let winner: Bool? = {
            if case let .bool(flag)? = team["winner"] { return flag }
            return nil
        }()
        return Side(
            name: name,
            shortName: team["shortName"]?.string ?? name,
            abbreviation: team["abbreviation"]?.string ?? "",
            // Logos load straight from the provider's image CDN, and only from it.
            logo: approvedLogoURL(logo),
            score: team["score"]?.string,
            winner: winner,
            record: team["record"]?.string
        )
    }

    static func approvedLogoURL(_ raw: String) -> URL? {
        guard let components = URLComponents(string: raw),
              components.scheme?.lowercased() == "https",
              components.user == nil, components.password == nil,
              components.port == nil,
              let host = components.host?.lowercased(), !host.hasSuffix("."),
              host == "espncdn.com" || host.hasSuffix(".espncdn.com"),
              let url = components.url else { return nil }
        return url
    }

    /// Whether this game can still change: it is on, or starts within 10 minutes.
    func canChange(at now: Date) -> Bool {
        if isLive { return true }
        guard state == "pre", let startsAt else { return false }
        return startsAt.timeIntervalSince(now) <= 600 && now.timeIntervalSince(startsAt) < 4 * 3600
    }
}

extension ISO8601DateFormatter {
    /// Server stamps carry milliseconds ("…:10.123Z"); the scores provider
    /// writes minutes only ("2026-09-22T01:45Z"). Either parses.
    static func flexible(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let full = ISO8601DateFormatter()
        if let date = full.date(from: value) { return date }
        return full.date(from: value.replacingOccurrences(of: "Z", with: ":00Z"))
    }
}

/// Reads a scoreboard's games again from the live endpoint. Injected at the
/// root so a card deep in the transcript needs no plumbing to reach it.
typealias LiveScoreboardFetch = @MainActor (String) async -> LiveScoresPayload?

private struct LiveScoreboardFetchKey: EnvironmentKey {
    static let defaultValue: LiveScoreboardFetch? = nil
}

extension EnvironmentValues {
    var liveScoreboard: LiveScoreboardFetch? {
        get { self[LiveScoreboardFetchKey.self] }
        set { self[LiveScoreboardFetchKey.self] = newValue }
    }
}

/// `mlb:401,402;nfl:77` for the games that can still change.
func liveScoreQuery(_ games: [ScoreGame], now: Date = .now) -> String {
    var order: [String] = []
    var byLeague: [String: [String]] = [:]
    for game in games where !game.isFinal && !game.league.isEmpty {
        if byLeague[game.league] == nil { order.append(game.league) }
        byLeague[game.league, default: []].append(game.id)
    }
    return order.map { "\($0):\(byLeague[$0, default: []].joined(separator: ","))" }.joined(separator: ";")
}

/// Games from the scores tool, re-read while one is on. Polling runs only
/// while the app is active and the card is on screen, and stops for good once
/// every game is final — a transcript of old scoreboards costs nothing.
struct ScoreboardCardView: View {
    let title: String
    let initialGames: [ScoreGame]
    let fetchedAt: Date?
    let pollSeconds: Int
    let live: Bool

    @State private var games: [ScoreGame] = []
    @State private var updatedAt: Date?
    @State private var onScreen = false
    @State private var clockNow = Date.now

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.liveScoreboard) private var fetchLive

    private var shown: [ScoreGame] { games.isEmpty ? initialGames : games }
    private var polling: Bool {
        live && fetchLive != nil && onScreen && scenePhase == .active
            && shown.contains { $0.canChange(at: clockNow) }
    }
    private var clockActive: Bool {
        live && fetchLive != nil && onScreen && scenePhase == .active
            && shown.contains { $0.state == "pre" && $0.startsAt.map { $0 > clockNow } == true }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "sportscourt.fill")
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                Spacer(minLength: 8)
                if let stamp = updatedAt ?? fetchedAt {
                    Text(polling ? "Live · \(stamp.formatted(date: .omitted, time: .shortened))"
                                 : "Updated \(stamp.formatted(date: .omitted, time: .shortened))")
                        .font(.caption.weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .lineLimit(1)
                }
            }
            ForEach(Array(shown.enumerated()), id: \.element.key) { index, game in
                if index > 0 {
                    Divider().overlay(AssistantTheme.inkMuted(for: colorScheme).opacity(0.16))
                }
                gameView(game)
            }
        }
        .onScrollVisibilityChange(threshold: 0.2) { onScreen = $0 }
        .onAppear { onScreen = true }
        .onDisappear { onScreen = false }
        // A future game can be outside the polling window when this card first
        // appears. Wall-clock time alone does not invalidate SwiftUI state, so
        // wake while the visible card has a future kickoff and let `polling`
        // turn on as soon as the game enters its ten-minute window.
        .task(id: clockActive) {
            guard clockActive else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard !Task.isCancelled else { return }
                clockNow = .now
            }
        }
        .task(id: polling) {
            guard polling else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(max(pollSeconds, 15)))
                guard !Task.isCancelled, polling, let fetchLive else { return }
                let query = liveScoreQuery(shown)
                guard !query.isEmpty, let payload = await fetchLive(query) else { continue }
                let fresh = Dictionary(
                    payload.games.compactMap(ScoreGame.init).map { ($0.key, $0) },
                    uniquingKeysWith: { _, last in last }
                )
                games = shown.map { fresh[$0.key] ?? $0 }
                updatedAt = payload.fetchedAt.flatMap(ISO8601DateFormatter.flexible) ?? .now
            }
        }
    }

    private func gameView(_ game: ScoreGame) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                if game.isLive {
                    HStack(spacing: 4) {
                        Circle().frame(width: 6, height: 6)
                        Text("LIVE").font(.caption2.weight(.heavy)).tracking(0.4)
                    }
                    .foregroundStyle(.red)
                }
                Text(game.statusText)
                    .font(.caption.weight(game.isLive ? .semibold : .medium))
                    .monospacedDigit()
                    .foregroundStyle(game.isLive ? AssistantTheme.ink(for: colorScheme) : AssistantTheme.inkMuted(for: colorScheme))
                    .lineLimit(1)
                Spacer(minLength: 6)
                if let link = game.link {
                    Link(destination: link) {
                        Image(systemName: "arrow.up.right.square")
                            .font(.subheadline)
                            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                    }
                    .accessibilityLabel("Game details")
                }
            }
            teamRow(game.away, game: game)
            teamRow(game.home, game: game)
            let footer = [game.venue, game.broadcast].filter { !$0.isEmpty }.joined(separator: " · ")
            if !footer.isEmpty {
                Text(footer)
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilitySummary(game))
    }

    private func teamRow(_ team: ScoreGame.Side, game: ScoreGame) -> some View {
        let lost = game.isFinal && team.winner == false
        return HStack(spacing: 10) {
            AsyncImage(url: team.logo) { image in
                image.resizable().scaledToFit()
            } placeholder: {
                Text(String(team.abbreviation.prefix(3)))
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(AssistantTheme.sunken(for: colorScheme), in: Circle())
            }
            .frame(width: 26, height: 26)
            .accessibilityHidden(true)
            Text(team.shortName)
                .font(.body.weight(lost ? .regular : .semibold))
                .foregroundStyle(lost ? AssistantTheme.inkMuted(for: colorScheme) : AssistantTheme.ink(for: colorScheme))
                .lineLimit(1)
            if let record = team.record, !record.isEmpty {
                Text(record)
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if game.state != "pre", let score = team.score {
                Text(score)
                    .font(.title3.weight(lost ? .regular : .bold))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                    .foregroundStyle(lost ? AssistantTheme.inkMuted(for: colorScheme) : AssistantTheme.ink(for: colorScheme))
            }
        }
    }

    private func accessibilitySummary(_ game: ScoreGame) -> String {
        let scores = game.state == "pre" ? "" : " \(game.away.score ?? "") to \(game.home.score ?? "")"
        return "\(game.away.name) at \(game.home.name)\(scores), \(game.statusText)"
    }
}
