mock_provider "google" {}

override_data {
  target = data.google_project.runtime
  values = {
    number = "123456789012"
  }
}

override_resource {
  target          = google_service_account.web
  override_during = plan
  values = {
    email = "pilot-web@consumer-test-project.iam.gserviceaccount.com"
  }
}

override_resource {
  target          = google_service_account.internal_invoker
  override_during = plan
  values = {
    email = "pilot-invoker@consumer-test-project.iam.gserviceaccount.com"
    name  = "projects/consumer-test-project/serviceAccounts/pilot-invoker@consumer-test-project.iam.gserviceaccount.com"
  }
}

variables {
  release_sha             = "0123456789abcdef0123456789abcdef01234567"
  project_id              = "consumer-test-project"
  region                  = "us-west1"
  installation_id         = "pilot"
  firestore_database_id   = "(default)"
  create_default_database = true
  firestore_location_id   = "us-west1"
  assets_bucket_name      = "consumer-test-project-pilot-assets"
  source_bucket_name      = "consumer-test-project-pilot-source"
  artifact_repository_id  = "pilot"

  web_image_digest   = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  agent_image_digest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  firestore_agent_id = "11111111-1111-4111-8111-111111111111"
  firestore_embedding_space = {
    provider   = "vertex"
    model      = "gemini-embedding-001"
    dimensions = 1536
    revision   = "customer-seed-v1"
  }
  owner_email         = "owner@example.com"
  owner_auth_mode     = "passkey"
  auth_secret_version = 1
}

run "passkey_runtime_needs_no_oauth_client_and_uses_deterministic_origin" {
  command = plan

  assert {
    condition = (
      one([for env in google_cloud_run_v2_service.web["current"].template[0].containers[0].env : env.value if env.name == "OWNER_AUTH_MODE"]) == "passkey" &&
      one([for env in google_cloud_run_v2_service.web["current"].template[0].containers[0].env : env.value if env.name == "AUTH_URL"]) == "https://pilot-web-123456789012.us-west1.run.app" &&
      output.web_auth_url == "https://pilot-web-123456789012.us-west1.run.app"
    )
    error_message = "Passkey mode must bind the exact deterministic Cloud Run origin."
  }
  assert {
    condition = (
      keys(google_secret_manager_secret_iam_member.web_auth) == ["AUTH_SECRET"] &&
      length([for env in google_cloud_run_v2_service.web["current"].template[0].containers[0].env : env if contains(["AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"], env.name)]) == 0
    )
    error_message = "Passkey mode must read only the session-signing secret."
  }
  assert {
    condition = (
      length(google_cloud_tasks_queue.agent) == 0 &&
      length(google_cloud_scheduler_job.sweep) == 0 &&
      length(google_service_account.internal_invoker) == 0 &&
      google_cloud_run_v2_service.agent["current"].scaling[0].min_instance_count == 1 &&
      one([for env in google_cloud_run_v2_service.agent["current"].template[0].containers[0].env : env.value if env.name == "QUEUE_DRIVER"]) == "local"
    )
    error_message = "The default dispatch profile keeps the local poller and creates no queue or scheduler."
  }
}

run "explicit_custom_origin_is_preserved" {
  command = plan
  variables {
    web_auth_url = "https://assistant.example.com"
  }
  assert {
    condition     = one([for env in google_cloud_run_v2_service.web["current"].template[0].containers[0].env : env.value if env.name == "AUTH_URL"]) == "https://assistant.example.com"
    error_message = "A supplied custom origin must not be replaced by the Cloud Run URL."
  }
}

run "passkey_rejects_google_client_versions" {
  command = plan
  variables {
    google_client_id_version     = 3
    google_client_secret_version = 4
  }
  expect_failures = [terraform_data.runtime_input_guard["current"]]
}

run "passkey_still_requires_auth_secret" {
  command = plan
  variables {
    auth_secret_version = null
  }
  expect_failures = [terraform_data.runtime_input_guard["current"]]
}

run "google_mode_still_requires_explicit_oauth_origin" {
  command = plan
  variables {
    owner_auth_mode              = "google"
    google_client_id_version     = 3
    google_client_secret_version = 4
  }
  expect_failures = [terraform_data.runtime_input_guard["current"]]
}

