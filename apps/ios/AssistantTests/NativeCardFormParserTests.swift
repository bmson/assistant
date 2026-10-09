import XCTest
@testable import Assistant

final class NativeCardFormParserTests: XCTestCase {
    private let cardId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private let revisionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

    func testParsesBoundedPublicFieldsAndWarningsByStableID() throws {
        let form = block([
            "type": .string("form"),
            "id": .string("trip_plan"),
            "title": .string("Plan a trip"),
            "serverAction": .string("submit_owner_chat_turn"),
            "submitLabel": .string("Review in message"),
            "warningFactIds": .array([.string("budget_note")]),
            "fields": .array([
                field(id: "destination", type: "text", label: "Destination", required: true),
                field(id: "travel_day", type: "date", label: "Travel day", required: false),
                field(id: "style", type: "choice", label: "Travel style", required: true,
                      options: [.object(["id": .string("rail"), "label": .string("Train")]),
                                .object(["id": .string("flight"), "label": .string("Flight")])]),
                field(id: "flexible", type: "boolean", label: "Dates are flexible", required: false)
            ])
        ])
        let spec: [String: JSONValue] = [
            "blocks": .array([form]),
            "facts": .array([fact(id: "budget_note", value: "Within the saved budget")]),
        ]
        let parsed = try XCTUnwrap(NativeCardFormParser.forms(in: spec, cardId: cardId, revisionId: revisionId).first)
        XCTAssertEqual(parsed.descriptor.formId, "trip_plan")
        XCTAssertEqual(parsed.descriptor.cardRevisionId, revisionId)
        XCTAssertEqual(parsed.descriptor.fields.map(\.id), ["destination", "travel_day", "style", "flexible"])
        XCTAssertEqual(parsed.warningFactIds, ["budget_note"])
    }

    func testResolvedDefaultsAndWarningsUseOnlyPublicSameCardFacts() throws {
        let spec: [String: JSONValue] = [
            "blocks": .array([.object([
                "type": .string("form"), "id": .string("trip_plan"), "title": .string("Trip"),
                "serverAction": .string("submit_owner_chat_turn"), "submitLabel": .string("Review"),
                "warningFactIds": .array([.string("budget")]),
                "fields": .array([
                    field(id: "destination", type: "text", label: "Destination", required: true, defaultFact: "place"),
                    field(id: "travel_day", type: "date", label: "Travel day", required: true, defaultFact: "day"),
                    field(id: "style", type: "choice", label: "Style", required: true, defaultFact: "style_fact",
                          options: [.object(["id": .string("rail"), "label": .string("Train")]),
                                    .object(["id": .string("flight"), "label": .string("Flight")])]),
                    field(id: "remind", type: "boolean", label: "Remind me", required: true, defaultFact: "bool_fact"),
                ])
            ])]),
            "facts": .array([
                fact(id: "place", value: "Copenhagen"),
                fact(id: "day", value: "2028-02-29"),
                fact(id: "style_fact", value: "rail"),
                fact(id: "bool_fact", value: "false"),
                fact(id: "budget", value: "Within the saved budget"),
            ]),
        ]
        let form = try XCTUnwrap(NativeCardFormParser.forms(in: spec, cardId: cardId, revisionId: revisionId).first)
        XCTAssertEqual(form.warningFactIds, ["budget"])
        XCTAssertEqual(form.descriptor.fields[0].defaultValue, .text("Copenhagen"))
        XCTAssertEqual(form.descriptor.fields[1].defaultValue, .date("2028-02-29"))
        XCTAssertEqual(form.descriptor.fields[2].defaultValue, .choice("rail"))
        XCTAssertNil(form.descriptor.fields[3].defaultValue, "Booleans still require an explicit Yes or No")

        var secretSpec = spec
        if case var .array(facts)? = secretSpec["facts"], case var .object(secret) = facts[0] {
            secret["sensitive"] = .bool(true)
            facts[0] = .object(secret)
            secretSpec["facts"] = .array(facts)
        }
        XCTAssertTrue(NativeCardFormParser.forms(in: secretSpec, cardId: cardId, revisionId: revisionId).isEmpty)
    }

