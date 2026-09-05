"""Packaging smoke tests that do not require credentials or network access."""

import specpilot


def test_package_can_be_imported() -> None:
    """The installed project exposes its top-level package."""
    assert specpilot.__name__ == "specpilot"
