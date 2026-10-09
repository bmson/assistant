#!/usr/bin/env python3
"""Keep hosted PostgreSQL bootstrap and public base-image checks aligned."""

from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
workflow = (root / ".github/workflows/ci.yml").read_text(encoding="utf-8")
deploy = (root / ".github/workflows/deploy.yml").read_text(encoding="utf-8")
service = (root / "infra/ci/postgres-service.sh").read_text(encoding="utf-8")
installer = (root / "infra/ci/install-postgres17.sh").read_text(encoding="utf-8")


def job_block(name: str) -> str:
    match = re.search(rf"(?ms)^  {re.escape(name)}:\n(.*?)(?=^  [a-z][a-z0-9-]*:\n|\Z)", workflow)
    assert match, f"missing CI job: {name}"
    return match.group(1)


for name in ("verify", "firestore", "build-smoke"):
    block = job_block(name)
    assert "services:" not in block, f"{name} still uses a pre-checkout service"
    checkout = block.index("actions/checkout@")
    install = block.index("bash infra/ci/install-postgres17.sh")
    start = block.index("bash infra/ci/postgres-service.sh start")
    pnpm_install = block.index("pnpm install --frozen-lockfile")
    cleanup = block.index("bash infra/ci/postgres-service.sh cleanup")
    assert checkout < install < start < pnpm_install < cleanup, f"{name} startup/cleanup order changed"
    assert "if: always()" in block[cleanup - 100 : cleanup], f"{name} cleanup must run after failures"
    start_step = block[block.rfind("      - name: Start PostgreSQL service", 0, start) : start]
    assert "POSTGRES_USER: assistant" in start_step
    assert "POSTGRES_PASSWORD: assistant" in start_step
    assert "POSTGRES_DB: assistant" in start_step
    assert "postgres-service.sh cleanup" in block

verify = job_block("verify")
assert "postgres://assistant:assistant@localhost:5432/assistant" in verify
assert "postgres://assistant:assistant@localhost:5432/assistant_test" in verify
firestore = job_block("firestore")
assert "postgres://assistant:assistant@localhost:5432/assistant_test" in firestore
assert "127.0.0.1:8789" in firestore
build = job_block("build-smoke")
assert "postgres://assistant:assistant@localhost:5432/assistant" in build

base = job_block("base-images")
assert "timeout-minutes: 5" in base
assert "public.ecr.aws/docker/library/node:22-slim" in base
assert "docker pull \"$image\"" in base
assert "process.versions.node" in base and '22.*' in base
assert "postgres:17" not in base, "the unrelated PostgreSQL image is not part of this release path"

for expected in (
    "create_main_cluster = false",
    "apt-get install -y -q postgresql-17 postgresql-17-pgvector",
    "trap restore_package_guards EXIT",
    "exit 101",
    "PostgreSQL 17 binaries were not installed",
):
    assert expected in installer, f"package bootstrap lost required behavior: {expected}"
for expected in (
    'owned_root="/tmp/assistant-pg17-',
    "--auth-local=peer --auth-host=scram-sha-256",
    "-p 5432",
    "CREATE EXTENSION vector",
    "SHOW server_version_num",
    "pg_isready",
    "Refusing to clean PostgreSQL data owned by another run",
    "preserving its data",
):
    assert expected in service, f"owned PostgreSQL lifecycle lost required behavior: {expected}"

assert workflow.count("bash infra/ci/install-postgres17.sh") == 3
assert workflow.count("bash infra/ci/postgres-service.sh start") == 3
assert workflow.count("bash infra/ci/postgres-service.sh cleanup") == 3
assert "bash infra/ci/install-postgres17.test.sh" in workflow
assert "bash infra/ci/postgres-service.test.sh" in workflow
assert "configure-docker-cache" not in workflow
assert "configure-docker-cache" not in deploy
assert "infra/ci/*.sh" in workflow

print("PostgreSQL 17 CI workflow assertions passed")
