from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from verify_provider import normalize_endpoints, parse_json_object, parse_model_ids


class VerifyProviderTests(unittest.TestCase):
    def test_normalizes_root_endpoint(self) -> None:
        chat, models = normalize_endpoints("https://api.example.test")
        self.assertEqual(chat, "https://api.example.test/v1/chat/completions")
        self.assertEqual(models, "https://api.example.test/v1/models")

    def test_normalizes_complete_chat_endpoint(self) -> None:
        chat, models = normalize_endpoints("https://api.example.test/v1/chat/completions")
        self.assertEqual(chat, "https://api.example.test/v1/chat/completions")
        self.assertEqual(models, "https://api.example.test/v1/models")

    def test_parses_and_deduplicates_model_ids(self) -> None:
        payload = {"data": [{"id": "beta"}, {"id": "alpha"}, {"id": "alpha"}, {}]}
        self.assertEqual(parse_model_ids(payload), ["alpha", "beta"])
        self.assertIsNone(parse_model_ids({"models": []}))

    def test_requires_json_object_response(self) -> None:
        self.assertEqual(parse_json_object('{"provider_check":"ok"}'), (True, None))
        self.assertEqual(parse_json_object('["provider_check"]'), (False, "内容是 JSON，但不是对象"))
        self.assertFalse(parse_json_object("not json")[0])


if __name__ == "__main__":
    unittest.main()
