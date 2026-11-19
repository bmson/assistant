import SwiftUI

struct McpSignInOptionsSection: View {
  let isChecking: Bool
  let isDisabled: Bool
  let result: McpSignInOptionsPresentation?
  let check: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Check public sign-in setup without signing in or changing saved credentials.")
        .font(.caption).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      Button(action: check) {
        HStack(spacing: 8) {
          if isChecking { ProgressView().controlSize(.small) }
          Text(isChecking ? "Checking sign-in options…" : "Check sign-in options")
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .buttonStyle(
        AssistantActionButtonStyle(kind: .secondary, fillsWidth: true, minimumHeight: 44)
      )
      .disabled(isChecking || isDisabled)
      if let result {
        VStack(alignment: .leading, spacing: 6) {
          Text(result.title).font(.subheadline.weight(.semibold))
          ForEach(Array(result.authorizationHosts.enumerated()), id: \.offset) { _, host in
            Text("Sign-in server reported by this service: \(host)")
              .font(.caption).textSelection(.enabled)
          }
          Text(result.detail).font(.caption).foregroundStyle(.secondary)
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

@MainActor
struct McpSignInOptionsControl: View {
  let connection: McpConnection
  let disabled: Bool
  @Environment(AppModel.self) private var model
  @State private var coordinator = McpSignInOptionsCoordinator()
  @State private var isVisible = false
  @State private var boundIdentity: Identity?

  private struct Identity: Hashable {
    let connection: McpSignInOptionsIdentity
    let ownerVersion: Int
  }

  private var identity: Identity {
    .init(
      connection: McpSignInOptionsIdentity(connection),
      ownerVersion: model.activityConnectionVersion)
  }

  var body: some View {
    McpSignInOptionsSection(
      isChecking: coordinator.isChecking,
      isDisabled: disabled || !connection.enabled,
      result: connection.enabled ? (boundIdentity == identity ? coordinator.result : nil) : .paused
    ) {
      Task { await coordinator.check() }
    }
    .task(id: identity) {
      boundIdentity = identity
      isVisible = true
      let context = model.mcpSignInOptionsRequestContext(for: connection)
      coordinator.bind(service: context?.client, connectionID: context?.identity.id) {
        guard let context else { return false }
        return isVisible && model.mcpSignInOptionsConnectionIsCurrent(context)
      }
    }
    .onDisappear {
      isVisible = false
      boundIdentity = nil
      coordinator.unbind()
    }
  }
}
