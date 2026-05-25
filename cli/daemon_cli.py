"""``ph daemon start/stop/status`` subcommand handlers.

Each handler receives a ``PhDaemon`` instance and the parsed ``args`` namespace.
"""

from pathlib import Path
from cli.daemon import PhDaemon


def handle_daemon_start(daemon: PhDaemon, args) -> None:
    """Start the background sync daemon."""
    daemon.start()


def handle_daemon_stop(daemon: PhDaemon, args) -> None:
    """Stop the background sync daemon gracefully."""
    daemon.stop()


def handle_daemon_status(daemon: PhDaemon, args) -> None:
    """Display daemon running status and last sync state."""
    daemon.status()
