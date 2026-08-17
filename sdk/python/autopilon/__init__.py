"""Minimal Python client for the Autopilon Public API (Phase 17.1 §4)."""

from .client import AutopilonClient, AutopilonApiError

__all__ = ["AutopilonClient", "AutopilonApiError"]
__version__ = "1.0.0"
