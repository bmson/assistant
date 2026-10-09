#!/usr/bin/env python3
"""Keep the hosted-runner PostgreSQL bootstrap aligned with its consumers."""

from pathlib import Path
import re

root = Path(__file__).resolve().parents[2]
workflow = (root / ".github/workflows/ci.yml").read_text(encoding="utf-8")
service = (root / "infra/ci/postgres-service.sh").read_text(encoding="utf-8")


def job_block(name: str) -> str:
    match = re.search(rf"(?ms)^  {re.escape(name)}:\n(.*?)(?=^  [a-z][a-z0-9-]*:\n|\Z)", workflow)
    assert match, f"missing CI job: {name}"
    return match.group(1)


for name in ("verify", "firestore", "build-smoke"):
    block = job_block(name)
    assert "services:" not in block, f"{name} still starts services before checkout"
    checkout = block.index("actions/checkout@")
    cache = block.index("bash infra/ci/configure-docker-cache.sh")
    start = block.index("bash infra/ci/postgres-service.sh start")
    install = block.index("pnpm install --frozen-lockfile")
    cleanup = block.index("bash infra/ci/postgres-service.sh cleanup")
    assert checkout < cache < start < install < cleanup, f"{name} startup/cleanup order changed"
    assert "if: always()" in block[cleanup - 100 : cleanup], f"{name} cleanup must run after failures"
    start_step = block[block.rfind("      - name: Start PostgreSQL service", 0, start) : start]
    assert "POSTGRES_USER: assistant" in start_step
    assert "POSTGRES_PASSWORD: assistant" in start_step
    assert "POSTGRES_DB: assistant" in start_step

verify = job_block("verify")
assert "postgres://assistant:assistant@localhost:5432/assistant" in verify
assert "postgres://assistant:assistant@localhost:5432/assistant_test" in verify
firestore = job_block("firestore")
assert "postgres://assistant:assistant@localhost:5432/assistant_test" in firestore
assert "127.0.0.1:8789" in firestore
build = job_block("build-smoke")
assert "postgres://assistant:assistant@localhost:5432/assistant" in build

for option in (
    "--publish 5432:5432",
    "--health-cmd 'pg_isready -U assistant'",
    "--health-interval 5s",
    "--health-timeout 3s",
    "--health-retries 10",
    "pgvector/pgvector:pg17",
):
    assert option in service, f"PostgreSQL runtime setting changed: {option}"

assert workflow.count("bash infra/ci/postgres-service.sh start") == 3
assert workflow.count("bash infra/ci/postgres-service.sh cleanup") == 3
assert "bash infra/ci/configure-docker-cache.test.sh" in workflow
assert "bash infra/ci/postgres-service.test.sh" in workflow
assert "infra/ci/*.sh" in workflow

print("PostgreSQL CI workflow assertions passed")
