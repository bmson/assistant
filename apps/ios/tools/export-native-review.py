#!/usr/bin/env python3
"""Export original XCTest page captures with stable, readable names.

Usage: python3 apps/ios/tools/export-native-review.py RESULT.xcresult OUTPUT_DIR
No image is altered. XCTResult's original metadata is retained in export-manifest.
"""
from pathlib import Path
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile

result = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="assistant-native-captures-") as staging:
    subprocess.run(["xcrun", "xcresulttool", "export", "attachments", "--path", str(result), "--output-path", staging], check=True, stdout=subprocess.DEVNULL)
    details = json.loads((Path(staging) / "manifest.json").read_text())
    captures = []
    for test in details:
        if "NativeVisualReviewTests" not in test["testIdentifier"]:
            continue
        for item in test["attachments"]:
            source = Path(staging) / item["exportedFileName"]
            label = item["suggestedHumanReadableName"]
            if source.suffix.lower() != ".png" or "-phone-" not in label:
                continue
            # XCTest may decorate the attachment label with its file extension.
            stem = re.sub(r"_\d+_[0-9A-Fa-f-]{36}\.png$", "", label)
            stem = re.sub(r"\.png$", "", stem)
            filename = re.sub(r"[^a-zA-Z0-9._-]", "-", stem) + ".png"
            destination = output / filename
            if destination.exists():
                raise SystemExit(f"Refusing to replace an existing capture: {destination}")
            shutil.copyfile(source, destination)
            match = re.match(r"(.+)-phone-(light|dark)-(\d+)(-accessible)?-(top|scroll-\d+)", stem)
            captures.append({"file": filename, "page": match[1] if match else stem,
                             "appearance": match[2] if match else None,
                             "widthPoints": int(match[3]) if match else None,
                             "largeText": bool(match and match[4]), "position": match[5] if match else None,
                             "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                             "device": item.get("deviceName"), "deviceId": item.get("deviceId"),
                             "associatedWithFailure": item.get("isAssociatedWithFailure", False)})
    (output / "export-manifest.json").write_text(json.dumps(details, indent=2) + "\n")
    source_root = Path(__file__).resolve().parents[1] / "Assistant"
    hashes = {str(path.relative_to(source_root)): hashlib.sha256(path.read_bytes()).hexdigest()
              for path in sorted(source_root.rglob("*.swift"))}
    manifest = {"resultBundle": str(result), "runtime": "iOS 27.0 (24A5355p), arm64",
                "method": "UIKit UIHostingController capture with isolated read-only fixture URLProtocol",
                "sourceSha256": hashes, "captures": captures,
                "pageCount": len({capture["page"] for capture in captures}), "captureCount": len(captures)}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Exported {manifest['captureCount']} original captures across {manifest['pageCount']} pages to {output}")
