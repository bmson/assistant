import CryptoKit
import Darwin
import Foundation

enum NativeMemoryCorrectionRecoveryError: Error, Equatable {
    case invalidRecord
    case invalidServerIdentity
    case corruptRecord
    case unsupportedVersion
    case recordTooLarge
    case operationConflict
    case operationNotFound
}

/// Recovery-only file surface. The install operation must never replace an existing operation file.
protocol NativeMemoryCorrectionRecoveryFileAccess: CardFormDraftFileAccess {
    /// Atomically installs data only when the destination does not exist. Returns false on collision.
    func installAtomicallyIfAbsent(_ data: Data, to url: URL) throws -> Bool
}

/// Uses the existing protected-file adapter for reads/removal, with a recovery-specific
/// `renamex_np(RENAME_EXCL)` install so independently-created stores cannot overwrite each other.
struct ProtectedNativeMemoryCorrectionRecoveryFileAccess: NativeMemoryCorrectionRecoveryFileAccess {
    private let protectedFiles = ProtectedCardFormDraftFileAccess()

    func exists(_ url: URL) -> Bool { protectedFiles.exists(url) }
    func read(_ url: URL, maximumBytes: Int) throws -> Data { try protectedFiles.read(url, maximumBytes: maximumBytes) }
    func writeAtomically(_ data: Data, to url: URL) throws { try protectedFiles.writeAtomically(data, to: url) }
    func removeFile(_ url: URL) throws { try protectedFiles.removeFile(url) }
    func removePartition(_ url: URL) throws { try protectedFiles.removePartition(url) }

    func installAtomicallyIfAbsent(_ data: Data, to url: URL) throws -> Bool {
        let manager = FileManager.default
        let directory = url.deletingLastPathComponent()
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        #if os(iOS)
        try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: directory.path)
        #endif
        var directoryValues = URLResourceValues()
        directoryValues.isExcludedFromBackup = true
        var protectedDirectory = directory
        try protectedDirectory.setResourceValues(directoryValues)

        let temporary = directory.appendingPathComponent(".\(UUID().uuidString).nmcr.tmp")
        #if os(iOS)
        let attributes: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.complete]
        #else
        let attributes: [FileAttributeKey: Any] = [:]
        #endif
        guard manager.createFile(atPath: temporary.path, contents: nil, attributes: attributes) else {
            throw EncryptedCardFormDraftStorageError.writeFailed
        }

        var openHandle: FileHandle?
        do {
            let handle = try FileHandle(forWritingTo: temporary)
            openHandle = handle
            try handle.write(contentsOf: data)
            try handle.synchronize()
            try handle.close()
            openHandle = nil
            #if os(iOS)
            try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: temporary.path)
            #endif
            let result = temporary.path.withCString { source in
                url.path.withCString { destination in Darwin.renamex_np(source, destination, UInt32(RENAME_EXCL)) }
            }
            if result == 0 { return true }
            let failure = errno
            if failure == EEXIST {
                try? manager.removeItem(at: temporary)
                return false
            }
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(failure))
        } catch {
            try? openHandle?.close()
            try? manager.removeItem(at: temporary)
            throw error
        }
    }
}

/// Exact server-issued operation material needed to resume status checks after reauthentication.
/// This value is recovery material, not a mobile bearer credential; the store does not issue or validate authority.
struct NativeMemoryCorrectionRecoveryRecord: Codable, Equatable, Sendable {
    struct Target: Codable, Equatable, Sendable {
        let ownerID: String
        let serverID: String
        let memoryID: String
        let sourceIdentity: String?
    }

    struct Snapshot: Codable, Equatable, Sendable {
        let revision: String
        let storedContentHash: String?
        let content: String
        let sourceLabel: String
        let ownerCorrected: Bool
        let readOnlyReason: String?
    }

    struct Operation: Codable, Equatable, Sendable {
        let operationID: String
        let expectedRevision: String
        let expectedStoredContentHash: String?
    }

