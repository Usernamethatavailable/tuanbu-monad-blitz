"""Local preview and public demo. Payment, refund and supplier activity are simulated."""

import argparse
import hashlib
import json
import os
import re
import secrets
import sqlite3
import tempfile
import time
from contextlib import closing
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from roles_service import ApiError, act, create_group, init_db
from journey_service import act_journey, create_journey, init_journey_db, read_journey
from shop_service import act_shop, create_shop, init_shop_db, read_shop, progress_shop
from shop_ledger import AnchorWriter, attach_anchors, init_ledger


ROOT = Path(__file__).resolve().parent
DEFAULT_DB = Path(tempfile.gettempdir()) / "monad-blitz-preview" / "groups-v1.sqlite3"
STATIC = {
    "/": ("shop.html", "text/html; charset=utf-8"),
    "/index.html": ("shop.html", "text/html; charset=utf-8"),
    "/shop.html": ("shop.html", "text/html; charset=utf-8"),
    "/shop.js": ("shop.js", "text/javascript; charset=utf-8"),
    "/shop.css": ("shop.css", "text/css; charset=utf-8"),
    "/ledger.js": ("ledger.js", "text/javascript; charset=utf-8"),
    "/trust.js": ("trust.js", "text/javascript; charset=utf-8"),
    "/journey.html": ("journey.html", "text/html; charset=utf-8"),
    "/journey.js": ("journey.js", "text/javascript; charset=utf-8"),
    "/journey.css": ("journey.css", "text/css; charset=utf-8"),
    "/roles.html": ("roles.html", "text/html; charset=utf-8"),
    "/roles.js": ("roles.js", "text/javascript; charset=utf-8"),
    "/roles.css": ("roles.css", "text/css; charset=utf-8"),
    "/assets/charm.webp": ("assets/charm.webp", "image/webp"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/assets/plush.webp": ("assets/plush.webp", "image/webp"),
}
PUBLIC_STATIC = frozenset({"/", "/index.html", "/shop.html", "/shop.js", "/shop.css",
                           "/ledger.js", "/journey.css", "/assets/plush.webp"})
GROUP_ROUTE = re.compile(r"/api/groups/([0-9a-f]{12})(?:/(join|receive))?")
ROLE_ROUTE = re.compile(r"/api/v3/groups/([0-9a-f]{12})(?:/(join|close|accept|ship|distribute|receive|dispute|refund|reship))?")
JOURNEY_ROUTE = re.compile(r"/api/v4/groups/([0-9a-f]{12})(?:/([a-z-]{1,30}))?")
SHOP_ROUTE = re.compile(r"/api/v5/groups/([0-9a-f]{12})(?:/([a-z-]{1,30}))?")
COOKIE = "tuanbu_preview"
SEED_COUNT = 4
PREPAYMENT = 88
MINIMUM = 3
DISCOUNT_THRESHOLD = 5
DISCOUNT_PRICE = 66


def open_preview_db(path, *, legacy=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as db, db:
        if legacy:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS groups (
                    id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, started_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS orders (
                    group_id TEXT NOT NULL REFERENCES groups(id), buyer TEXT NOT NULL,
                    joined_at INTEGER NOT NULL, received_at INTEGER, PRIMARY KEY(group_id, buyer)
                );
            """)
            init_db(db)
            init_journey_db(db)
        else:
            db.execute("PRAGMA journal_mode=WAL")
        init_shop_db(db)
        init_ledger(db)


def group_result(db, group_id, buyer, action, now):
    group = db.execute("SELECT * FROM groups WHERE id=?", (group_id,)).fetchone()
    if not group:
        raise ApiError(404, "not_found", "未找到这个演示团。")
    started = group["started_at"]
    elapsed = now - started if started is not None else -1
    closed = elapsed >= 20_000
    order = db.execute("SELECT * FROM orders WHERE group_id=? AND buyer=?", (group_id, buyer)).fetchone()
    count = SEED_COUNT + db.execute("SELECT COUNT(*) FROM orders WHERE group_id=?", (group_id,)).fetchone()[0]

    if action == "join" and not order:
        if closed:
            raise ApiError(409, "group_closed", "本团已截止，无法新增认购。")
        if started is None:
            started = now
            db.execute("UPDATE groups SET started_at=? WHERE id=?", (now, group_id))
        db.execute("INSERT INTO orders(group_id,buyer,joined_at) VALUES (?,?,?)", (group_id, buyer, now))
        count += 1
    elif action == "receive":
        if not order:
            raise ApiError(409, "not_joined", "只有本团已认购的买家可以签收。")
        if elapsed < 50_000 or count < MINIMUM:
            raise ApiError(409, "not_ready", "请等团长确认收到整批后再签收。")
        if order["received_at"] is None:
            db.execute("UPDATE orders SET received_at=? WHERE group_id=? AND buyer=?", (now, group_id, buyer))

    mine = db.execute("SELECT joined_at,received_at FROM orders WHERE group_id=? AND buyer=?", (group_id, buyer)).fetchone()
    return snapshot(group_id, started, now, mine, count)


def quote(count, closed):
    unit = DISCOUNT_PRICE if count >= DISCOUNT_THRESHOLD else PREPAYMENT
    if closed and count < MINIMUM:
        unit = 0
    return unit, PREPAYMENT - unit if closed else None


def snapshot(group_id, started, now, mine, count):
    elapsed = now - started if started is not None else -1
    closed = elapsed >= 20_000
    unit, due = quote(count, closed)
    formed = closed and count >= MINIMUM
    accepted = count if formed and elapsed >= 38_000 else None
    shipped = accepted is not None and elapsed >= 44_000
    arrived = shipped and elapsed >= 50_000
    received = mine is not None and mine["received_at"] is not None
    delivery = 3 if received else 2 if arrived else int(shipped)
    refund = "none"
    if due:
        refund = "paid" if elapsed >= 33_000 else "processing" if elapsed >= 27_000 else "due"
    has_order = mine is not None
    others = count - int(has_order)
    records = [
        ["11/21 17:30", "拼团单", "山涧布偶工坊", "SIM-GROUP-01", "工厂确认 V1 报价、收款方和交期。"],
        ["截止前", "付款登记", "模拟支付渠道", "SIM-PAY-BASE", f"其他团员合计 {others} 份有效实付，含预置的 4 份模拟订单。"],
    ]
    if has_order:
        records.append(["截止前", "我的付款", "模拟支付渠道", "SIM-PAY-ME", "向山涧布偶工坊模拟预付 ¥88，认购 1 份。"])
    events = (
        (20, "11/21 18:00", "截止计价", "模拟团单规则", "SIM-CLOSE-01", f"有效实付 {count} 份，{'已成团' if formed else '未达起订量'}，最终每份 ¥{unit}，每份应退 ¥{due}。"),
        (27, "11/21 18:02", "退款处理中", "模拟支付渠道", "SIM-REFUND-01", f"已受理本订单 ¥{due} 原路退款。"),
        (33, "11/21 18:08", "退款到账", "模拟支付渠道", "SIM-REFUND-02", f"本订单 ¥{due} 已原路退回。"),
        (38, "11/22 10:00", "生产单", "山涧布偶工坊", "SIM-PROD-01", f"演示工厂确认生产 {count} 份，与截止数量一致。"),
        (44, "12/08 14:30", "交付单 · 发货", "山涧布偶工坊", "SIM-SHIP-01", f"模拟工厂已将 {count} 份整批寄给团长。"),
        (50, "12/10 10:00", "交付单 · 整批签收", "团长栗子", "SIM-LEADER-01", "模拟团长已确认收到整批货品。"),
    )
    for seconds, *row in events:
        if elapsed < seconds * 1000 or (seconds in (27, 33) and not (has_order and due)):
            continue
        if seconds < 38 or formed:
            records.append(row)
    if received:
        records.append(["团长签收后", "交付单 · 单份签收", "我（演示团员）", "SIM-MEMBER-01", "本人确认收到 1 份。"])

    state = {"count": count, "mine": has_order, "closed": closed, "refund": refund if has_order else "none",
             "accepted": accepted, "delivery": delivery, "records": records, "unitPrice": unit, "duePerOrder": due,
             "paidAt": mine["joined_at"] if has_order else None, "receivedAt": mine["received_at"] if received else None}
    return {"id": group_id, "now": now, "startedAt": started, "state": state}


class PreviewHandler(BaseHTTPRequestHandler):
    timeout = 10

    def log_message(self, format, *args):
        # Polling is frequent. Keep buyer sessions and group IDs out of access logs.
        pass

    def send_body(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if self.server.public_origin:
            self.send_header("Referrer-Policy", "same-origin")
            self.send_header("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'none'; object-src 'none'")
        if getattr(self, "new_cookie", None):
            protection = "SameSite=Lax; Secure" if self.server.public_origin else "SameSite=Strict"
            self.send_header("Set-Cookie", f"{COOKIE}={self.new_cookie}; Path=/; Max-Age=2592000; HttpOnly; {protection}")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, value):
        self.send_body(status, json.dumps(value, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def buyer(self):
        cookies = SimpleCookie()
        try:
            cookies.load(self.headers.get("Cookie", ""))
        except CookieError:
            pass
        session = cookies[COOKIE].value if COOKIE in cookies else ""
        if not re.fullmatch(r"[0-9a-f]{64}", session):
            session = self.new_cookie = secrets.token_hex(32)
        return hashlib.sha256(session.encode()).hexdigest()

    def do_GET(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch()

    def json_object(self):
        try:
            size = int(self.headers.get("Content-Length", 0))
            if not 0 <= size <= 8192 or self.headers.get("Transfer-Encoding") is not None:
                raise ValueError
            value = json.loads(self.rfile.read(size)) if size else {}
            if not isinstance(value, dict):
                raise ValueError
            return value
        except (ValueError, UnicodeError):
            raise ApiError(400, "invalid_request", "请检查提交的订单信息。") from None

    def shop_request(self, url, write):
        create = url.path == "/api/v5/groups" and write
        match = SHOP_ROUTE.fullmatch(url.path)
        if not create and (not match or bool(match[2]) != write):
            raise ApiError(404, "not_found", "未找到这个团单操作。")
        role = parse_qs(url.query).get("role", ["buyer"])[0]
        if role not in ("buyer", "leader", "factory"):
            raise ApiError(400, "invalid_role", "请选择有效身份。")
        buyer = self.buyer()
        payload = self.json_object() if write else {}
        payload["viewRole"] = role
        with closing(sqlite3.connect(self.server.db_path, timeout=8)) as db, db:
            db.row_factory = sqlite3.Row
            if not create:
                # Settle due fixture actions even if the following customer's own
                # request fails. Their payment/receipt always has its own transaction.
                db.execute("BEGIN IMMEDIATE")
                progress_shop(db, match[1], int(time.time()))
                db.commit()
            db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            if create:
                result = create_shop(db, buyer, int(time.time()), payload)
            elif write:
                result = act_shop(db, match[1], buyer, match[2], payload, int(time.time()))
            else:
                result = read_shop(db, match[1], buyer, role)
            attach_anchors(db, result, self.server.chain_config)
        if write:
            self.server.anchors.wake.set()
        self.send_json(201 if create else 200, result)

    def journey_request(self, path, write):
        create = path == "/api/v4/groups" and write
        match = JOURNEY_ROUTE.fullmatch(path)
        if not create and (not match or bool(match[2]) != write):
            raise ApiError(404, "not_found", "未找到这个团单操作。")
        buyer = self.buyer()
        payload = self.json_object() if write else {}
        with closing(sqlite3.connect(self.server.db_path, timeout=8)) as db, db:
            db.row_factory = sqlite3.Row
            db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            now = int(time.time())
            if create:
                result = create_journey(db, buyer, now, payload)
            elif write:
                result = act_journey(db, match[1], buyer, match[2], payload, now)
            else:
                result = read_journey(db, match[1], buyer)
        self.send_json(201 if create else 200, result)

    def role_request(self, path, write):
        create = path == "/api/v3/groups" and write
        match = ROLE_ROUTE.fullmatch(path)
        if not create and (not match or bool(match[2]) != write):
            raise ApiError(404, "not_found", "未找到这个团单操作。")
        payload = self.json_object() if write else {}
        buyer = self.buyer()
        with closing(sqlite3.connect(self.server.db_path, timeout=8)) as db, db:
            db.row_factory = sqlite3.Row
            db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            now = time.time_ns() // 1_000_000
            if create:
                seeds = payload.get("seedCount", 4)
                if type(seeds) is not int or seeds not in (1, 3, 4):
                    raise ApiError(400, "invalid_seed", "请选择可用的体验团。")
                result = create_group(db, buyer, now, seed_count=seeds)
            else:
                group_id, action = match.groups()
                result = act(db, group_id, buyer, action or "read", payload, now)
        self.send_json(201 if create else 200, result)

    def dispatch(self):
        try:
            url = urlsplit(self.path)
            path = url.path
            write = self.command == "POST"
            public_origin = self.server.public_origin
            if public_origin and not write and path == "/api/health":
                # Managed load balancers can probe the service with an internal Host.
                self.send_json(200, {"ok": True, "version": 5})
                return
            hosts = self.headers.get_all("Host", [])
            host = hosts[0].lower() if len(hosts) == 1 else ""
            expected_origin = public_origin or f"http://{host}"
            valid_host = (host == self.server.public_host if public_origin else
                          re.fullmatch(r"(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?", host))
            origins = self.headers.get_all("Origin", [])
            if not valid_host or (write and (public_origin or origins) and
                                  [origin.lower() for origin in origins] != [expected_origin]):
                raise ApiError(403, "wrong_origin", "请从团簿演示页面操作。")
            if not write and path == "/api/health":
                self.send_json(200, {"ok": True, "version": 5})
                return
            if path == "/api/v5/groups" or path.startswith("/api/v5/groups/"):
                self.shop_request(url, write)
                return
            if public_origin and (write or path not in PUBLIC_STATIC):
                raise ApiError(404, "not_found", "未找到这个演示入口。")
            if path == "/api/v4/groups" or path.startswith("/api/v4/groups/"):
                self.journey_request(path, write)
                return
            if path == "/api/v3/groups" or path.startswith("/api/v3/groups/"):
                self.role_request(path, write)
                return
            if not write and path in STATIC:
                file_name, content_type = STATIC[path]
                if not public_origin and path in ("/", "/index.html"):
                    query = parse_qs(url.query)
                    if "team" in query:
                        file_name = "roles.html"
                    elif "journey" in query:
                        file_name = "journey.html"
                    elif "g" in query or "case" in query:
                        file_name = "index.html"
                if file_name.endswith(".html"):
                    self.buyer()
                try:
                    content = (ROOT / file_name).read_bytes()
                except FileNotFoundError:
                    raise ApiError(404, "not_found", "未找到这个预览文件。") from None
                self.send_body(200, content, content_type)
                return

            create = write and path == "/api/groups"
            match = GROUP_ROUTE.fullmatch(path)
            if not create and (not match or bool(match[2]) != write):
                raise ApiError(404, "not_found", "未找到这个演示入口。")
            buyer = self.buyer()
            with closing(sqlite3.connect(self.server.db_path, timeout=8)) as db, db:
                db.row_factory = sqlite3.Row
                db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
                now = time.time_ns() // 1_000_000
                if create:
                    group_id = secrets.token_hex(6)
                    db.execute("INSERT INTO groups(id,created_at) VALUES (?,?)", (group_id, now))
                    action = None
                else:
                    group_id, action = match.groups()
                result = group_result(db, group_id, buyer, action, now)
            self.send_json(201 if create else 200, result)
        except ApiError as exc:
            self.send_json(exc.status, {"error": str(exc), "code": exc.code})
        except sqlite3.Error:
            self.send_json(503, {"error": "演示数据暂时不可用，请重试。", "code": "storage_unavailable"})


def make_server(port, db_path, *, public_origin=None, chain_config=None, host=None):
    public_host = None
    if public_origin:
        parsed = urlsplit(public_origin)
        if (parsed.scheme != "https" or parsed.path not in ("", "/") or parsed.query or parsed.fragment
                or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[1-9][0-9]{0,4})?", parsed.netloc)
                or parsed.port is not None and parsed.port > 65535):
            raise ValueError("TUANBU_PUBLIC_ORIGIN must be an HTTPS origin without a path")
        public_host = parsed.hostname if parsed.port in (None, 443) else parsed.netloc.lower()
        public_origin = "https://" + public_host
        if chain_config is None:
            raise ValueError("Public demo requires Monad Testnet configuration")
        if db_path.resolve() == DEFAULT_DB.resolve():
            raise ValueError("Public demo requires a separate persistent TUANBU_DB")
    open_preview_db(db_path, legacy=public_origin is None)
    httpd = ThreadingHTTPServer((host or ("0.0.0.0" if public_origin else "127.0.0.1"), port), PreviewHandler)
    httpd.db_path = db_path
    httpd.public_origin = public_origin
    httpd.public_host = public_host
    httpd.chain_config = chain_config
    httpd.anchors = AnchorWriter(db_path, chain_config)
    httpd.anchors.start()
    return httpd


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int)
    parser.add_argument("--db", type=Path)
    parser.add_argument("--monad", action="store_true", help="Use Monad Testnet for loopback verification")
    args = parser.parse_args()
    public_origin = os.environ.get("TUANBU_PUBLIC_ORIGIN")
    db_path = args.db or (Path(os.environ["TUANBU_DB"]) if os.environ.get("TUANBU_DB") else None)
    if public_origin and db_path is None:
        parser.error("Public demo requires TUANBU_DB on a persistent volume")
    chain_config = None
    try:
        if public_origin or args.monad:
            from shop_ledger import load_monad_config
            chain_config = load_monad_config()
        port = args.port if args.port is not None else int(os.environ.get("PORT", 8422) if public_origin else 8422)
        server = make_server(port, db_path or DEFAULT_DB, public_origin=public_origin, chain_config=chain_config)
    except (ValueError, OSError, sqlite3.Error, RuntimeError) as exc:
        parser.error(str(exc))
    with server:
        print(server.public_origin or f"Local preview: http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.anchors.stopping.set()
            server.anchors.wake.set()
            server.anchors.join(timeout=3)
