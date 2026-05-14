"""Abstract View Interface for all user interaction.

Every method has a no-op default so views only override what they need.
Concrete implementations: CLI, TUI, Web, headless.
"""

from typing import Optional


class ViewInterface:
    """Abstract view for all user interaction.

    This is a "duck-typed" abstract class — subclasses override the
    methods they need. No-op defaults mean views implement only what
    their medium supports.
    """

    # ------------------------------------------------------------------
    # Display
    # ------------------------------------------------------------------

    def render_entry_line(self, entry: dict, overrides: dict = None,
                          excluded: set = None) -> str:
        """Format one entry as a single display line.

        Args:
            entry: Preview dict with keys: entry_index, title, start_epoch,
                   end_epoch, duration, tags, date, comment, media.
            overrides: Optional dict of proposed changes keyed by entry_index.
            excluded: Optional set of entry_index values marked for removal.

        Returns:
            Formatted string for display.
        """
        return ""

    def render_entry_list(self, entries: list) -> str:
        """Format a list of entries for display."""
        return "\n".join(self.render_entry_line(e) for e in entries)

    def render_overview(self, pending: list, overrides: dict, excluded: set):
        """Display overview of pending sync entries."""
        pass

    def render_edit_menu(self, pending: list, overrides: dict, excluded: set):
        """Display edit menu with original + proposed changes."""
        pass

    def render_review(self, entries: list):
        """Display review of entries as they'd appear after sync."""
        pass

    def render_active_list(self, entries: list, show_tags: bool = False):
        """Display the list of currently active tasks."""
        pass

    def render_summary(self, summary: dict):
        """Display a reputation/summary report from blind index data."""
        pass

    def render_activities(self, activities: list, source: str = "all"):
        """Display a detailed list of activities from source(s)."""
        pass

    def render_tags(self, tags: list):
        """Display all unique tags."""
        pass

    def render_error(self, message: str):
        """Display an error message."""
        pass

    def render_success(self, message: str):
        """Display a success/confirmation message."""
        pass

    def render_warning(self, message: str):
        """Display a warning message."""
        pass

    # ------------------------------------------------------------------
    # Notifications
    # ------------------------------------------------------------------

    def notify(self, message: str):
        """Display a non-blocking notification message.

        Used by SyncOrchestrator to signal sync completion.
        Default: uses render_success() which is overridden by each view.
        """
        self.render_success(message)

    def render_help(self, help_items: dict):
        """Display a help listing from {key: description} dict."""
        pass

    # ------------------------------------------------------------------
    # Input
    # ------------------------------------------------------------------

    def prompt_choice(self, prompt: str, options: list,
                      help_items: dict = None) -> str:
        """Prompt user to choose from options. Returns the chosen key."""
        return ""

    def prompt_text(self, prompt: str, default: str = "") -> str:
        """Prompt for free-text input."""
        return default

    def prompt_time(self, prompt: str, date_str: str,
                    start_epoch: int, end_epoch: int = None) -> Optional[int]:
        """Prompt for time input. Returns epoch ms or None."""
        return None

    def prompt_yes_no(self, prompt: str, default: bool = False) -> bool:
        """Prompt for yes/no confirmation."""
        return default

    def prompt_int(self, prompt: str, min_val: int = None,
                   max_val: int = None) -> Optional[int]:
        """Prompt for integer input. Returns int or None on cancel."""
        return None

    def prompt_tag_action(self, current_tags: list) -> tuple:
        """Interactive tag editor.

        Returns:
            (tags: list, modified: bool) tuple.
        """
        return (list(current_tags), False)
