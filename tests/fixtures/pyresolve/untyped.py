"""Annotations that say nothing: Any and object."""

from typing import Any


def handler(ev: Any, other: object) -> None:
    ev.msg.datapath.send_msg(1)
    other.close()
