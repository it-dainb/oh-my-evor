"""Evor FastAPI dashboard — live evolution mission viewer.

Public surface::

    from evor.dashboard import create_app, serve, serve_in_background
"""

from evor.dashboard.server import create_app, serve, serve_in_background

__all__ = ["create_app", "serve", "serve_in_background"]
