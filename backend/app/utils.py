# SPDX-License-Identifier: GPL-3.0-or-later
from datetime import datetime, timezone


def utcnow() -> datetime:
    """Current UTC time as a naive datetime.

    The DB stores naive UTC timestamps; datetime.utcnow() is deprecated, so this
    is the one place that knows how to produce a compatible "now".
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)