    func testOnlyOneValidatedNativeFormCompletesTheGeneratedComposition() throws {
        let formBlock = JSONValue.object(validForm())
        let note: JSONValue = .object(["type": .string("note"), "factId": .string("event")])
        let fact: JSONValue = .object([
            "id": .string("event"), "value": .string("Review"),
            "label": .string("Event"), "source": .string("Fixture source"),
        ])
        var spec: [String: JSONValue] = [
            "version": .number(1), "title": .string("Trip plan"),
            "sourceLabel": .string("Fixture source"), "accessibilityLabel": .string("Trip plan"),
            "facts": .array([fact]), "blocks": .array([formBlock, note]),
        ]
        let parsed = NativeCardFormParser.forms(in: spec, cardId: cardId, revisionId: revisionId).first
        XCTAssertNotNil(parsed)
        XCTAssertFalse(NativeGeneratedCardCatalog.supportsComplete(spec: spec), "A parsed form stays prose-backed until its renderer is negotiated")
        XCTAssertTrue(
            NativeGeneratedCardCatalog.supportsComplete(spec: spec, validatedNativeForm: parsed),
            "A single parser-validated form may replace prose when the renderer is ready"
        )

        spec["blocks"] = .array([.object([
            "type": .string("section"), "title": .string("Request"), "blocks": .array([formBlock, note]),
        ])])
        let nested = NativeCardFormParser.forms(in: spec, cardId: cardId, revisionId: revisionId).first
        XCTAssertNotNil(nested)
        XCTAssertTrue(NativeGeneratedCardCatalog.supportsComplete(spec: spec, validatedNativeForm: nested))

        spec["blocks"] = .array([formBlock, formBlock])
        let duplicate = NativeCardFormParser.forms(in: spec, cardId: cardId, revisionId: revisionId).first
        XCTAssertNil(duplicate, "Multiple forms cannot be silently treated as one complete composition")
        XCTAssertFalse(NativeGeneratedCardCatalog.supportsComplete(spec: spec, validatedNativeForm: duplicate))

        spec["blocks"] = .array([formBlock, .string("malformed sibling")])
        let withMalformedSibling = NativeCardFormParser.forms(in: spec, cardId: cardId, revisionId: revisionId).first
        XCTAssertNotNil(withMalformedSibling)
        XCTAssertFalse(NativeGeneratedCardCatalog.supportsComplete(spec: spec, validatedNativeForm: withMalformedSibling))
    }

    func testRejectsUnknownKeysSensitiveFieldsDuplicateIDsAndUnboundedFieldCounts() {
        var unknown = validForm()
        unknown["tool"] = .string("calendar.create_event")
        XCTAssertNil(parse(unknown))

        var sensitive = validForm()
        if case var .array(fields)? = sensitive["fields"], case var .object(first) = fields[0] {
            first["sensitive"] = .bool(true)
            fields[0] = .object(first)
            sensitive["fields"] = .array(fields)
        }
        XCTAssertNil(parse(sensitive))

        var duplicate = validForm()
        duplicate["fields"] = .array([
            field(id: "same", type: "text", label: "One", required: false),
            field(id: "same", type: "boolean", label: "Two", required: false)
        ])
        XCTAssertNil(parse(duplicate))

        var tooMany = validForm()
        tooMany["fields"] = .array((0..<5).map { field(id: "field_\($0)", type: "text", label: "Field", required: false) })
        XCTAssertNil(parse(tooMany))
    }

    private func parse(_ object: [String: JSONValue]) -> NativeCardForm? {
        NativeCardFormParser.parseBlock(.object(object), cardId: cardId, revisionId: revisionId)
    }

    private func validForm() -> [String: JSONValue] {
        [
            "type": .string("form"), "id": .string("trip_plan"), "title": .string("Trip"),
            "serverAction": .string("submit_owner_chat_turn"), "submitLabel": .string("Continue"),
            "fields": .array([field(id: "destination", type: "text", label: "Destination", required: true)])
        ]
    }

    private func block(_ form: [String: JSONValue]) -> JSONValue { .object(form) }

    private func fact(id: String, value: String) -> JSONValue {
        .object(["id": .string(id), "label": .string(id), "value": .string(value)])
    }

    private func field(
        id: String,
        type: String,
        label: String,
        required: Bool,
        defaultFact: String? = nil,
        options: [JSONValue]? = nil
    ) -> JSONValue {
        var value: [String: JSONValue] = [
            "id": .string(id), "type": .string(type), "label": .string(label), "required": .bool(required)
        ]
        if let defaultFact { value["defaultFact"] = .string(defaultFact) }
        if let options { value["options"] = .array(options) }
        return .object(value)
    }
}
