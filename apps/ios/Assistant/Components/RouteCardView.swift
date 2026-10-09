import MapKit
import SwiftUI

/// A route from the maps tool: both ends, the line to draw, time, distance,
/// and the Apple Maps link. Parsed from the `route` card payload.
struct RouteInfo: Hashable {
    struct Place: Hashable {
        let label: String
        let address: String
        let latitude: Double
        let longitude: Double
        let current: Bool
        var coordinate: CLLocationCoordinate2D { .init(latitude: latitude, longitude: longitude) }
    }

    let id: String
    let mode: String
    let origin: Place
    let destination: Place
    let durationSeconds: Double
    let distanceMeters: Double
    let departAt: Date?
    let arriveAt: Date?
    let routeName: String
    let hasTolls: Bool
    let steps: [String]
    let line: [Place]
    let mapsURL: URL?

    init?(data: [String: JSONValue]) {
        func number(_ value: JSONValue?) -> Double? {
            if case let .number(number)? = value, number.isFinite { return number }
            return nil
        }
        func place(_ value: JSONValue?) -> Place? {
            guard case let .object(raw)? = value, let lat = number(raw["lat"]), let lng = number(raw["lng"]),
                  let label = raw["label"]?.string, !label.isEmpty else { return nil }
            return Place(label: label, address: raw["address"]?.string ?? "", latitude: lat, longitude: lng,
                         current: raw["current"] == .bool(true))
        }
        guard let id = data["id"]?.string,
              let origin = place(data["origin"]), let destination = place(data["destination"]),
              let duration = number(data["durationSeconds"]), let distance = number(data["distanceMeters"]) else {
            return nil
        }
        self.id = id
        self.mode = data["mode"]?.string ?? "driving"
        self.origin = origin
        self.destination = destination
        self.durationSeconds = duration
        self.distanceMeters = distance
        self.departAt = (data["departAt"]?.string).flatMap(ISO8601DateFormatter.flexible)
        self.arriveAt = (data["arriveAt"]?.string).flatMap(ISO8601DateFormatter.flexible)
        self.routeName = data["routeName"]?.string ?? ""
        self.hasTolls = data["hasTolls"] == .bool(true)
        self.steps = {
            guard case let .array(values)? = data["steps"] else { return [] }
            return values.compactMap { value in
                guard case let .object(step) = value else { return nil }
                return step["instruction"]?.string
            }
        }()
        let decoded = Self.decodePolyline(data["polyline"]?.string ?? "")
        self.line = decoded.count >= 2
            ? decoded.map { Place(label: "", address: "", latitude: $0.0, longitude: $0.1, current: false) }
            : [origin, destination]
        let link = data["mapsUrl"]?.string ?? ""
        self.mapsURL = link.hasPrefix("https://maps.apple.com/") ? URL(string: link) : nil
    }

    /// Google's encoded polyline, 5-digit precision (the server's format).
    static func decodePolyline(_ encoded: String) -> [(Double, Double)] {
        let bytes = Array(encoded.utf8)
        var index = 0
        var lat = 0
        var lng = 0
        var points: [(Double, Double)] = []
        func next() -> Int? {
            var result = 0
            var shift = 0
            while index < bytes.count {
                let byte = Int(bytes[index]) - 63
                index += 1
                result |= (byte & 0x1f) << shift
                shift += 5
                if byte < 0x20 { return (result & 1) != 0 ? ~(result >> 1) : result >> 1 }
            }
            return nil
        }
        while index < bytes.count, let dLat = next(), let dLng = next() {
            lat += dLat
            lng += dLng
            points.append((Double(lat) / 1e5, Double(lng) / 1e5))
        }
        return points
    }

    /// The map region that fits the whole route with a margin.
    var region: MKCoordinateRegion {
        let lats = line.map(\.latitude)
        let lngs = line.map(\.longitude)
        let minLat = lats.min() ?? origin.latitude, maxLat = lats.max() ?? origin.latitude
        let minLng = lngs.min() ?? origin.longitude, maxLng = lngs.max() ?? origin.longitude
        return MKCoordinateRegion(
            center: .init(latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2),
            span: .init(latitudeDelta: max((maxLat - minLat) * 1.5, 0.01),
                        longitudeDelta: max((maxLng - minLng) * 1.5, 0.01))
        )
    }
}