run "cloud_tasks_dispatch_is_least_privilege_and_scales_to_zero" {
  command = plan
  variables {
    task_dispatch = "cloud-tasks"
  }

  assert {
    condition = (
      google_cloud_run_v2_service.agent["current"].scaling[0].min_instance_count == 0 &&
      google_cloud_run_v2_service.agent["current"].template[0].containers[0].resources[0].cpu_idle == true &&
      one([for env in google_cloud_run_v2_service.agent["current"].template[0].containers[0].env : env.value if env.name == "QUEUE_DRIVER"]) == "cloudtasks" &&
      one([for env in google_cloud_run_v2_service.web["current"].template[0].containers[0].env : env.value if env.name == "QUEUE_DRIVER"]) == "cloudtasks" &&
      one([for env in google_cloud_run_v2_service.agent["current"].template[0].containers[0].env : env.value if env.name == "CLOUD_TASKS_QUEUE"]) == "pilot-agent-steps" &&
      one([for env in google_cloud_run_v2_service.agent["current"].template[0].containers[0].env : env.value if env.name == "INTERNAL_OIDC_AUDIENCE"]) == "https://pilot-agent-123456789012.us-west1.run.app" &&
      one([for env in google_cloud_run_v2_service.agent["current"].template[0].containers[0].env : env.value if env.name == "AGENT_URL"]) == "https://pilot-agent-123456789012.us-west1.run.app" &&
      one([for env in google_cloud_run_v2_service.web["current"].template[0].containers[0].env : env.value if env.name == "INTERNAL_OIDC_SERVICE_ACCOUNT"]) == "pilot-invoker@consumer-test-project.iam.gserviceaccount.com"
    )
    error_message = "Cloud Tasks dispatch must scale the agent to zero and configure queue and OIDC settings."
  }
  assert {
    condition = (
      google_cloud_tasks_queue.agent["current"].name == "pilot-agent-steps" &&
      google_cloud_tasks_queue_iam_member.enqueuer["agent"].role == "roles/cloudtasks.enqueuer" &&
      google_cloud_tasks_queue_iam_member.enqueuer["web"].member == "serviceAccount:pilot-web@consumer-test-project.iam.gserviceaccount.com" &&
      google_service_account_iam_member.invoker_act_as["web"].role == "roles/iam.serviceAccountUser" &&
      google_service_account_iam_member.tasks_token_creator["current"].member == "serviceAccount:service-123456789012@gcp-sa-cloudtasks.iam.gserviceaccount.com" &&
      google_cloud_run_v2_service_iam_member.agent_internal_invoker["current"].member == "serviceAccount:pilot-invoker@consumer-test-project.iam.gserviceaccount.com" &&
      google_cloud_run_v2_service_iam_member.agent_internal_invoker["current"].role == "roles/run.invoker"
    )
    error_message = "Only the invoker identity may call the agent; web and agent may only enqueue and act as it."
  }
  assert {
    condition = (
      google_cloud_scheduler_job.sweep["current"].http_target[0].uri == "https://pilot-agent-123456789012.us-west1.run.app/internal/sweep" &&
      google_cloud_scheduler_job.sweep["current"].http_target[0].oidc_token[0].audience == "https://pilot-agent-123456789012.us-west1.run.app/internal/sweep" &&
      google_cloud_scheduler_job.sweep["current"].http_target[0].oidc_token[0].service_account_email == "pilot-invoker@consumer-test-project.iam.gserviceaccount.com" &&
      google_cloud_scheduler_job.sweep["current"].schedule == "* * * * *" &&
      toset(google_cloud_run_v2_service.agent["current"].custom_audiences) == toset([
        "https://pilot-agent-123456789012.us-west1.run.app/internal/tasks/execute",
        "https://pilot-agent-123456789012.us-west1.run.app/internal/sweep",
      ])
    )
    error_message = "Both callback routes must have explicit Cloud Run custom audiences matching the route-bound application validator."
  }
  assert {
    condition = (
      contains(keys(google_project_service.runtime), "cloudtasks.googleapis.com") &&
      contains(keys(google_project_service.runtime), "cloudscheduler.googleapis.com") &&
      output.cloud_tasks_queue_name == "pilot-agent-steps"
    )
    error_message = "Cloud Tasks and Scheduler APIs are enabled only for this profile."
  }
}

run "invalid_dispatch_mode_is_rejected" {
  command = plan
  variables {
    task_dispatch = "pubsub"
  }
  expect_failures = [var.task_dispatch]
}
