import Foundation
import Security

enum KeychainStore {
    private static let service = "com.baldvinsmarason.assistant.mobile"
    private static let account = "mobile-api-token"
    private static let clientIDAccount = "native-client-id"

    static func readOrCreateClientID() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: clientIDAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
           let data = result as? Data,
           let value = String(data: data, encoding: .utf8),
           UUID(uuidString: value) != nil {
            return value.lowercased()
        }
        let value = UUID().uuidString.lowercased()
        let attributes: [String: Any] = query.merging([
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]) { _, new in new }
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecSuccess { return value }
        if status == errSecDuplicateItem {
            var existing: CFTypeRef?
            if SecItemCopyMatching(query as CFDictionary, &existing) == errSecSuccess,
               let data = existing as? Data,
               let saved = String(data: data, encoding: .utf8),
               UUID(uuidString: saved) != nil {
                return saved.lowercased()
            }
        }
        return nil
    }

    static func readToken() -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }

    static func saveToken(_ token: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
        guard !token.isEmpty else { return }
        let attributes: [String: Any] = query.merging([
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]) { _, new in new }
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }
}
