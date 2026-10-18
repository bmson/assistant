# This profile is separate from the verified foundation archive used by the
# installer. Nothing below exists until both immutable image digests are given.
locals {
  runtime_requested = var.web_image_digest != null || var.agent_image_digest != null || var.allow_public_web_invoker
  runtime_enabled   = var.web_image_digest != null && var.agent_image_digest != null
  runtime_instances = local.runtime_enabled ? { current = true } : {}
  runtime_labels = merge(local.installation_labels, {
    profile = "consumer-runtime"
  })

  passkey_auth = var.owner_auth_mode == "passkey"
  cloud_tasks  = var.task_dispatch == "cloud-tasks"
  # Cloud Run's deterministic URLs are known before the services exist, which
  # lets the passkey origin and the agent's own OIDC audience be configured in
  # one apply. They stay stable for the life of the service name and project.
  project_number = try(data.google_project.runtime["current"].number, null)
  deterministic_web_url = local.project_number == null ? null : (
    "https://${var.installation_id}-web-${local.project_number}.${var.region}.run.app"
  )
  deterministic_agent_url = local.project_number == null ? null : (
    "https://${var.installation_id}-agent-${local.project_number}.${var.region}.run.app"
  )
  web_auth_url = var.web_auth_url != null ? var.web_auth_url : (
    local.passkey_auth ? local.deterministic_web_url : null
  )
  tasks_queue_name = "${var.installation_id}-agent-steps"
  internal_invoker = local.runtime_enabled && local.cloud_tasks ? { current = true } : {}

  runtime_common_env = {
    ASSISTANT_MODULES                 = "minimal"
    ASSISTANT_WORKSPACE_ID            = var.installation_id
    FIRESTORE_DATABASE_ID             = var.firestore_database_id
    FIRESTORE_AGENT_ID                = var.firestore_agent_id
    FIRESTORE_EMBEDDING_SPACE         = jsonencode(var.firestore_embedding_space)
    GCP_PROJECT                       = var.project_id
    GCP_LOCATION                      = var.region
    PERSISTENCE_DRIVER                = "firestore"
    ASSISTANT_RELEASE_SCHEMA_DRIVER   = "firestore"
    ASSISTANT_RELEASE_SCHEMA_MIN      = "1"
    ASSISTANT_RELEASE_SCHEMA_MAX      = "1"
    ASSISTANT_RELEASE_SCHEMA_VERSION  = "1"
    ASSISTANT_RELEASE_SHA             = var.release_sha
    MOBILE_API_TOKEN_SECRET_NAME      = ""
    MOBILE_API_TOKEN_ROTATION_ENABLED = "false"
    QUEUE_DRIVER                      = local.cloud_tasks ? "cloudtasks" : "local"
    LLM_PROVIDER                      = "vertex"
    VERTEX_PROJECT                    = var.project_id
    VERTEX_LOCATION                   = coalesce(var.vertex_location, var.region)
    CANARY_ENABLED                    = "false"
    AUTH_DEV_BYPASS                   = "false"
    AUTH_LOCALHOST_BYPASS             = "false"
  }

  # Both services enqueue with an OIDC identity that only the agent accepts.
  dispatch_env = local.cloud_tasks ? {
    CLOUD_TASKS_QUEUE             = local.tasks_queue_name
    INTERNAL_AUTH_MODE            = "oidc"
    INTERNAL_OIDC_SERVICE_ACCOUNT = "${var.installation_id}-invoker@${var.project_id}.iam.gserviceaccount.com"
    INTERNAL_OIDC_AUDIENCE        = local.deterministic_agent_url
  } : {}

  web_env = merge(local.runtime_common_env, local.dispatch_env, {
    ASSISTANT_RELEASE_API_CONTRACT  = "1"
    ASSISTANT_RELEASE_AGENT_API_MIN = "1"
    ASSISTANT_RELEASE_AGENT_API_MAX = "1"
    OWNER_EMAIL                     = var.owner_email
    OWNER_AUTH_MODE                 = var.owner_auth_mode
    AUTH_URL                        = local.web_auth_url
    AUTH_TRUST_HOST                 = "true"
  })

  agent_env = merge(local.runtime_common_env, local.dispatch_env, {
    ASSISTANT_RELEASE_API_CONTRACT = "1"
    ASSISTANT_RELEASE_WEB_API_MIN  = "1"
    ASSISTANT_RELEASE_WEB_API_MAX  = "1"
    FILES_DRIVER                   = "gcs"
    WORKSPACE_BUCKET               = google_storage_bucket.assets.name
    }, local.cloud_tasks ? {
    AGENT_URL  = local.deterministic_agent_url
    PUBLIC_URL = local.deterministic_agent_url
  } : {})

  # These exact secret names and numbered versions are supplied in the
  # customer project before runtime apply. No secret payload enters state.
  # Passkey installations need only the session-signing secret.
  web_auth_secrets = merge({
    AUTH_SECRET = {
      id      = "${var.installation_id}-auth-secret"
      version = var.auth_secret_version
    }
    }, local.passkey_auth ? {} : {
    AUTH_GOOGLE_ID = {
      id      = "${var.installation_id}-google-client-id"
      version = var.google_client_id_version
    }
    AUTH_GOOGLE_SECRET = {
      id      = "${var.installation_id}-google-client-secret"
      version = var.google_client_secret_version
    }
  })
  mobile_secret = var.mobile_api_token_version == null ? {} : {
    MOBILE_API_TOKEN = {
      id      = "${var.installation_id}-mobile-api-token"
      version = var.mobile_api_token_version
    }
  }
  web_secrets = merge(local.web_auth_secrets, local.mobile_secret)
}

