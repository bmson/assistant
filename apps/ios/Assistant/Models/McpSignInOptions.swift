import Foundation

/// Presentation of a transient metadata check, separate from connection readiness.
enum McpSignInOptionsPresentation: Equatable {
  case supported(authorizationServers: [String])
  case unsupported
  case unavailable
  case paused

  var title: String {
    switch self {
    case .supported: "Sign-in setup found"
    case .unsupported: "No supported sign-in setup found"
    case .unavailable: "Couldn’t check sign-in options"
    case .paused: "Connection is paused"
    }
  }

  var detail: String {
    switch self {
    case .supported:
      "This service reports browser sign-in options. Checking setup doesn’t sign you in."
    case .unsupported:
      "Assistant couldn’t validate a supported sign-in setup for this connection. Manual setup is still available."
    case .unavailable:
      "Your saved connection and authentication haven’t changed. You can try checking again."
    case .paused:
      "Enable this connection before checking sign-in options. Saved authentication hasn’t changed."
    }
  }

  var authorizationHosts: [String] {
    guard case .supported(let servers) = self else { return [] }
    return servers.compactMap { server in
      guard let parts = URLComponents(string: server), parts.scheme == "https",
        parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil
      else { return nil }
      return parts.host
    }
  }

}

struct McpSignInOptionsResponse: Decodable, Equatable, Sendable {
  struct AuthorizationServer: Decodable, Equatable, Sendable {
    struct Registration: Decodable, Equatable, Sendable {
      let preRegistration: String
      let clientIdMetadataDocument: Bool
      let dynamicClientRegistration: Bool
    }
    let issuer: String
    let pkceS256: Bool
    let authorizationResponseIssuerRequired: Bool
    let registration: Registration
  }
  let connectionId: String
  let status: String
  let authenticated: Bool
  let oauthConnectionSupported: Bool
  let transportProtocolVersion: String
  let resource: String?
  let authorizationServers: [AuthorizationServer]
  let reason: String?

  var presentation: McpSignInOptionsPresentation {
    guard !authenticated, !oauthConnectionSupported, transportProtocolVersion == "2025-11-25",
      authorizationServers.count <= 3
    else { return .unavailable }
    if reason == "connection_disabled" { return .paused }
    switch status {
    case "supported":
      guard !authorizationServers.isEmpty else { return .unavailable }
      return .supported(authorizationServers: authorizationServers.map(\.issuer))
    case "unsupported": return .unsupported
    default: return .unavailable
    }
  }
}

protocol McpSignInOptionsService: Sendable {
  func mcpSignInOptions(id: String) async throws -> McpSignInOptionsResponse
}

struct McpSignInOptionsIdentity: Hashable, Sendable {
  let id: String
  let endpoint: String
  let enabled: Bool
  let hasBearerToken: Bool
  let status: String
  let lastCheckedAt: String?

  init(_ connection: McpConnection) {
    id = connection.id
    endpoint = connection.endpoint
    enabled = connection.enabled
    hasBearerToken = connection.hasBearerToken
    status = connection.status
    lastCheckedAt = connection.lastCheckedAt
  }
}

struct McpSignInOptionsRequestContext {
  let ownerID: String
  let version: Int
  let identity: McpSignInOptionsIdentity
  let client: APIClient
}
