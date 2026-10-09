import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('export_review', Path(__file__).with_name('export-native-review.py'))
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)

class NativeReviewProvenanceTests(unittest.TestCase):
    def test_old_run_keeps_its_actual_runtime_and_unknown_tested_source(self):
        summary = {'startTime': 100, 'finishTime': 200, 'devicesAndConfigurations': [{'device': {'deviceId': 'old-device', 'deviceName': 'iPhone', 'osVersion': '26.0', 'osBuildNumber': 'old-runtime', 'architecture': 'arm64'}}]}
        provenance = review.capture_provenance(summary, {'deviceId': 'old-device'}, 'NativeVisualReviewTests/testEveryPage', 'immutable-old-result')
        capture = {'page': 'memory', 'provenance': provenance}
        manifest = review.build_manifest(Path('old.xcresult'), 'immutable-old-result', summary, [capture], {'MemoryView.swift': 'changed-new-source'})
        self.assertEqual(provenance['testedDevice']['osVersion'], '26.0')
        self.assertEqual(provenance['testedSource']['status'], 'unknown')
        self.assertNotIn('changed-new-source', str(provenance))
        self.assertEqual(manifest['exportTimeSource']['status'], 'export-time-only')
        self.assertFalse(manifest['currentSourceCoverage'])

    def test_missing_or_ambiguous_device_is_unknown(self):
        devices = {'devicesAndConfigurations': [{'device': {'deviceId': 'a', 'deviceName': 'iPhone'}}, {'device': {'deviceId': 'b', 'deviceName': 'iPhone'}}]}
        self.assertIsNone(review.tested_device(devices, {'deviceName': 'iPhone'}))
        self.assertEqual(review.capture_provenance({}, {}, 'test', 'digest')['runtimeStatus'], 'unknown')
        self.assertEqual(review.tested_device(devices, {'deviceId': 'b'})['deviceId'], 'b')

    def test_result_digest_changes_when_tested_bundle_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'Data').mkdir()
            data = root / 'Data' / 'record'
            data.write_bytes(b'old-run')
            original = review.tree_digest(root)
            data.write_bytes(b'new-run')
            self.assertNotEqual(original, review.tree_digest(root))

if __name__ == '__main__':
    unittest.main()
