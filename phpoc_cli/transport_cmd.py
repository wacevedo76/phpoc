"""ph transport — manage remote transport configuration.

Commands:
    show                    Show current transport settings.
    set git                 Switch to git transport.
    set http                Switch to generic HTTP transport (prompts for URL + key).
    set http cloudflare     Switch to Cloudflare HTTP transport (guided prompts).
"""

import json
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


def run_transport_command(args, config, config_path: Optional[Path] = None):
    """Dispatch a transport subcommand.

    Args:
        args: Parsed argparse namespace with ``transport_action``.
        config: ``ConfigManager`` instance.
        config_path: Path to the config file (for editing hints).
    """
    action = getattr(args, "transport_action", None)

    if action == "show":
        _show_transport(config)
    elif action == "set":
        _set_transport(args, config, config_path)
    else:
        print("Usage: ph transport <show|set>")
        print("  ph transport show              — show current transport settings")
        print("  ph transport set git           — use git/SSH transport")
        print("  ph transport set http          — use generic HTTP transport")
        print("  ph transport set http cloudflare — use Cloudflare Worker HTTP transport")


def _show_transport(config):
    """Display current transport configuration."""
    transport = config.get("remote.transport", "git")
    provider = config.get("http.provider")
    base_url = config.get("http.base_url")
    api_key = config.get("http.api_key")
    git_url = config.get("remote.git_remote_url")

    import os
    env_key = os.environ.get("PHPOC_CLOUDFLARE_API_KEY")

    print("Transport Configuration")
    print("=" * 60)
    print(f"  Transport:     {transport}")
    
    if transport == "git":
        print(f"  Git remote:    {git_url or '(not set)'}")
        print()
        print("  To switch to HTTP transport:")
        print("    ph transport set http")
        print("    ph transport set http cloudflare")
    elif transport == "http":
        print(f"  Provider:      {provider or 'generic'}")
        print(f"  Base URL:      {base_url or '(not set)'}")
        if api_key:
            print(f"  API key:       ****  (from config file)")
        elif env_key:
            print(f"  API key:       ****  (from $PHPOC_CLOUDFLARE_API_KEY)")
        else:
            print(f"  API key:       (not set)")
        print()
        if provider == "cloudflare":
            print("  Cloudflare Worker endpoints (expected by phpoc):")
            print("    GET  /{path}            — retrieve blob")
            print("    PUT  /{path}            — store blob")
            print("    GET  /?prefix={prefix} — list blobs by prefix")
        print()
        print("  To switch back to git transport:")
        print("    ph transport set git")
    print()


def _set_transport(args, config, config_path: Optional[Path] = None):
    """Change transport type.

    Subcommands:
        set git                  — switch to git
        set http                 — switch to generic HTTP, prompts for settings
        set http cloudflare      — switch to Cloudflare HTTP, guided prompts
    """
    transport_arg = getattr(args, "transport_type", None)
    http_provider = getattr(args, "http_provider", None)

    if transport_arg == "git":
        _switch_to_git(config, config_path)
    elif transport_arg == "http":
        if http_provider == "cloudflare":
            _switch_to_cloudflare(config, config_path)
        else:
            _switch_to_http_generic(config, config_path)
    else:
        print("Usage: ph transport set <git|http> [cloudflare]")


def _switch_to_git(config, config_path: Optional[Path] = None):
    """Switch to git/SSH transport."""
    print("Switching to git transport...")
    print()

    current_url = config.get("remote.git_remote_url")
    if not current_url:
        url = input("Git remote URL: ").strip()
        if not url:
            print("No URL entered. Transport not changed.")
            return
    else:
        print(f"  Current git remote: {current_url}")
        change = input("Change URL? (y/N): ").strip().lower()
        if change == "y":
            url = input("Git remote URL: ").strip()
            if not url:
                print("No URL entered. Keeping existing.")
                url = current_url
        else:
            url = current_url

    config.write({
        "remote": {
            "transport": "git",
            "git_remote_url": url,
        },
        "http": {
            "provider": None,
            "base_url": None,
            "api_key": None,
        },
    })
    print(f"  Transport set to git (remote: {url})")
    print()
    print("Note: The git remote must be accessible via SSH keys.")
    print("      On first use, the repo will be cloned automatically.")
    print("  (The $PHPOC_CLOUDFLARE_API_KEY env var is ignored when transport is git.)")


