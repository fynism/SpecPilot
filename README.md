# SpecPilot

SpecPilot is a specification-aware control layer for AI coding workflows. The current repository
contains an early Anthropic-powered CLI demo while the product model is being developed.

## Local setup

The recommended workflow uses [uv](https://docs.astral.sh/uv/):

```powershell
uv sync --all-extras
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Fill in `ANTHROPIC_API_KEY`, `MODEL_ID`, and optionally `ANTHROPIC_BASE_URL` in `.env`, then run:

```powershell
uv run specpilot
```

The compatibility entry point remains available as `uv run python code.py`.

For a traditional pip environment on Windows:

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
```

## Verification

```powershell
uv run ruff format --check .
uv run ruff check .
uv run mypy
uv run pytest
```

The lock file is the reproducible dependency snapshot. Refresh it deliberately with `uv lock`, and
commit dependency upgrades separately from behavior changes.
