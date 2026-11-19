import Foundation
import Observation

@MainActor
@Observable
final class McpSignInOptionsCoordinator {
  private(set) var isChecking = false
  private(set) var result: McpSignInOptionsPresentation?
  @ObservationIgnored private var service: (any McpSignInOptionsService)?
  @ObservationIgnored private var connectionID: String?
  @ObservationIgnored private var isCurrent: () -> Bool = { false }
  @ObservationIgnored private var revision = 0

  func bind(
    service: (any McpSignInOptionsService)?, connectionID: String?, isCurrent: @escaping () -> Bool
  ) {
    revision += 1
    self.service = service
    self.connectionID = connectionID
    self.isCurrent = isCurrent
    isChecking = false
    result = nil
  }

  func check() async {
    guard !isChecking, let service, let connectionID, isCurrent() else { return }
    let version = revision
    isChecking = true
    result = nil
    defer { if revision == version { isChecking = false } }
    do {
      let value = try await service.mcpSignInOptions(id: connectionID)
      guard revision == version, isCurrent(), !Task.isCancelled else { return }
      result = value.connectionId == connectionID ? value.presentation : .unavailable
    } catch {
      guard revision == version, isCurrent(), !Task.isCancelled else { return }
      result = .unavailable
    }
  }

  func unbind() { bind(service: nil, connectionID: nil, isCurrent: { false }) }
}
