import os
import unittest
from unittest.mock import patch
# Need to make sure appwrite_mcp is importable.
# The tests run from apps/appwrite-mcp/tests
import sys
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../src')))
from app import _endpoint

class TestEnvCompat(unittest.TestCase):
    def test_legacy_env_key(self):
        # This test should fail before implementation
        with patch.dict(os.environ, {"VOID_MCP_ENDPOINT": "http://void.local"}, clear=True):
            self.assertEqual(_endpoint(), "http://void.local")

if __name__ == '__main__':
    unittest.main()
