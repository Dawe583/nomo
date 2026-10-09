"""Test bootstrap.

The package lives under ``src/`` so it can never be imported by accident from
the repository root. Adding ``src`` here is the whole install story: no
``pip``, no build backend, no network.
"""

from __future__ import annotations

import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
