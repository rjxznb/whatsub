import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).with_name("dogecloud_upload.py")
SPEC = importlib.util.spec_from_file_location("dogecloud_upload", MODULE_PATH)
dogecloud_upload = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dogecloud_upload)


class DogeCloudUploadTests(unittest.TestCase):
    def test_tmp_token_request_uses_exact_object_scope_and_hmac_sha1(self):
        body, authorization = dogecloud_upload.build_tmp_token_request(
            "access", "secret", "bucket-a", "app/v1/setup.exe"
        )

        self.assertEqual(
            json.loads(body),
            {"channel": "OSS_UPLOAD", "scopes": ["bucket-a:app/v1/setup.exe"]},
        )
        expected = hmac.new(
            b"secret",
            ("/auth/tmp_token.json\n" + body).encode("utf-8"),
            hashlib.sha1,
        ).hexdigest()
        self.assertEqual(authorization, f"TOKEN access:{expected}")

    def test_normalize_domain_removes_trailing_slashes(self):
        self.assertEqual(
            dogecloud_upload.normalize_domain("https://download.eversay.cc///"),
            "https://download.eversay.cc",
        )


if __name__ == "__main__":
    unittest.main()
