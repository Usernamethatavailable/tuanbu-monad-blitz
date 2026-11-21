import http.client
import io
import json
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import preview_server


ORIGIN = "https://demo.tuanbu.example"
HOST = "demo.tuanbu.example"


@contextmanager
def running(db_path, public_origin=None):
    # Isolate chain calls. Exercise the actual HTTP and SQLite layers.
    local_anchors = preview_server.attach_anchors
    with patch.object(preview_server, "AnchorWriter"), patch.object(
        preview_server, "attach_anchors", side_effect=lambda db, data, *_: local_anchors(db, data)
    ):
        options = {"public_origin": public_origin, "chain_config": object(), "host": "127.0.0.1"} if public_origin else {}
        with preview_server.make_server(0, db_path, **options) as server:
            yield server


class BufferedConnection:
    def __init__(self, incoming):
        self.incoming = incoming
        self.outgoing = bytearray()

    def makefile(self, *_args):
        return io.BytesIO(self.incoming)

    def sendall(self, data):
        self.outgoing.extend(data)

    def settimeout(self, _seconds):
        pass


def request(server, path, *, host=HOST, origin=None, data=None, cookie=None, raw=None):
    headers = {"Host": host}
    if cookie:
        headers["Cookie"] = cookie
    if origin:
        headers["Origin"] = origin
    body = json.dumps(data) if data is not None else raw
    if body is not None:
        headers.update({"Content-Type": "application/json", "Content-Length": str(len(body.encode()))})
    method = "POST" if body is not None else "GET"
    message = "\r\n".join([f"{method} {path} HTTP/1.1", *(f"{k}: {v}" for k, v in headers.items()), "", body or ""])
    conn = BufferedConnection(message.encode())
    preview_server.PreviewHandler(conn, ("127.0.0.1", 10000), server)
    with http.client.HTTPResponse(BufferedConnection(conn.outgoing)) as reply:
        reply.begin()
        content = reply.read()
        if reply.headers["Content-Type"].startswith("application/json"):
            content = json.loads(content)
        return reply.status, reply.headers, content


class HostingTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.db = Path(directory.name) / "groups.sqlite3"

    def test_public_has_canonical_host_and_exposes_current_app(self):
        with running(self.db, ORIGIN) as port:
            self.assertEqual(request(port, "/api/health", host="internal")[:1], (200,))
            self.assertEqual(request(port, "/shop.html", host="foreign.example")[0], 403)
            status, headers, body = request(port, "/shop.html")
            self.assertEqual(status, 200)
            self.assertIn("团簿", body.decode())
            self.assertIn("Secure", headers["Set-Cookie"])
            self.assertIn("HttpOnly", headers["Set-Cookie"])
            self.assertEqual(request(port, "/assets/plush.webp")[0], 200)
            self.assertEqual(request(port, "/journey.html")[0], 404)
            self.assertEqual(request(port, "/api/v4/groups", data={}, origin=ORIGIN)[0], 404)

    def test_public_writes_require_same_origin_and_preserve_ownership_after_restart(self):
        with running(self.db, ORIGIN) as port:
            create = "/api/v5/groups?role=leader"
            self.assertEqual(request(port, create, data={})[0], 403)
            self.assertEqual(request(port, create, data={}, origin="https://foreign.example")[0], 403)
            self.assertEqual(request(port, create, raw=" " * 8193, origin=ORIGIN)[0], 400)
            status, headers, group = request(port, create, data={"seedCount": 0}, origin=ORIGIN)
            self.assertEqual(status, 201)
            cookie = headers["Set-Cookie"].split(";", 1)[0]
        with running(self.db, ORIGIN) as port:
            group_path = "/api/v5/groups/" + group["id"]
            self.assertTrue(request(port, group_path, cookie=cookie)[2]["canManage"])
            self.assertFalse(request(port, group_path)[2]["canManage"])
            self.assertEqual(request(port, group_path + "/propose?role=leader",
                                     data={"quantity": 100}, origin=ORIGIN)[0], 403)
            self.assertEqual(request(port, group_path + "/propose?role=leader", cookie=cookie,
                                     data={"quantity": 100}, origin=ORIGIN)[0], 200)

    def test_local_preview_remains_available(self):
        with running(self.db) as port:
            local = f"127.0.0.1:{port.server_port}"
            status, headers, _ = request(port, "/journey.html", host=local)
            self.assertEqual(status, 200)
            self.assertNotIn("Secure", headers["Set-Cookie"])
            self.assertEqual(request(port, "/api/v5/groups", host=local, data={})[0], 201)


if __name__ == "__main__":
    unittest.main()
