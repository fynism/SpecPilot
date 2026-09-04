"""Environment configuration and project paths."""

import os
from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = PROJECT_ROOT / ".env"
NOTES_DIR = PROJECT_ROOT / "notes"

load_dotenv(dotenv_path=ENV_FILE, override=True)

API_KEY = os.getenv("ANTHROPIC_API_KEY")
BASE_URL = os.getenv("ANTHROPIC_BASE_URL")
MODEL = os.getenv("MODEL_ID")
MAX_TURNS = int(os.getenv("MAX_TURNS", 15))

if not API_KEY:
    raise RuntimeError(f"ANTHROPIC_API_KEY is missing. Set it in {ENV_FILE}")
if not MODEL:
    raise RuntimeError(f"MODEL_ID is missing. Set it in {ENV_FILE}")

