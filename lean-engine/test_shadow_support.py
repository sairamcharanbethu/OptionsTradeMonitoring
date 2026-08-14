import hashlib
import hmac
import unittest

from shadow_support import canonical_json, selected_expiry, signed_headers


class ShadowSupportTests(unittest.TestCase):
    def test_canonical_signing_is_stable(self):
        body = {"b": 2, "a": [{"z": 1, "a": True}]}
        self.assertEqual(canonical_json(body), '{"a":[{"a":true,"z":1}],"b":2}')
        headers = signed_headers("x" * 32, body, timestamp=10, nonce="n" * 16)
        digest = hashlib.sha256(canonical_json(body).encode()).hexdigest()
        expected = hmac.new(("x" * 32).encode(), f"10\n{'n' * 16}\n{digest}".encode(), hashlib.sha256).hexdigest()
        self.assertEqual(headers["X-Lean-Signature"], expected)

    def test_expiry_selection_keeps_0dte_before_one_pm(self):
        contracts = [{"expiry": "20260814"}, {"expiry": "20260817"}]
        timestamp = 1786712400  # 2026-08-14 10:00:00 ET
        self.assertEqual(selected_expiry(contracts, timestamp), ("20260814", "0DTE"))


if __name__ == "__main__":
    unittest.main()
