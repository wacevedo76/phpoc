"""CLI-specific time input parsing.

Extracted from main.py _parse_time_input to isolate CLI-specific logic
from the command dispatch layer.
"""

import re
import time
from datetime import timezone, datetime
from typing import Optional, Tuple


def parse_time_input(value_str: str, date_str: str,
                     start_epoch: int,
                     end_epoch: Optional[int] = None) -> Tuple[Optional[int], str]:
    """Parse a time input to epoch ms.

    Supported formats:
      HH:MM or HH:MM:SS  -> clock time on date_str (local time)
      +N[m|h|s]           -> offset from start_epoch
      -N[m|h|s]           -> offset from end_epoch (clamped at start_epoch)
      N[h][m][s]          -> absolute duration from start_epoch
      <epoch ms>          -> raw epoch ms

    Returns:
        (epoch_ms, display_str) or (None, error_msg).
    """
    value_str = value_str.strip()

    # Offset from start: +N[m|h|s]
    if value_str.startswith("+"):
        try:
            offset_str = value_str.lstrip("+").strip()
            if offset_str.endswith("m"):
                offset_ms = int(offset_str[:-1]) * 60000
            elif offset_str.endswith("h"):
                offset_ms = int(offset_str[:-1]) * 3600000
            elif offset_str.endswith("s"):
                offset_ms = int(offset_str[:-1]) * 1000
            else:
                offset_ms = int(offset_str) * 60000
            result = start_epoch + offset_ms
            return result, time.strftime("%H:%M:%S", time.localtime(result / 1000))
        except ValueError:
            return None, "Invalid offset format."

    # Offset from end: -N[m|h|s]
    if value_str.startswith("-"):
        if end_epoch is None:
            return None, "No end time to offset from."
        try:
            offset_str = value_str.lstrip("-").strip()
            if offset_str.endswith("m"):
                offset_ms = int(offset_str[:-1]) * 60000
            elif offset_str.endswith("h"):
                offset_ms = int(offset_str[:-1]) * 3600000
            elif offset_str.endswith("s"):
                offset_ms = int(offset_str[:-1]) * 1000
            else:
                offset_ms = int(offset_str) * 60000
            result = end_epoch - offset_ms
            if result < start_epoch:
                result = start_epoch
            return result, time.strftime("%H:%M:%S", time.localtime(result / 1000))
        except ValueError:
            return None, "Invalid offset format."

    # Duration from start: N[h][m][s]
    if re.search(r"\d+(?:h|m|s)", value_str):
        try:
            h = m = s = 0
            h_match = re.search(r"(\d+)h", value_str)
            m_match = re.search(r"(\d+)m", value_str)
            s_match = re.search(r"(\d+)s", value_str)
            if h_match:
                h = int(h_match.group(1))
            if m_match:
                m = int(m_match.group(1))
            if s_match:
                s = int(s_match.group(1))
            duration_ms = (h * 3600 + m * 60 + s) * 1000
            result = start_epoch + duration_ms
            return result, time.strftime("%H:%M:%S", time.localtime(result / 1000))
        except ValueError:
            return None, "Invalid duration format."

    # Clock time: HH:MM or HH:MM:SS
    parts = value_str.split(":")
    if len(parts) in (2, 3):
        try:
            date_parts = date_str.split("-")
            h, m = int(parts[0]), int(parts[1])
            s = int(parts[2]) if len(parts) == 3 else 0

            # --- P11: Hour wrapping (h >= 24) ---
            # Wrap hours beyond 23 into extra days.
            extra_days = h // 24
            h = h % 24

            dt = datetime(int(date_parts[0]), int(date_parts[1]), int(date_parts[2]),
                          h, m, s)
            result = int(dt.timestamp() * 1000)

            # Roll forward by extra days from hour wrapping
            if extra_days:
                result += extra_days * 86400000

            # --- P11: 00:00 auto-advance ---
            # If the parsed time is before start_epoch AND hour == 0 (it's midnight),
            # advance to the next day. This handles the case where the user types
            # "00:00" meaning "midnight tonight" which is technically tomorrow for
            # late-night entries.
            if h == 0 and m == 0 and s == 0 and result < start_epoch:
                result += 86400000

            return result, time.strftime("%H:%M:%S", time.localtime(result / 1000))
        except (ValueError, IndexError):
            pass

    # Raw epoch ms
    try:
        result = int(value_str)
        return result, time.strftime("%H:%M:%S", time.localtime(result / 1000))
    except ValueError:
        return None, "Unrecognized time format. Use HH:MM, +N[m|h|s], -N[m|h|s], N[h][m][s], or epoch ms."
