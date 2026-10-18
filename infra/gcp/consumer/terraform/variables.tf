variable "project_id" {
  description = "Customer-owned Google Cloud project that owns this installation."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be an explicit valid Google Cloud project ID."
  }
}

variable "region" {
  description = "Customer-selected compute and Artifact Registry region."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]+[0-9]$", var.region))
    error_message = "region must be an explicit Google Cloud region such as us-central1."
  }
}

variable "installation_id" {
  description = "Stable installation identifier used in labels and service identity names."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,19}[a-z0-9]$", var.installation_id))
    error_message = "installation_id must be 4-21 lowercase letters, digits, or hyphens so the runtime service account name stays valid."
  }
}

variable "firestore_database_id" {
  description = "Explicit Firestore Native database ID. Creating (default) requires a separate opt-in after verifying that the customer project has no existing default database."
  type        = string

  validation {
    condition = (
      var.firestore_database_id == "(default)" || (
        can(regex("^[a-z][a-z0-9-]{2,61}[a-z0-9]$", var.firestore_database_id)) &&
        !can(regex("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$", var.firestore_database_id))
      )
    )
    error_message = "firestore_database_id must be (default) or a named 4-63 character ID that is not UUID-like."
  }
}

variable "daily_backup_schedule_enabled" {
  description = "Explicitly create a daily managed Firestore backup schedule. Backup storage is billable; see the consumer Terraform README before enabling."
  type        = bool
  default     = false
}

variable "backup_retention_days" {
  description = "Retention period in days for the optional daily managed Firestore backup schedule."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 98 && floor(var.backup_retention_days) == var.backup_retention_days
    error_message = "backup_retention_days must be a whole number from 1 through 98 (Firestore's 14-week maximum)."
  }
}

variable "create_default_database" {
  description = "Explicit creation intent for (default) in a fresh customer project. The installer must verify absence first; this never imports or adopts an existing database."
  type        = bool
  default     = false
}

variable "firestore_location_id" {
  description = "Firestore database location. Choose an available location compatible with the selected region."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.firestore_location_id))
    error_message = "firestore_location_id must be an explicit Firestore location."
  }
}

variable "assets_bucket_name" {
  description = "Globally unique customer-owned bucket for assistant assets and recovery objects."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$", var.assets_bucket_name))
    error_message = "assets_bucket_name must be a valid globally unique GCS bucket name."
  }
}

variable "source_bucket_name" {
  description = "Globally unique customer-owned bucket for immutable source archives."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$", var.source_bucket_name))
    error_message = "source_bucket_name must be a valid globally unique GCS bucket name."
  }
}

variable "artifact_repository_id" {
  description = "Customer-owned Artifact Registry Docker repository ID."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,62}[a-z0-9]$", var.artifact_repository_id))
    error_message = "artifact_repository_id must be a valid Artifact Registry repository ID."
  }
}

# The runtime profile is deliberately opt-in. Both digests must be supplied;
# tags and image URLs cannot silently select a mutable or publisher-owned image.
variable "web_image_digest" {
  description = "Immutable sha256 digest of the customer-owned Artifact Registry web image; null leaves the foundation unchanged."
  type        = string
  default     = null

  validation {
    condition     = var.web_image_digest == null || can(regex("^sha256:[0-9a-f]{64}$", var.web_image_digest))
    error_message = "web_image_digest must be a lowercase sha256:<64 hex> digest."
  }
}

variable "agent_image_digest" {
  description = "Immutable sha256 digest of the customer-owned Artifact Registry agent image; null leaves the foundation unchanged."
  type        = string
  default     = null

  validation {
    condition     = var.agent_image_digest == null || can(regex("^sha256:[0-9a-f]{64}$", var.agent_image_digest))
    error_message = "agent_image_digest must be a lowercase sha256:<64 hex> digest."
  }
}

variable "release_sha" {
  description = "Verified full source commit SHA embedded in both runtime services; required only when enabling runtime."
  type        = string
  default     = null

  validation {
    condition     = var.release_sha == null || can(regex("^[0-9a-f]{40}$", var.release_sha))
    error_message = "release_sha must be a lowercase full commit SHA."
  }
}

variable "firestore_agent_id" {
  description = "ID of an already seeded owner agent document. Required only for the Firestore runtime."
  type        = string
  default     = null

  validation {
    condition     = var.firestore_agent_id == null || can(regex("^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$", var.firestore_agent_id))
    error_message = "firestore_agent_id must be a UUID."
  }
}