data "google_project" "runtime" {
  for_each   = local.runtime_instances
  project_id = var.project_id
}

resource "terraform_data" "runtime_input_guard" {
  for_each = local.runtime_requested ? { current = true } : {}

  lifecycle {
    precondition {
      condition     = can(regex("^[0-9a-f]{40}$", var.release_sha))
      error_message = "Runtime requires the verified full source commit SHA of both images."
    }
    precondition {
      condition     = local.runtime_enabled
      error_message = "Provide both web_image_digest and agent_image_digest to opt in to the runtime."
    }
    precondition {
      condition     = var.firestore_agent_id != null && var.firestore_embedding_space != null
      error_message = "Runtime requires an explicit seeded Firestore agent ID and embedding provenance."
    }
    precondition {
      condition     = var.owner_email != null && local.web_auth_url != null
      error_message = "Runtime requires an owner email and the configured HTTPS Google OAuth origin."
    }
    precondition {
      condition = var.auth_secret_version != null && (local.passkey_auth || (
        var.google_client_id_version != null &&
        var.google_client_secret_version != null
      ))
      error_message = "Runtime requires numbered versions of the three existing owner-auth secrets (passkey mode needs only the auth secret)."
    }
    precondition {
      condition = !local.passkey_auth || (
        var.google_client_id_version == null && var.google_client_secret_version == null
      )
      error_message = "Passkey owner auth does not use a Google OAuth client; omit the Google client secret versions."
    }
    precondition {
      condition     = local.project_number == null || length("${var.installation_id}-agent-${local.project_number}") <= 63
      error_message = "The installation ID is too long for a deterministic Cloud Run URL."
    }
  }
}

resource "google_project_service" "runtime" {
  for_each = local.runtime_enabled ? toset(concat([
    "aiplatform.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    ], local.cloud_tasks ? [
    "cloudscheduler.googleapis.com",
    "cloudtasks.googleapis.com",
  ] : [])) : toset([])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false

  depends_on = [terraform_data.runtime_input_guard]
}

resource "google_service_account" "web" {
  for_each = local.runtime_instances

  project      = var.project_id
  account_id   = "${var.installation_id}-web"
  display_name = "${var.installation_id} Firestore web"
  description  = "Minimal customer-owned Firestore chat web identity."

  depends_on = [google_project_service.runtime]
}

resource "google_project_iam_member" "web_firestore" {
  for_each = local.runtime_instances

  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.web[each.key].email}"

  condition {
    title       = "assistant_web_installation_database"
    description = "Limit web chat datastore access to this installation database."
    expression  = "resource.name == \"projects/${var.project_id}/databases/${var.firestore_database_id}\""
  }
}

resource "google_project_iam_member" "agent_vertex" {
  for_each = local.runtime_instances

  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.runtime.email}"

  depends_on = [google_project_service.runtime]
}

# Web chat can classify and stream a direct reply before queuing an action, so
# it needs Vertex access as well as the background agent.
resource "google_project_iam_member" "web_vertex" {
  for_each = local.runtime_instances

  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.web[each.key].email}"

  depends_on = [google_project_service.runtime]
}