/// The route on a native Apple map, with how long, how far, and when to
/// leave; tapping the map or the button opens the trip in Apple Maps.
struct RouteCardView: View {
    let route: RouteInfo

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Map(initialPosition: .region(route.region), interactionModes: []) {
                MapPolyline(coordinates: route.line.map(\.coordinate))
                    .stroke(AssistantTheme.accent(for: colorScheme), style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
                Marker(route.origin.current ? "You" : route.origin.label, systemImage: "location.fill",
                       coordinate: route.origin.coordinate)
                    .tint(AssistantTheme.accent(for: colorScheme))
                Marker(route.destination.label, coordinate: route.destination.coordinate)
                    .tint(.orange)
            }
            .mapStyle(.standard(pointsOfInterest: .excludingAll))
            .frame(height: 190)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(Rectangle())
            .onTapGesture { if let url = route.mapsURL { openURL(url) } }
            .accessibilityLabel("Map of the route to \(route.destination.label)")
            .accessibilityAddTraits(.isButton)

            let duration = Text(Self.duration(route.durationSeconds))
                .font(.title2.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
            let routeDetails = Text([Self.distance(route.distanceMeters), route.routeName.isEmpty ? "" : "via \(route.routeName)"]
                .filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.subheadline)
                .monospacedDigit()
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            let stackedSummary = VStack(alignment: .leading, spacing: 8) {
                duration.fixedSize(horizontal: false, vertical: true)
                routeDetails.fixedSize(horizontal: false, vertical: true)
            }
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    stackedSummary
                } else {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline) {
                            duration.fixedSize(horizontal: true, vertical: false)
                            Spacer(minLength: 8)
                            routeDetails
                                .lineLimit(1)
                                .fixedSize(horizontal: true, vertical: false)
                        }
                        stackedSummary
                    }
                }
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(route.destination.label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                if !route.destination.address.isEmpty {
                    Text(route.destination.address)
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .lineLimit(2)
                }
                Text(summaryLine)
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !route.steps.isEmpty {
                DisclosureGroup("\(route.steps.count) step\(route.steps.count == 1 ? "" : "s")") {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(route.steps.enumerated()), id: \.offset) { index, step in
                            Text("\(index + 1). \(step)")
                                .font(.subheadline)
                                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.top, 6)
                }
                .font(.caption.weight(.medium))
                .tint(AssistantTheme.inkMuted(for: colorScheme))
            }

            if let url = route.mapsURL {
                Link(destination: url) {
                    Label("Open in Apple Maps", systemImage: "arrow.triangle.turn.up.right.diamond.fill")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .frame(minHeight: 44)
                        .background(AssistantTheme.accent(for: colorScheme), in: Capsule())
                        .foregroundStyle(.white)
                }
            }
        }
    }

    private var summaryLine: String {
        let mode = ["driving": "By car", "walking": "On foot", "cycling": "By bike"][route.mode] ?? "By car"
        let from = route.origin.current ? "from where you are" : "from \(route.origin.label)"
        var parts = ["\(mode) \(from)"]
        if let leave = route.departAt, let arrive = route.arriveAt {
            parts.append("leave \(leave.formatted(date: .omitted, time: .shortened)), arrive \(arrive.formatted(date: .omitted, time: .shortened))")
        }
        if route.hasTolls { parts.append("tolls") }
        return parts.joined(separator: " · ")
    }

    static func duration(_ seconds: Double) -> String {
        let minutes = max(1, Int((seconds / 60).rounded()))
        if minutes < 60 { return "\(minutes) min" }
        let rest = minutes % 60
        return rest == 0 ? "\(minutes / 60) hr" : "\(minutes / 60) hr \(rest) min"
    }

    /// Miles or kilometers by the device's measurement system.
    static func distance(_ meters: Double, locale: Locale = .autoupdatingCurrent) -> String {
        let measurement = Measurement(value: meters, unit: UnitLength.meters)
        let unit: UnitLength = locale.measurementSystem == .us
            ? (meters < 320 ? .feet : .miles)
            : (meters < 1000 ? .meters : .kilometers)
        let converted = measurement.converted(to: unit)
        return converted.formatted(.measurement(width: .abbreviated, usage: .asProvided,
                                                numberFormatStyle: .number.precision(.fractionLength(unit == .miles || unit == .kilometers ? 1 : 0))
                                                    .rounded(rule: .toNearestOrAwayFromZero))
                                    .locale(locale))
    }
}