variable "firestore_embedding_space" {
  description = "Explicit provenance of imported/seeded Firestore embeddings, not an inferred model default."
  type = object({
    provider   = string
    model      = string
    dimensions = number
    revision   = string
  })
  default = null

  validation {
    condition = var.firestore_embedding_space == null || (
      length(trimspace(var.firestore_embedding_space.provider)) > 0 &&
      length(trimspace(var.firestore_embedding_space.model)) > 0 &&
      var.firestore_embedding_space.dimensions == 1536 &&
      length(trimspace(var.firestore_embedding_space.revision)) > 0
    )
    error_message = "firestore_embedding_space needs nonempty provider/model/revision and 1536 dimensions."
  }
}

variable "vertex_location" {
  description = "Explicit model serving location; defaults to the Cloud Run region for regional models."
  type        = string
  default     = null

  validation {
    condition     = var.vertex_location == null || can(regex("^(global|[a-z][a-z0-9-]*[0-9])$", var.vertex_location))
    error_message = "vertex_location must be global or an explicit Google region."
  }
}

variable "owner_email" {
  description = "Verified Google account allowed to sign in to the web application. Required for the runtime."
  type        = string
  default     = null

  validation {
    condition     = var.owner_email == null || can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.owner_email))
    error_message = "owner_email must be an email address."
  }
}

variable "web_auth_url" {
  description = "Exact HTTPS origin owners use. Required for Google OAuth; in passkey mode null selects the deterministic Cloud Run URL https://<installation>-web-<project number>.<region>.run.app."
  type        = string
  default     = null

  validation {
    condition     = var.web_auth_url == null || can(regex("^https://[A-Za-z0-9.-]+(?::443)?$", var.web_auth_url))
    error_message = "web_auth_url must be an HTTPS origin without a path or query."
  }
}

# These are version numbers of three *existing*, customer-populated Secret
# Manager secrets. Terraform never receives their values or creates versions.
variable "auth_secret_version" {
  description = "Numbered version of <installation_id>-auth-secret in the customer project."
  type        = number
  default     = null

  validation {
    condition     = var.auth_secret_version == null || (var.auth_secret_version >= 1 && floor(var.auth_secret_version) == var.auth_secret_version)
    error_message = "auth_secret_version must be a positive integer version, not latest."
  }
}

variable "google_client_id_version" {
  description = "Numbered version of <installation_id>-google-client-id in the customer project."
  type        = number
  default     = null

  validation {
    condition     = var.google_client_id_version == null || (var.google_client_id_version >= 1 && floor(var.google_client_id_version) == var.google_client_id_version)
    error_message = "google_client_id_version must be a positive integer version, not latest."
  }
}

variable "google_client_secret_version" {
  description = "Numbered version of <installation_id>-google-client-secret in the customer project."
  type        = number
  default     = null

  validation {
    condition     = var.google_client_secret_version == null || (var.google_client_secret_version >= 1 && floor(var.google_client_secret_version) == var.google_client_secret_version)
    error_message = "google_client_secret_version must be a positive integer version, not latest."
  }
}

variable "mobile_api_token_version" {
  description = "Optional numbered version of <installation_id>-mobile-api-token in the customer project. Never the token value."
  type        = number
  default     = null

  validation {
    condition     = var.mobile_api_token_version == null || (var.mobile_api_token_version >= 1 && floor(var.mobile_api_token_version) == var.mobile_api_token_version)
    error_message = "mobile_api_token_version must be a positive integer version, not latest."
  }
}

variable "allow_public_web_invoker" {
  description = "Explicitly grant allUsers Cloud Run invocation to web only, after owner sign-in (Google OAuth or passkey claim) is configured. Default is private."
  type        = bool
  default     = false
}

variable "owner_auth_mode" {
  description = "Owner sign-in: google (customer Google OAuth client) or passkey (WebAuthn passkeys in Firestore; no OAuth client)."
  type        = string
  default     = "google"

  validation {
    condition     = contains(["google", "passkey"], var.owner_auth_mode)
    error_message = "owner_auth_mode must be google or passkey."
  }
}

variable "task_dispatch" {
  description = "Agent work dispatch: poller (one always-on agent instance) or cloud-tasks (scale-to-zero agent, Cloud Tasks queue, and Cloud Scheduler sweep). cloud-tasks requires an agent release whose Firestore mode accepts QUEUE_DRIVER=cloudtasks."
  type        = string
  default     = "poller"

  validation {
    condition     = contains(["poller", "cloud-tasks"], var.task_dispatch)
    error_message = "task_dispatch must be poller or cloud-tasks."
  }
}

variable "sweep_schedule" {
  description = "Cron schedule for the Cloud Scheduler due-work sweep when task_dispatch is cloud-tasks."
  type        = string
  default     = "* * * * *"

  validation {
    condition     = length(split(" ", trimspace(var.sweep_schedule))) == 5
    error_message = "sweep_schedule must be a five-field cron expression."
  }
}