def _switch_to_http_generic(config, config_path: Optional[Path] = None):
    """Switch to a generic HTTP transport."""
    print("Switching to HTTP transport...")
    print()
    print("Your HTTP server must implement these endpoints:")
    print("  GET  /{path}            → 200 + body bytes, or 404")
    print("  PUT  /{path}            → 200 on success, 413 if too large")
    print("  GET  /?prefix={prefix} → 200 + JSON array of filenames")
    print("  For GET requests with If-None-Match header, return 304")
    print("  to indicate the blob hasn't changed (zero-byte sync).")
    print()

    base_url = input("Base URL (e.g. https://phpoc.example.com): ").strip()
    if not base_url:
        print("No URL entered. Transport not changed.")
        return
    # Strip trailing slash
    base_url = base_url.rstrip("/")

    print()
    print("  API key options:")
    print("    1. Enter it now (stored in config file)")
    print("    2. Skip — use $PHPOC_CLOUDFLARE_API_KEY env var instead")
    print("       (set in ~/.config/zsh/.zshrc or similar)")
    print()
    api_key = input("API key (optional, press Enter to use env var): ").strip()

    config.write({
        "remote": {
            "transport": "http",
        },
        "http": {
            "provider": "generic",
            "base_url": base_url,
            "api_key": api_key if api_key else None,
        },
    })
    print(f"  Transport set to HTTP (base URL: {base_url})")
    if api_key:
        print(f"  API key: stored in config file")
    else:
        print(f"  API key: sourced from $PHPOC_CLOUDFLARE_API_KEY at runtime")
    print()


def _switch_to_cloudflare(config, config_path: Optional[Path] = None):
    """Switch to Cloudflare Worker HTTP transport with guided setup."""
    print("Switching to Cloudflare HTTP transport...")
    print()
    print("Before continuing, you'll need a Cloudflare Workers account and")
    print("the phpoc staging Worker deployed. Here's how:")
    print()
    print("  1. Install dependencies:")
    print("       cd worker && npm install")
    print()
    print("  2. Log in to Cloudflare:")
    print("       npx wrangler login")
    print()
    print("  3. Set the API key secret (choose a strong random key):")
    print("       npx wrangler secret put PHPOC_API_KEY")
    print()
    print("  4. Deploy the Worker:")
    print("       npx wrangler deploy")
    print()
    print("  5. Copy the Worker URL from the deploy output")
    print("     (e.g. https://phpoc-staging.username.workers.dev)")
    print()
    ready = input("Ready to continue? (Y/n): ").strip().lower()
    if ready == "n":
        print("Transport not changed.")
        return

    base_url = input("Worker URL (e.g. https://phpoc-staging.username.workers.dev): ").strip()
    if not base_url:
        print("No URL entered. Transport not changed.")
        return
    base_url = base_url.rstrip("/")

    print()
    print("  API key options:")
    print("    1. Enter it now (stored in config file)")
    print("    2. Skip — use $PHPOC_CLOUDFLARE_API_KEY env var instead")
    print("       (set in ~/.config/zsh/.zshrc or similar)")
    print("       Recommended: keeps secrets out of version-controlled configs")
    print()
    api_key = input("API key (optional, press Enter to use env var): ").strip()
    if not api_key:
        print("  Using $PHPOC_CLOUDFLARE_API_KEY from environment at runtime.")

    config.write({
        "remote": {
            "transport": "http",
        },
        "http": {
            "provider": "cloudflare",
            "base_url": base_url,
            "api_key": api_key if api_key else None,
        },
    })
    print(f"  Transport set to HTTP (Cloudflare Worker)")
    print(f"  Base URL: {base_url}")
    if api_key:
        print(f"  API key: stored in config file")
    else:
        print(f"  API key: sourced from $PHPOC_CLOUDFLARE_API_KEY at runtime")
    print()
    print("  To verify it works, run: ph sync")
    print("  To deploy Worker updates: cd worker && npx wrangler deploy")
    print()
