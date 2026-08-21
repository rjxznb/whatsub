import hashlib
import hmac
import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).with_name("dogecloud_fetch.py")
SPEC = importlib.util.spec_from_file_location("dogecloud_fetch", MODULE_PATH)
dogecloud_fetch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dogecloud_fetch)


class DogeCloudFetchTests(unittest.TestCase):
    def test_authorization_signs_path_newline_and_body(self):
        authorization = dogecloud_fetch.build_authorization(
            "access", "secret", "/oss/fetch.json", '{"url":"https://example.com/a"}'
        )
        expected = hmac.new(
            b"secret",
            b'/oss/fetch.json\n{"url":"https://example.com/a"}',
            hashlib.sha1,
        ).hexdigest()
        self.assertEqual(authorization, f"TOKEN access:{expected}")

    def test_accepts_only_public_release_asset_urls(self):
        dogecloud_fetch.validate_source_url(
            "https://github.com/rjxznb/whatsub-releases/releases/download/v0.1.111/a.exe"
        )
        with self.assertRaises(ValueError):
            dogecloud_fetch.validate_source_url("https://example.com/a.exe")

    def test_query_path_url_encodes_task_id(self):
        self.assertEqual(
            dogecloud_fetch.fetch_query_path("a/b+c="),
            "/oss/fetch/query.json?id=a%2Fb%2Bc%3D",
        )


if __name__ == "__main__":
    unittest.main()
