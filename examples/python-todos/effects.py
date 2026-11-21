"""Report side effects to gerra from a Python service: the x-gerra-effects protocol in a few lines.

gerra sends `x-gerra-effects: 1` on requests it records or replays. Collect what the request did and,
when it asked, send the list back as `x-gerra-effects: <base64url of the JSON array>`.
"""
import base64
import json

HEADER = "x-gerra-effects"


class Effects:
    def __init__(self, request_headers):
        self.enabled = request_headers.get(HEADER) == "1"
        self.items = []

    def record(self, effect):
        if self.enabled:
            self.items.append(effect)

    def send_header(self, handler):
        if self.enabled:
            value = base64.urlsafe_b64encode(json.dumps(self.items).encode("utf-8")).decode("ascii").rstrip("=")
            handler.send_header(HEADER, value)