resource "google_secret_manager_secret_iam_member" "web_auth" {
  for_each = local.runtime_enabled ? local.web_secrets : {}

  project   = var.project_id
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web["current"].email}"

  depends_on = [google_project_service.runtime]
}

resource "google_cloud_run_v2_service" "agent" {
  for_each = local.runtime_instances

  project     = var.project_id
  location    = var.region
  name        = "${var.installation_id}-agent"
  description = local.cloud_tasks ? "Customer-owned Firestore agent invoked by Cloud Tasks and Cloud Scheduler." : "Customer-owned minimal Firestore agent and local task poller."
  # Cloud Run web traffic is not recognized as internal without VPC routing.
  # Keep IAM invocation mandatory; only the dedicated web identity is granted it.
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = false
  # Cloud Run IAM and the application independently verify the same signed
  # route-bound token in Authorization. Register only the two callback routes;
  # accepting the service URL at IAM does not make it valid for either route.
  custom_audiences = local.cloud_tasks ? [
    "${local.deterministic_agent_url}/internal/tasks/execute",
    "${local.deterministic_agent_url}/internal/sweep",
  ] : []
  deletion_protection = true
  labels              = local.runtime_labels

  # The local poller needs one always-CPU instance. Cloud Tasks dispatch lets
  # the agent scale to zero between callbacks.
  scaling {
    min_instance_count = local.cloud_tasks ? 0 : 1
    max_instance_count = local.cloud_tasks ? 3 : 1
  }

  template {
    service_account                  = google_service_account.runtime.email
    max_instance_request_concurrency = 4

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_repository_id}/agent@${var.agent_image_digest}"

      ports {
        container_port = 8080
      }

      resources {
        limits   = { cpu = "1", memory = "1Gi" }
        cpu_idle = local.cloud_tasks
      }

      dynamic "env" {
        for_each = local.agent_env
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [
    terraform_data.runtime_input_guard,
    google_project_iam_member.agent_vertex,
    google_project_iam_member.runtime_firestore,
    google_storage_bucket_iam_member.runtime_assets,
  ]
}

resource "google_cloud_run_v2_service" "web" {
  for_each = local.runtime_instances

  project              = var.project_id
  location             = var.region
  name                 = "${var.installation_id}-web"
  description          = "Customer-owned minimal Firestore chat web service."
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = false
  deletion_protection  = true
  labels               = local.runtime_labels

  scaling {
    min_instance_count = 0
    max_instance_count = 2
  }

  template {
    service_account                  = google_service_account.web[each.key].email
    max_instance_request_concurrency = 20

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_repository_id}/web@${var.web_image_digest}"

      ports {
        container_port = 8080
      }

      resources {
        limits   = { cpu = "1", memory = "1Gi" }
        cpu_idle = true
      }

      dynamic "env" {
        for_each = local.web_env
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name  = "AGENT_URL"
        value = google_cloud_run_v2_service.agent[each.key].uri
      }

      dynamic "env" {
        for_each = local.web_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = "projects/${var.project_id}/secrets/${env.value.id}"
              version = env.value.version == null ? "0" : tostring(env.value.version)
            }
          }
        }
      }
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [
    terraform_data.runtime_input_guard,
    google_project_iam_member.web_firestore,
    google_project_iam_member.web_vertex,
    google_secret_manager_secret_iam_member.web_auth,
  ]
}

# The agent has no anonymous invoker binding. Web's own Cloud Run identity can
# present an audience-bound ID token to read its secret-safe /ready response.
resource "google_cloud_run_v2_service_iam_member" "agent_web_invoker" {
  for_each = local.runtime_instances

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.agent[each.key].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.web[each.key].email}"
}

