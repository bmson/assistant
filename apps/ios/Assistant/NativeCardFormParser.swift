import Foundation

struct NativeCardForm: Equatable, Identifiable {
    let descriptor: CardFormDescriptor
    let warningFactIds: [String]
    var id: String { descriptor.formId }
}

/// Bounded strict parser for the public `form` block. Unsupported or malformed
/// blocks remain normal generated-card fallback content; this parser never
/// interprets prose as controls.
enum NativeCardFormParser {
    private static let formKeys: Set<String> = ["type", "id", "title", "serverAction", "submitLabel", "warningFactIds", "fields"]
    private static let commonFieldKeys: Set<String> = ["id", "label", "required", "defaultFact", "sensitive", "type"]

    static func parseBlock(_ block: JSONValue, cardId: String, revisionId: String) -> NativeCardForm? {
        parse(block, cardId: cardId, revisionId: revisionId)
    }

    static func forms(in spec: [String: JSONValue], cardId: String, revisionId: String?) -> [NativeCardForm] {
        guard let revisionId, case let .array(rawBlocks)? = spec["blocks"], rawBlocks.count <= 12 else { return [] }
        let factValues: [String: (value: String, sensitive: Bool)] = {
            guard case let .array(rawFacts)? = spec["facts"] else { return [:] }
            return Dictionary(rawFacts.compactMap { rawFact -> (String, (String, Bool))? in
                guard case let .object(fact) = rawFact,
                      let id = fact["id"]?.string,
                      let value = fact["value"]?.string else { return nil }
                return (id, (value, fact["sensitive"]?.boolValue == true))
            }, uniquingKeysWith: { first, _ in first })
        }()
        let blocks = rawBlocks.flatMap { value -> [JSONValue] in
            guard case let .object(block) = value else { return [] }
            guard block["type"]?.string == "section" else { return [value] }
            guard case let .array(children)? = block["blocks"], children.count <= 6 else { return [] }
            return children
        }
        let formBlocks = blocks.filter { value in
            guard case let .object(object) = value else { return false }
            return object["type"]?.string == "form"
        }
        // One visible form keeps the owner action and draft scope unambiguous.
        guard formBlocks.count == 1, let form = formBlocks.first,
              let parsed = parse(form, cardId: cardId, revisionId: revisionId, facts: factValues) else { return [] }
        return [parsed]
    }

    private static func parse(
        _ raw: JSONValue,
        cardId: String,
        revisionId: String,
        facts: [String: (value: String, sensitive: Bool)] = [:]
    ) -> NativeCardForm? {
        guard case let .object(object) = raw, Set(object.keys).isSubset(of: formKeys),
              object["type"]?.string == "form",
              let id = object["id"]?.string,
              let title = object["title"]?.string,
              let action = object["serverAction"]?.string, action == CardFormAction.submitOwnerChatTurn.rawValue,
              let submitLabel = object["submitLabel"]?.string,
              case let .array(rawFields)? = object["fields"], (1...4).contains(rawFields.count) else { return nil }
        let warnings: [String]
        if let rawWarnings = object["warningFactIds"] {
            guard case let .array(values) = rawWarnings, values.count <= 4,
                  values.allSatisfy({ $0.string != nil }) else { return nil }
            warnings = values.compactMap(\.string)
            guard warnings.allSatisfy(validId), Set(warnings).count == warnings.count,
                  warnings.allSatisfy({ facts[$0] != nil && facts[$0]?.sensitive == false }) else { return nil }
        } else {
            warnings = []
        }
        var fields: [CardFormField] = []
        for rawField in rawFields {
            guard case let .object(field) = rawField,
                  let typeRaw = field["type"]?.string,
                  let type = CardFormFieldKind(rawValue: typeRaw),
                  let fieldId = field["id"]?.string,
                  let label = field["label"]?.string else { return nil }
            let allowed = commonFieldKeys.union(type == .choice ? ["options"] : [])
            guard Set(field.keys).isSubset(of: allowed),
                  (field["required"] == nil || bool(field["required"]) != nil),
                  (field["sensitive"] == nil || bool(field["sensitive"]) != nil),
                  (field["defaultFact"] == nil || field["defaultFact"]?.string != nil) else { return nil }
            let options: [CardFormChoiceOption]?
            if type == .choice {
                guard case let .array(rawOptions)? = field["options"], (2...6).contains(rawOptions.count) else { return nil }
                var parsed: [CardFormChoiceOption] = []
                for rawOption in rawOptions {
                    guard case let .object(option) = rawOption,
                          Set(option.keys) == ["id", "label"],
                          let optionId = option["id"]?.string,
                          let optionLabel = option["label"]?.string else { return nil }
                    parsed.append(.init(id: optionId, label: optionLabel))
                }
                guard Set(parsed.map(\.id)).count == parsed.count else { return nil }
                options = parsed
            } else {
                guard field["options"] == nil else { return nil }
                options = nil
            }
            let defaultFact = field["defaultFact"]?.string
            var defaultValue: CardFormValue?
            if let defaultFact {
                guard validId(defaultFact), let fact = facts[defaultFact], !fact.sensitive else { return nil }
                let trimmed = fact.value.trimmingCharacters(in: .whitespacesAndNewlines)
                switch type {
                case .text:
                    if !trimmed.isEmpty, trimmed.utf16.count <= 500 { defaultValue = .text(trimmed) }
                case .choice:
                    if options?.contains(where: { $0.id == trimmed }) == true { defaultValue = .choice(trimmed) }
                case .date:
                    if isCalendarDate(trimmed) { defaultValue = .date(trimmed) }
                case .boolean:
                    // Require an explicit owner choice for every boolean.
                    defaultValue = nil
                }
            }
            fields.append(.init(
                id: fieldId,
                type: type,
                label: label,
                required: bool(field["required"]) ?? false,
                sensitive: bool(field["sensitive"]) ?? false,
                defaultFact: defaultFact,
                options: options,
                defaultValue: defaultValue
            ))
        }
        guard Set(fields.map(\.id)).count == fields.count else { return nil }
        let descriptor = CardFormDescriptor(
            cardId: cardId,
            cardRevisionId: revisionId,
            formId: id,
            title: title,
            submitLabel: submitLabel,
            serverAction: .submitOwnerChatTurn,
            fields: fields
        )
        guard (try? descriptor.validate()) != nil else { return nil }
        return NativeCardForm(descriptor: descriptor, warningFactIds: warnings)
    }

    private static func isCalendarDate(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard bytes.count == 10, bytes[4] == 45, bytes[7] == 45,
              bytes.enumerated().allSatisfy({ index, byte in index == 4 || index == 7 || (48...57).contains(byte) }),
              let year = Int(String(decoding: bytes[0..<4], as: UTF8.self)),
              let month = Int(String(decoding: bytes[5..<7], as: UTF8.self)),
              let day = Int(String(decoding: bytes[8..<10], as: UTF8.self)),
              (1...9_999).contains(year) else { return false }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        guard let date = calendar.date(from: components) else { return false }
        let normalized = calendar.dateComponents([.year, .month, .day], from: date)
        return normalized.year == year && normalized.month == month && normalized.day == day
    }

    private static func validId(_ value: String) -> Bool {
        guard (1...40).contains(value.utf8.count),
              !["__proto__", "prototype", "constructor"].contains(value) else { return false }
        return value.utf8.allSatisfy {
            (48...57).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
        }
    }

    private static func bool(_ value: JSONValue?) -> Bool? {
        guard case let .bool(result)? = value else { return nil }
        return result
    }
}
