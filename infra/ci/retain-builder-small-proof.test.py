#!/usr/bin/env python3
"""Pure filesystem controls: no Docker, subprocesses, network or services."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "small_proof", Path(__file__).with_name("retain-builder-small-proof.py")
)
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class SmallProofTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.proof = self.root / "proof"
        self.proof.mkdir()
        self.output = self.root / "output"
        self.repo = self.root / "repo"
        for name in M.SOURCE_FILES:
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"synthetic source\n")
        self.payloads = {name: b'{"synthetic":true}\n' for name in M.FILES}
        self.payloads["builder-cleanup-receipt.json"] = b'{"status":"unknown","qualificationPassed":false}\n'
        for name, data in self.payloads.items():
            (self.proof / name).write_bytes(data)

    def stage(self):
        with contextlib.redirect_stdout(io.StringIO()):
            result = M.stage(self.proof, self.output, self.repo, {
                "sourceSha": "a" * 40, "runId": "1", "runAttempt": "1", "jobKey": "build"
            })
        self.receipt = json.loads((self.output / "binding.json").read_bytes())
        return result

    def test_exact_allowlist_bytes_hashes_unknown_receipt_and_permissions(self):
        (self.proof / "role-images.tar.gz").write_bytes(b"must never copy")
        (self.proof / "unrelated-secret").write_bytes(b"must never copy")
        self.assertTrue(self.stage())
        self.assertEqual(set(p.name for p in self.output.iterdir()), set(M.FILES) | {"binding.json"})
        for name, data in self.payloads.items():
            self.assertEqual((self.output / name).read_bytes(), data)
            self.assertEqual(self.receipt["files"][name]["sha256"], hashlib.sha256(data).hexdigest())
            self.assertEqual(stat.S_IMODE((self.output / name).stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.output / "binding.json").stat().st_mode), 0o600)
        self.assertEqual(self.receipt["scope"], "retention_only_not_cleanup_qualification")
        self.assertLessEqual((self.output / "binding.json").stat().st_size, M.BINDING_CAP)

    def test_missing_receipt_is_failed_retention_not_reconstructed(self):
        (self.proof / M.FILES[-1]).unlink()
        self.assertFalse(self.stage())
        self.assertEqual(self.receipt["files"][M.FILES[-1]]["status"], "missing")
        self.assertFalse((self.output / M.FILES[-1]).exists())

    def test_missing_source_directory_still_emits_missing_binding(self):
        self.proof = self.root / "absent"
        self.assertFalse(self.stage())
        self.assertTrue(all(e["status"] == "source_unavailable" for e in self.receipt["files"].values()))

    def test_symlink_source_directory_not_followed(self):
        link = self.root / "link"
        link.symlink_to(self.proof, target_is_directory=True)
        self.proof = link
        self.assertFalse(self.stage())

    def test_source_symlink_not_followed(self):
        name = M.FILES[0]
        (self.proof / name).unlink()
        (self.proof / name).symlink_to(self.proof / M.FILES[1])
        self.assertFalse(self.stage())
        self.assertEqual(self.receipt["files"][name]["status"], "symlink")

    def test_source_directory_and_fifo_rejected_without_blocking(self):
        for i, name in enumerate(M.FILES[:2]):
            (self.proof / name).unlink()
            if i == 0:
                (self.proof / name).mkdir()
            else:
                os.mkfifo(self.proof / name)
        self.assertFalse(self.stage())
        self.assertEqual([self.receipt["files"][n]["status"] for n in M.FILES[:2]], ["not_regular"] * 2)

    def test_per_file_cap_omits_whole_file_without_digest(self):
        name = M.FILES[0]
        (self.proof / name).write_bytes(b"x" * (M.FILE_CAP + 1))
        self.assertFalse(self.stage())
        self.assertEqual(self.receipt["files"][name], {"status": "oversize", "bytes": M.FILE_CAP + 1})
        self.assertFalse((self.output / name).exists())

    def test_total_cap_includes_binding_and_never_truncates_files(self):
        for name in M.FILES:
            (self.proof / name).write_bytes(b"x" * M.FILE_CAP)
        self.assertFalse(self.stage())
        self.assertEqual(sum(e["status"] == "copied" for e in self.receipt["files"].values()), 3)
        self.assertLessEqual(sum(p.stat().st_size for p in self.output.iterdir()), M.TOTAL_CAP)
        for name in M.FILES:
            if (self.output / name).exists():
                self.assertEqual((self.output / name).stat().st_size, M.FILE_CAP)

    def test_binding_cap_excess_rejected(self):
        with patch.object(M, "BINDING_CAP", 10), self.assertRaises(ValueError):
            self.stage()
        self.assertFalse((self.output / "binding.json").exists())

    def test_file_content_changed_during_read_is_unstable(self):
        original = os.read
        changed = False
        def mutate(fd, size):
            nonlocal changed
            data = original(fd, size)
            if not changed:
                changed = True
                (self.proof / M.FILES[0]).write_bytes(b"different after read")
            return data
        with patch.object(M.os, "read", side_effect=mutate):
            self.assertFalse(self.stage())
        self.assertEqual(self.receipt["files"][M.FILES[0]]["status"], "unstable")

    def test_same_name_replaced_after_read_is_unstable(self):
        original = os.read
        changed = False
        def replace(fd, size):
            nonlocal changed
            data = original(fd, size)
            if not changed:
                changed = True
                path = self.proof / M.FILES[0]
                path.unlink()
                path.write_bytes(self.payloads[M.FILES[0]])
            return data
        with patch.object(M.os, "read", side_effect=replace):
            self.assertFalse(self.stage())
        self.assertEqual(self.receipt["files"][M.FILES[0]]["status"], "unstable")

    def test_read_error_reported_without_raw_error_text(self):
        with patch.object(M.os, "read", side_effect=OSError("private detail")):
            self.assertFalse(self.stage())
        self.assertNotIn("private detail", (self.output / "binding.json").read_text())

    def test_missing_source_pin_fails_retention(self):
        (self.repo / M.SOURCE_FILES[0]).unlink()
        self.assertFalse(self.stage())
        self.assertEqual(self.receipt["checkedOutSourceFiles"][M.SOURCE_FILES[0]]["status"], "missing")

    def test_existing_output_refused_and_untouched(self):
        self.output.mkdir()
        sentinel = self.output / "keep"
        sentinel.write_bytes(b"keep")
        with self.assertRaises(FileExistsError):
            self.stage()
        self.assertEqual(sentinel.read_bytes(), b"keep")
        self.assertEqual(list(self.output.iterdir()), [sentinel])

    def test_symlink_output_refused_and_target_untouched(self):
        target = self.root / "target"
        target.mkdir()
        self.output.symlink_to(target, target_is_directory=True)
        with self.assertRaises(FileExistsError):
            self.stage()
        self.assertEqual(list(target.iterdir()), [])

    def test_exclusive_writer_preserves_preexisting_destination(self):
        self.output.mkdir()
        name = M.FILES[0]
        (self.output / name).write_bytes(b"old")
        fd = os.open(self.output, os.O_RDONLY | os.O_DIRECTORY)
        try:
            with self.assertRaises(FileExistsError):
                M.write_exclusive(fd, name, b"new")
        finally:
            os.close(fd)
        self.assertEqual((self.output / name).read_bytes(), b"old")

    def test_partial_write_error_removes_only_created_copy(self):
        original = os.write
        calls = 0
        def fail_second(fd, data):
            nonlocal calls
            calls += 1
            if calls == 1:
                return original(fd, data[:1])
            if calls == 2:
                raise OSError("synthetic write failure")
            return original(fd, data)
        with patch.object(M.os, "write", side_effect=fail_second):
            self.assertFalse(self.stage())
        self.assertEqual(self.receipt["files"][M.FILES[0]]["status"], "write_error")
        self.assertFalse((self.output / M.FILES[0]).exists())

    def test_cli_malformed_identity_rejected_without_packet(self):
        with patch("sys.argv", ["stage", "--proof", str(self.proof), "--output", str(self.output),
            "--source-sha", "secret", "--run-id", "1", "--run-attempt", "1", "--job-key", "build"
        ]), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            M.main()
        self.assertFalse(self.output.exists())

    def test_cli_exit_code_gates_retention_not_cleanup_outcome(self):
        for complete in (True, False):
            with self.subTest(complete=complete):
                self.output = self.root / ("complete" if complete else "incomplete")
                if not complete:
                    (self.proof / M.FILES[-1]).unlink()
                with patch("sys.argv", [
                    "stage", "--proof", str(self.proof), "--output", str(self.output),
                    "--source-sha", "a" * 40, "--run-id", "1", "--run-attempt", "1",
                    "--job-key", "build",
                ]), contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(M.main(), 0 if complete else 1)
                binding = json.loads((self.output / "binding.json").read_bytes())
                self.assertEqual(binding["status"], "complete" if complete else "incomplete")


if __name__ == "__main__":
    unittest.main()