# Cloud Run IAM stays private by default. This is an explicit second gate:
# application Google OAuth must be configured before anonymous invocation is
# allowed through to its own owner-auth middleware.
resource "google_cloud_run_v2_service_iam_member" "web_public" {
  for_each = local.runtime_enabled && var.allow_public_web_invoker ? local.runtime_instances : {}

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.web[each.key].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Optional Cloud Tasks dispatch. A dedicated invoker identity signs OIDC
# callbacks; web and agent may only enqueue and act as that identity, and only
# the invoker (plus web's readiness probe) can call the private agent.
resource "google_service_account" "internal_invoker" {
  for_each = local.internal_invoker

  project      = var.project_id
  account_id   = "${var.installation_id}-invoker"
  display_name = "${var.installation_id} internal callbacks"
  description  = "OIDC identity for Cloud Tasks and Cloud Scheduler calls to the private agent."

  depends_on = [google_project_service.runtime]
}

resource "google_cloud_tasks_queue" "agent" {
  for_each = local.internal_invoker

  project  = var.project_id
  location = var.region
  name     = local.tasks_queue_name

  rate_limits {
    max_dispatches_per_second = 5
    max_concurrent_dispatches = 4
  }

  retry_config {
    max_attempts       = 20
    min_backoff        = "5s"
    max_backoff        = "600s"
    max_retry_duration = "86400s"
  }

  depends_on = [google_project_service.runtime]
}

resource "google_cloud_tasks_queue_iam_member" "enqueuer" {
  for_each = local.runtime_enabled && local.cloud_tasks ? toset(["agent", "web"]) : toset([])

  project  = var.project_id
  location = var.region
  name     = google_cloud_tasks_queue.agent["current"].name
  role     = "roles/cloudtasks.enqueuer"
  member   = each.key == "agent" ? "serviceAccount:${google_service_account.runtime.email}" : "serviceAccount:${google_service_account.web["current"].email}"
}

resource "google_service_account_iam_member" "invoker_act_as" {
  for_each = local.runtime_enabled && local.cloud_tasks ? toset(["agent", "web"]) : toset([])

  service_account_id = google_service_account.internal_invoker["current"].name
  role               = "roles/iam.serviceAccountUser"
  member             = each.key == "agent" ? "serviceAccount:${google_service_account.runtime.email}" : "serviceAccount:${google_service_account.web["current"].email}"
}

resource "google_service_account_iam_member" "tasks_token_creator" {
  for_each = local.internal_invoker

  service_account_id = google_service_account.internal_invoker[each.key].name
  role               = "roles/iam.serviceAccountOpenIdTokenCreator"
  member             = "serviceAccount:service-${local.project_number}@gcp-sa-cloudtasks.iam.gserviceaccount.com"

  depends_on = [google_project_service.runtime]
}

resource "google_cloud_run_v2_service_iam_member" "agent_internal_invoker" {
  for_each = local.internal_invoker

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.agent[each.key].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.internal_invoker[each.key].email}"
}

resource "google_cloud_scheduler_job" "sweep" {
  for_each = local.internal_invoker

  project          = var.project_id
  region           = var.region
  name             = "${var.installation_id}-sweep"
  description      = "Bounded due-work sweep for the scale-to-zero agent."
  schedule         = var.sweep_schedule
  time_zone        = "Etc/UTC"
  attempt_deadline = "180s"

  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri         = "${local.deterministic_agent_url}/internal/sweep"

    oidc_token {
      service_account_email = google_service_account.internal_invoker[each.key].email
      audience              = "${local.deterministic_agent_url}/internal/sweep"
    }
  }

  depends_on = [
    google_cloud_run_v2_service_iam_member.agent_internal_invoker,
  ]
}

output "web_service_account_email" {
  description = "Dedicated web identity, or null when runtime images were not supplied."
  value       = try(google_service_account.web["current"].email, null)
}

output "cloud_run_web_service_name" {
  description = "Configured private-by-default web service name; not a readiness signal."
  value       = try(google_cloud_run_v2_service.web["current"].name, null)
}

output "cloud_run_web_uri" {
  description = "Cloud Run web URI, or null without runtime images. OAuth/public access still require separate validation."
  value       = try(google_cloud_run_v2_service.web["current"].uri, null)
}

output "cloud_run_agent_service_name" {
  description = "Configured private agent service name; not a readiness signal."
  value       = try(google_cloud_run_v2_service.agent["current"].name, null)
}

output "cloud_run_agent_uri" {
  description = "Private agent URI, or null without runtime images."
  value       = try(google_cloud_run_v2_service.agent["current"].uri, null)
}

output "owner_auth_mode" {
  description = "Owner sign-in mode configured on the web service."
  value       = var.owner_auth_mode
}

output "web_auth_url" {
  description = "Exact owner origin (passkey relying party or OAuth origin), or null without runtime images."
  value       = local.runtime_enabled ? local.web_auth_url : null
}

output "cloud_tasks_queue_name" {
  description = "Agent Cloud Tasks queue, or null for the local poller profile."
  value       = try(google_cloud_tasks_queue.agent["current"].name, null)
}

output "internal_invoker_service_account_email" {
  description = "OIDC identity for Cloud Tasks and Scheduler callbacks, or null for the local poller profile."
  value       = try(google_service_account.internal_invoker["current"].email, null)
}