    /// Preserve the full API base identity, including a deployment path prefix.
    let serverIdentity: String
    let target: Target
    let operation: Operation
    let snapshot: Snapshot
    let draft: String
    /// Opaque, purpose-bound server authorization handle. Never put the mobile bearer here.
    let authorizationHandle: String

    init(
        serverIdentity: String,
        target: Target,
        operation: Operation,
        snapshot: Snapshot,
        draft: String,
        authorizationHandle: String
    ) {
        self.serverIdentity = serverIdentity
        self.target = target
        self.operation = operation
        self.snapshot = snapshot
        self.draft = draft
        self.authorizationHandle = authorizationHandle
    }
}

/// Durable storage for an already-authorized operation. Call and await `saveBeforeDispatch`
/// before sending the operation. Records are immutable per operation ID; uncertainty retains them.
/// Exclusive installation coordinates writers sharing this filesystem root. The default root is
/// the app's private Application Support container; this store does not promise shared-group access.
actor NativeMemoryCorrectionRecoveryStore {
    static let maximumRecordBytes = 48 * 1024
    private static let magic = Data([0x4e, 0x4d, 0x43, 0x52, 0x01]) // NMCR, envelope v1

    private let root: URL
    private let keyVault: any CardFormDraftKeyVault
    private let files: any NativeMemoryCorrectionRecoveryFileAccess
    private let encoder: JSONEncoder
    private let decoder = JSONDecoder()

    init(
        applicationSupportRoot: URL? = nil,
        keyVault: any CardFormDraftKeyVault = KeychainCardFormDraftKeyVault(),
        files: any NativeMemoryCorrectionRecoveryFileAccess = ProtectedNativeMemoryCorrectionRecoveryFileAccess()
    ) throws {
        let support = try applicationSupportRoot ?? Self.defaultApplicationSupportRoot()
        root = support.appendingPathComponent("NativeMemoryCorrectionRecovery", isDirectory: true)
        self.keyVault = keyVault
        self.files = files
        encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
    }

    func saveBeforeDispatch(_ record: NativeMemoryCorrectionRecoveryRecord) throws {
        try Self.validate(record)
        let partition = Self.partition(record)
        try keyVault.assertOpen(partition: partition)
        let url = recordURL(record)
        let plaintext = try encoder.encode(record)
        guard plaintext.count <= Self.maximumRecordBytes else { throw NativeMemoryCorrectionRecoveryError.recordTooLarge }

        if files.exists(url) {
            let existing = try loadFile(at: url, record: record, partition: partition)
            guard existing == record else { throw NativeMemoryCorrectionRecoveryError.operationConflict }
            return
        }

        let key = try keyVault.key(for: partition, createIfMissing: true)
        guard let sealed = try AES.GCM.seal(
            plaintext,
            using: key,
            authenticating: Self.associatedData(record, partition: partition)
        ).combined else { throw NativeMemoryCorrectionRecoveryError.corruptRecord }
        let installed = try files.installAtomicallyIfAbsent(Self.magic + sealed, to: url)
        if !installed {
            // A different store actor may have installed this operation after our initial read.
            // Authenticate the winner and accept only an exact idempotent save.
            let existing = try loadFile(at: url, record: record, partition: partition)
            guard existing == record else { throw NativeMemoryCorrectionRecoveryError.operationConflict }
        }
    }

    func load(
        serverIdentity: String,
        target: NativeMemoryCorrectionRecoveryRecord.Target,
        operationID: String
    ) throws -> NativeMemoryCorrectionRecoveryRecord? {
        let identity = try Self.identity(serverIdentity: serverIdentity, target: target, operationID: operationID)
        try keyVault.assertOpen(partition: identity)
        let url = operationURL(partition: identity, operationID: operationID)
        guard files.exists(url) else { return nil }
        return try loadFile(at: url, serverIdentity: serverIdentity, target: target,
                            operationID: operationID, partition: identity)
    }

    /// Removal is an explicit caller action after a qualified operation-bound disposition.
    /// This method does not infer terminality from HTTP, queue acceptance, or readback alone.
    func remove(
        serverIdentity: String,
        target: NativeMemoryCorrectionRecoveryRecord.Target,
        operationID: String,
        disposition: NativeMemoryCorrectionRecoveryTerminalDisposition
    ) throws {
        _ = disposition // A required, explicit acknowledgement from the qualified adapter.
        let identity = try Self.identity(serverIdentity: serverIdentity, target: target, operationID: operationID)
        try keyVault.assertOpen(partition: identity)
        let url = operationURL(partition: identity, operationID: operationID)
        guard files.exists(url) else { throw NativeMemoryCorrectionRecoveryError.operationNotFound }
        // Authenticate and compare the exact tuple before deleting; corrupt or foreign bytes stay in place.
        _ = try loadFile(at: url, serverIdentity: serverIdentity, target: target,
                         operationID: operationID, partition: identity)
        try files.removeFile(url)
    }

    private func loadFile(
        at url: URL,
        record: NativeMemoryCorrectionRecoveryRecord,
        partition: String
    ) throws -> NativeMemoryCorrectionRecoveryRecord {
        try loadFile(at: url, serverIdentity: record.serverIdentity, target: record.target,
                     operationID: record.operation.operationID, partition: partition)
    }

    private func loadFile(
        at url: URL,
        serverIdentity: String,
        target: NativeMemoryCorrectionRecoveryRecord.Target,
        operationID: String,
        partition: String
    ) throws -> NativeMemoryCorrectionRecoveryRecord {
        let data = try files.read(url, maximumBytes: Self.maximumRecordBytes + 128)
        guard data.count >= Self.magic.count,
              data.prefix(Self.magic.count) == Self.magic else {
            if data.first == 0x4e { throw NativeMemoryCorrectionRecoveryError.unsupportedVersion }
            throw NativeMemoryCorrectionRecoveryError.corruptRecord
        }
        let key = try keyVault.key(for: partition, createIfMissing: false)
        let box: AES.GCM.SealedBox
        do {
            box = try AES.GCM.SealedBox(combined: Data(data.dropFirst(Self.magic.count)))
            let plaintext = try AES.GCM.open(
                box,
                using: key,
                authenticating: Self.associatedData(serverIdentity: serverIdentity, target: target,
                                                    operationID: operationID, partition: partition)
            )
            guard plaintext.count <= Self.maximumRecordBytes else { throw NativeMemoryCorrectionRecoveryError.recordTooLarge }
            let decoded: NativeMemoryCorrectionRecoveryRecord
            do { decoded = try decoder.decode(NativeMemoryCorrectionRecoveryRecord.self, from: plaintext) }
            catch { throw NativeMemoryCorrectionRecoveryError.corruptRecord }
            guard decoded.serverIdentity == serverIdentity, decoded.target == target,
                  decoded.operation.operationID == operationID else {
                throw NativeMemoryCorrectionRecoveryError.corruptRecord
            }
            try Self.validate(decoded)
            return decoded
        } catch let error as NativeMemoryCorrectionRecoveryError {
            throw error
        } catch {
            throw NativeMemoryCorrectionRecoveryError.corruptRecord
        }
    }

    private func recordURL(_ record: NativeMemoryCorrectionRecoveryRecord) -> URL {
        let partition = Self.partition(record)
        return operationURL(partition: partition, operationID: record.operation.operationID)
    }

    private func operationURL(partition: String, operationID: String) -> URL {
        let filename = Self.digest(Self.tuple(["native-memory-correction-operation-v1", operationID])) + ".nmcr"
        return root.appendingPathComponent(partition, isDirectory: true).appendingPathComponent(filename)
    }

    private static func identity(
        serverIdentity: String,
        target: NativeMemoryCorrectionRecoveryRecord.Target,
        operationID: String
    ) throws -> String {
        guard validServerIdentity(serverIdentity), validTarget(target), validIdentifier(operationID, max: 256) else {
            throw NativeMemoryCorrectionRecoveryError.invalidRecord
        }
        let partition = digest(tuple(["native-memory-correction-partition-v1", serverIdentity,
                                      target.ownerID, target.serverID, target.memoryID,
                                      target.sourceIdentity ?? ""]))
        return (partition)
    }

    private static func validate(_ record: NativeMemoryCorrectionRecoveryRecord) throws {
        guard validServerIdentity(record.serverIdentity), validTarget(record.target),
              validIdentifier(record.operation.operationID, max: 256),
              validIdentifier(record.operation.expectedRevision, max: 256),
              record.operation.expectedStoredContentHash.map({ validIdentifier($0, max: 256) }) ?? true,
              record.snapshot.revision == record.operation.expectedRevision,
              record.snapshot.storedContentHash == record.operation.expectedStoredContentHash,
              record.snapshot.content.utf8.count <= 16_000, record.snapshot.sourceLabel.utf8.count <= 1_000,
              record.draft.utf8.count <= 16_000,
              record.authorizationHandle.utf8.count <= 8_192,
              record.authorizationHandle.hasPrefix("omc1."),
              record.authorizationHandle.split(separator: ".").count == 3,
              record.authorizationHandle.split(separator: ".").dropFirst().allSatisfy({
                  !$0.isEmpty && $0.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
              }) else {
            throw NativeMemoryCorrectionRecoveryError.invalidRecord
        }
    }

    private static func validTarget(_ target: NativeMemoryCorrectionRecoveryRecord.Target) -> Bool {
        validIdentifier(target.ownerID, max: 512) && validIdentifier(target.serverID, max: 2_048)
            && validIdentifier(target.memoryID, max: 256)
            && (target.sourceIdentity.map { validIdentifier($0, max: 512) } ?? true)
    }

    private static func validIdentifier(_ value: String, max: Int) -> Bool {
        !value.isEmpty && value.utf8.count <= max
    }

    private static func validServerIdentity(_ value: String) -> Bool {
        guard value.utf8.count <= 2_048, let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(), ["https", "http"].contains(scheme),
              components.host != nil, components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil else { return false }
        return true
    }

    private static func partition(_ record: NativeMemoryCorrectionRecoveryRecord) -> String {
        digest(tuple(["native-memory-correction-partition-v1", record.serverIdentity,
                      record.target.ownerID, record.target.serverID, record.target.memoryID,
                      record.target.sourceIdentity ?? ""]))
    }

    private static func associatedData(
        _ record: NativeMemoryCorrectionRecoveryRecord,
        partition: String
    ) -> Data {
        associatedData(serverIdentity: record.serverIdentity, target: record.target,
                       operationID: record.operation.operationID, partition: partition)
    }

    private static func associatedData(
        serverIdentity: String,
        target: NativeMemoryCorrectionRecoveryRecord.Target,
        operationID: String,
        partition: String
    ) -> Data {
        tuple(["native-memory-correction-recovery-v1", partition, serverIdentity, target.ownerID,
               target.serverID, target.memoryID, target.sourceIdentity ?? "", operationID])
    }

    private static func tuple(_ values: [String]) -> Data {
        var data = Data()
        for value in values {
            let bytes = Data(value.utf8)
            var length = UInt64(bytes.count).bigEndian
            withUnsafeBytes(of: &length) { data.append(contentsOf: $0) }
            data.append(bytes)
        }
        return data
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func defaultApplicationSupportRoot() throws -> URL {
        guard let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw CocoaError(.fileNoSuchFile)
        }
        return root
    }
}

/// Marker values can only be supplied explicitly after the adapter has qualified disposition
/// against the original operation. Pending readback is intentionally not a removal case.
enum NativeMemoryCorrectionRecoveryTerminalDisposition: Sendable {
    case savedWithOperationBoundReadback
    case unchangedWithOperationBoundReadback
    case rejectedNoWrite
    case staleNoWrite
}
