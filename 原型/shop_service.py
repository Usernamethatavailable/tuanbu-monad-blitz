"""Local v5 multi-SKU prototype. The caller wraps writes in one SQLite transaction."""

import hashlib
import json
import re
import secrets
import time
from collections import Counter, defaultdict

from journey_service import (DISCOUNT_AT, FEE, FULL_PRICE, LEAD_DAYS, MINIMUM, PHASES,
                             PREPAID, REASONS, fail, round_number, selection, short_text, tier)


CATALOG = {
    "bear": {"sku": "bear", "name": "栗栗熊", "size": "20 cm", "color": "奶油棕"},
    "rabbit": {"sku": "rabbit", "name": "绒绒兔", "size": "20 cm", "color": "奶油白"},
}
RECIPIENTS = [
    {"id": "cloud", "name": "林知夏", "address": "江澜市清河区青梧路38号栖园小区"},
    {"id": "leaf", "name": "周青禾", "address": "青屿市安宁区玉兰路16号听雨里"},
    {"id": "moon", "name": "许星宁", "address": "临溪市云溪区星桥路72号晴川苑"},
]
SURNAMES = ("沈", "陈", "陆", "林", "刘", "周", "苏", "张", "王", "徐", "姚", "梁", "郑", "李", "吴", "许", "孙")
GIVEN_NAMES = ("子宁", "禾", "一诺", "晨予", "晚晴", "思齐", "文清", "安", "亦然", "予禾", "晓筠", "嘉树", "景明")
REJECT_REASONS = ("缺料", "面料缺货", "配件缺货", "产能不足", "无法按期交货")
BATCH_REASONS = ("整箱少件", "批量质量问题", "整箱破损", "款式或数量不符")
BATCH_WINDOW = 48 * 3600
SEED_BUY_WINDOW = 20
TRANSITIONS = {
    "propose": ("draft", "proposed", "团长", "提交开团提案"),
    "quote": ("proposed", "quoted", "工厂", "签署两款商品报价"),
    "publish": ("quoted", "open", "团长", "公开报名"),
    "submit-production": ("open", "submitted", "团长", "汇总报名并提交生产单"),
    "start": ("pay_closed", "started", "工厂", "按已付款清单开工"),
    "ship": ("started", "shipped", "工厂", "整箱发货"),
    "receive-batch": ("shipped", "batch_received", "团长", "整箱签收入库"),
}


def init_shop_db(db):
    statements = [
        """CREATE TABLE IF NOT EXISTS shop_groups(id TEXT PRIMARY KEY,creator TEXT NOT NULL,seed_count INTEGER NOT NULL,
               phase TEXT NOT NULL,target_count INTEGER NOT NULL,unit INTEGER,closed_at INTEGER,
               carrier TEXT,tracking TEXT,shipped_at INTEGER)""",
        """CREATE TABLE IF NOT EXISTS shop_skus(gid TEXT NOT NULL,sku TEXT NOT NULL,decision TEXT NOT NULL DEFAULT 'pending',
               reason TEXT NOT NULL DEFAULT '',PRIMARY KEY(gid,sku))""",
        """CREATE TABLE IF NOT EXISTS shop_orders(gid TEXT NOT NULL,id TEXT NOT NULL,buyer TEXT,recipient TEXT NOT NULL,
               distributed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'registered',reason TEXT,
               round INTEGER NOT NULL DEFAULT 0,resolution TEXT,PRIMARY KEY(gid,id),UNIQUE(gid,buyer))""",
        """CREATE TABLE IF NOT EXISTS shop_items(gid TEXT NOT NULL,oid TEXT NOT NULL,sku TEXT NOT NULL,qty INTEGER NOT NULL,
               paid INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(gid,oid,sku))""",
        """CREATE TABLE IF NOT EXISTS shop_events(group_id TEXT NOT NULL,seq INTEGER NOT NULL,event_id TEXT NOT NULL UNIQUE,
               public_json TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(group_id,seq))""",
        """CREATE TABLE IF NOT EXISTS shop_claims(gid TEXT NOT NULL,oid TEXT NOT NULL,number INTEGER NOT NULL,
               reason TEXT NOT NULL,note TEXT NOT NULL,reply TEXT,created INTEGER NOT NULL,answered INTEGER,closed INTEGER,
               PRIMARY KEY(gid,oid,number),UNIQUE(gid,oid,reason,note))""",
        """CREATE TABLE IF NOT EXISTS shop_pay_requests(gid TEXT NOT NULL,oid TEXT NOT NULL,request_id TEXT NOT NULL,
               cart TEXT NOT NULL,PRIMARY KEY(gid,oid,request_id))""",
        """CREATE TABLE IF NOT EXISTS shop_batch_issues(gid TEXT NOT NULL,number INTEGER NOT NULL,reason TEXT NOT NULL,
               qty INTEGER NOT NULL,opened INTEGER NOT NULL,deadline INTEGER NOT NULL,status TEXT NOT NULL,
               resolved INTEGER,PRIMARY KEY(gid,number))""",
    ]
    for statement in statements:
        db.execute(statement)
    columns = {"shop_groups": [("arrived_at", "INTEGER")],
               "shop_skus": [("stock_cap", "INTEGER"), ("seed_due", "INTEGER")],
               "shop_items": [("paid_qty", "INTEGER NOT NULL DEFAULT 0"), ("seed_attempted", "INTEGER NOT NULL DEFAULT 0")],
               "shop_orders": [("seed_receive_at", "INTEGER")],
               "shop_batch_issues": [("proposal", "TEXT"), ("proposed_by", "TEXT")]}
    for table, fields in columns.items():
        existing = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
        for name, definition in fields:
            if name not in existing:
                db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
    # Older installations can have the column without the data backfill. The old
    # paid flag denotes full payment of this SKU, never a partially paid line.
    db.execute("UPDATE shop_items SET paid_qty=qty WHERE paid=1 AND paid_qty=0 AND qty>0")
    db.execute("""UPDATE shop_orders SET seed_receive_at=? WHERE buyer IS NULL AND distributed=1
                  AND status='paid' AND seed_receive_at IS NULL""", (int(time.time()) + 2,))
    refresh_old_sample_recipients(db)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def shipment_commitment(carrier, tracking):
    proof = canonical({"carrier": carrier, "trackingNumber": tracking})
    return "0x" + hashlib.sha256(proof.encode("utf-8")).hexdigest()


def log_event(db, gid, now, action, role, title, detail, *, oid=None, items=None, amounts=None, data=None):
    seq = db.execute("SELECT COALESCE(MAX(seq),0)+1 FROM shop_events WHERE group_id=?", (gid,)).fetchone()[0]
    event_id = f"{gid}-{seq:05d}"
    items = items or []
    public = {"schema": "tuanbu.shop.v5", "id": event_id, "groupId": gid, "at": now, "role": role,
              "action": action, "title": title, "detail": detail, "orderId": oid, "items": items,
              "quantity": sum(i["qty"] for i in items), "amounts": amounts or {}, "data": data or {}}
    encoded = canonical(public)
    digest = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    db.execute("INSERT INTO shop_events VALUES(?,?,?,?,?)", (gid, seq, event_id, encoded, digest))


def group_row(db, gid):
    group = db.execute("SELECT * FROM shop_groups WHERE id=?", (gid,)).fetchone()
    if not group:
        fail("not_found", "未找到这个演示团。", 404)
    return group


def lines(mapping):
    return [{"sku": sku, "qty": mapping[sku]} for sku in CATALOG if mapping.get(sku, 0)]


def items_total(receipts):
    quantities = Counter()
    for receipt in receipts:
        for item in receipt["items"]:
            quantities[item["sku"]] += item["qty"]
    return lines(quantities)


def receipts(db, gid, *, paid=False):
    rows = db.execute("""SELECT oid,sku,CASE WHEN ? THEN paid_qty ELSE qty END qty FROM shop_items
                         WHERE gid=? AND (?=0 OR paid_qty>0) ORDER BY oid,sku""", (paid, gid, paid))
    by_order = defaultdict(list)
    for row in rows:
        by_order[row["oid"]].append({"sku": row["sku"], "qty": row["qty"]})
    return [{"orderId": oid, "items": items, "quantity": sum(i["qty"] for i in items)} for oid, items in by_order.items()]


def create_shop(db, buyer, now, payload):
    seeds = payload.get("seedCount", 99) if isinstance(payload, dict) else None
    if type(seeds) is not int or not 0 <= seeds <= 199:
        fail("invalid_seed", "可设置 0 至 199 个模拟报名人。", 400)
    gid = secrets.token_hex(6)
    db.execute("INSERT INTO shop_groups(id,creator,seed_count,phase,target_count) VALUES(?,?,?,'draft',100)", (gid, buyer, seeds))
    db.executemany("INSERT INTO shop_skus(gid,sku) VALUES(?,?)", ((gid, sku) for sku in CATALOG))
    return read_shop(db, gid, buyer)


def add_order(db, gid, oid, buyer, recipient, items):
    db.execute("INSERT INTO shop_orders(gid,id,buyer,recipient) VALUES(?,?,?,?)", (gid, oid, buyer, canonical(recipient)))
    db.executemany("INSERT INTO shop_items(gid,oid,sku,qty) VALUES(?,?,?,?)", ((gid, oid, i["sku"], i["qty"]) for i in items))


def recipient_options(gid, buyer):
    number = int.from_bytes(hashlib.sha256(f"{gid}/{buyer}".encode()).digest()[:6], "big")
    return [sample_recipient(sample, number + i * 713, i + 101) for i, sample in enumerate(RECIPIENTS)]


def sample_recipient(sample, number, phone_end):
    building = number % 18 + 1
    room = (number // 18 % 23 + 1) * 100 + number // 414 % 8 + 1
    return {**sample, "phone": f"000-{number % 10000:04}-{phone_end:04}",
            "address": f"{sample['address']}{building}栋{room}室"}


def seed_recipient(number):
    sample = RECIPIENTS[(number - 1) % len(RECIPIENTS)]
    generated = sample_recipient(sample, number * 719, number)
    generated.pop("id")
    generated["name"] = SURNAMES[(number - 1) % len(SURNAMES)] + GIVEN_NAMES[(number * 7) % len(GIVEN_NAMES)]
    return generated


def refresh_old_sample_recipients(db):
    # Only translate the two exact kinds of placeholders generated by previous builds.
    rows = db.execute("SELECT gid,id,buyer,recipient FROM shop_orders WHERE recipient LIKE '%演示市%'").fetchall()
    labels = {"cloud": ("小云", "云朵", 1), "leaf": ("小叶", "树叶", 2), "moon": ("小月", "月光", 3)}
    for gid, oid, buyer, encoded in rows:
        old = json.loads(encoded)
        if buyer is None:
            number = int(oid.split("-")[1])
            expected = {"name": f"演示拼友{number:03}", "phone": f"000-0000-{number:04}", "address": f"演示市样品区虚构街 {number} 号"}
            if old != expected:
                continue
            updated = seed_recipient(number)
        elif old.get("id") in labels:
            key = old["id"]
            label, area, n = labels[key]
            suffix = hashlib.sha256(f"{gid}/{buyer}".encode()).hexdigest()[:6].upper()
            expected = {"id": key, "name": f"演示拼友{label}·{suffix}", "phone": f"000-{int(suffix,16)%10000:04}-{100+n:04}",
                        "address": f"演示市{area}区样品路 {n} 号 · 演示室 {suffix}"}
            if old != expected:
                continue
            updated = next(p for p in recipient_options(gid, buyer) if p["id"] == key)
        else:
            continue
        db.execute("UPDATE shop_orders SET recipient=? WHERE gid=? AND id=?", (canonical(updated), gid, oid))


def confirmed_recipient(gid, buyer, payload):
    base_id = payload.get("recipientId", RECIPIENTS[0]["id"])
    person = next((p for p in recipient_options(gid, buyer) if p["id"] == base_id), None)
    edits = payload.get("recipient", {})
    if person is None or not isinstance(edits, dict):
        fail("invalid_recipient", "请核对收件资料。", 400)
    for field, label, minimum, maximum in (("name", "收件人", 1, 40), ("address", "收货地址", 2, 160), ("phone", "联系电话", 7, 32)):
        value = edits.get(field, person[field])
        if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum or not value.isprintable():
            fail("invalid_recipient", f"请填写有效的{label}。", 400)
        person[field] = value.strip()
    phone = person["phone"]
    digits = re.sub(r"[^0-9]", "", phone)
    if not re.fullmatch(r"[+]?[0-9()（） -]+", phone) or not 7 <= len(digits) <= 16:
        fail("invalid_recipient", "请填写有效的手机号或座机号码。", 400)
    return person


def seed_orders(db, g, now):
    gid = g["id"]
    for n in range(1, g["seed_count"] + 1):
        recipient = seed_recipient(n)
        items = [{"sku": "bear", "qty": 1}]
        if n <= 6:
            items.append({"sku": "rabbit", "qty": 1})
        add_order(db, gid, f"DD-{n:03}", None, recipient, items)
    if g["seed_count"]:
        batches = receipts(db, gid)
        log_event(db, gid, now, "respond-seed", "拼友", "模拟拼友报名", "预置订单仅报名，尚未扣款。",
                  items=items_total(batches), data={"orders": batches})


def named_text(payload, key, maximum):
    val = payload.get(key)
    if not isinstance(val, str) or not val.strip() or len(val) > maximum or any(ord(c) < 32 for c in val):
        fail("invalid_text", "请填写有效的" + {"carrier": "物流公司", "trackingNumber": "物流单号", "reason": "拒接原因"}[key] + "。", 400)
    return val.strip()


def transition(db, g, action, payload, now):
    gid, phase = g["id"], g["phase"]
    source, target, role, title = TRANSITIONS[action]
    if phase in ("failed", "batch_refunded"):
        if action in ("propose", "quote", "publish", "submit-production"):
            return
        fail("not_formed", "本团未成团，不能继续生产或交付。")
    if PHASES.index(phase) >= PHASES.index(target):
        return
    if phase != source:
        fail("wrong_phase", "请先完成前一业务步骤。")
    if action == "receive-batch":
        if is_batch_paused(db, gid):
            fail("batch_paused", "整箱异议处理中，请先完成协商。")
        register_arrival(db, g, now)
    data = {}
    if action == "propose":
        target_count = payload.get("targetCount", g["target_count"])
        if type(target_count) is not int or not 1 <= target_count <= 10000:
            fail("invalid_target", "目标个数须为 1 至 10000 的整数。", 400)
        db.execute("UPDATE shop_groups SET target_count=? WHERE id=?", (target_count, gid))
        data = {"targetCount": target_count, "catalog": list(CATALOG.values())}
    if action == "quote":
        data = {"catalog": list(CATALOG.values()), "minimum": MINIMUM, "discountThreshold": DISCOUNT_AT,
                "goodsPrepay": FULL_PRICE, "discountPrice": 66, "leaderFeePerItem": FEE, "shipWithinDays": LEAD_DAYS}
    if action == "ship":
        carrier = named_text(payload, "carrier", 40)
        tracking = named_text(payload, "trackingNumber", 64)
        db.execute("UPDATE shop_groups SET carrier=?,tracking=?,shipped_at=? WHERE id=?", (carrier, tracking, now, gid))
        data["shipmentCommitment"] = shipment_commitment(carrier, tracking)
    relevant = receipts(db, gid, paid=action != "submit-production") if action in ("submit-production", "start", "ship", "receive-batch") else []
    if relevant:
        data["orders"] = relevant
    db.execute("UPDATE shop_groups SET phase=? WHERE id=?", (target, gid))
    log_event(db, gid, now, action, role, title, title + "。", items=items_total(relevant), data=data)
    if action == "publish":
        seed_orders(db, g, now)


def signup(db, g, buyer, payload, now):
    gid = g["id"]
    existing = db.execute("SELECT id FROM shop_orders WHERE gid=? AND buyer=?", (gid, buyer)).fetchone()
    if existing:
        return
    if g["phase"] != "open":
        fail("not_open", "仅可在招募期间报名。")
    selected = payload.get("items")
    if not isinstance(selected, list) or not 1 <= len(selected) <= len(CATALOG):
        fail("invalid_items", "请至少选择一个款式。", 400)
    qtys = {}
    for item in selected:
        if not isinstance(item, dict):
            fail("invalid_items", "款式参数无效。", 400)
        sku, qty = item.get("sku"), item.get("qty")
        if not isinstance(sku, str) or sku not in CATALOG or sku in qtys or type(qty) is not int or not 1 <= qty <= 999:
            fail("invalid_items", "每款只选一次，数量为 1 至 999 的整数。", 400)
        qtys[sku] = qty
    person = confirmed_recipient(gid, buyer, payload)
    n = db.execute("SELECT COUNT(*)+1 FROM shop_orders WHERE gid=?", (gid,)).fetchone()[0]
    oid = f"DD-{n:03}"
    items = lines(qtys)
    add_order(db, gid, oid, buyer, person, items)
    log_event(db, gid, now, "respond", "拼友", "提交购物清单报名", f"{oid} 已报名，未付款。", oid=oid, items=items)


def pay_lines(db, gid, rows, now, seed=False):
    blocks = defaultdict(list)
    for row in rows:
        blocks[row["oid"]].append({"sku": row["sku"], "qty": row["qty"]})
    if not blocks:
        return
    requested = Counter()
    for group_items in blocks.values():
        requested.update({i["sku"]: i["qty"] for i in group_items})
    stock = stock_left(db, gid)
    if any(stock[sku] is not None and qty > stock[sku] for sku, qty in requested.items()):
        fail("stock_short", "剩余库存不足，本次未扣款。请重新确认款式和数量。")
    batch = []
    for oid, group_items in blocks.items():
        qty = sum(i["qty"] for i in group_items)
        batch.append({"orderId": oid, "items": group_items, "quantity": qty,
                      "amounts": {"goodsPrepaid": FULL_PRICE * qty, "leaderFee": FEE * qty, "prepaid": PREPAID * qty}})
        db.executemany("UPDATE shop_items SET paid_qty=paid_qty+?,paid=(paid_qty+?=qty) WHERE gid=? AND oid=? AND sku=?",
                       ((i["qty"], i["qty"], gid, oid, i["sku"]) for i in group_items))
        db.execute("UPDATE shop_orders SET status='paid' WHERE gid=? AND id=?", (gid, oid))
    qty = sum(b["quantity"] for b in batch)
    log_event(db, gid, now, "pay-seed" if seed else "pay", "模拟支付渠道", "预置拼友模拟付款" if seed else "拼友模拟付款",
              f"{qty} 个共 ¥{PREPAID * qty} 进入工厂微信二级商户冻结余额。", oid=None if seed else batch[0]["orderId"],
              items=items_total(batch), amounts={"goodsPrepaid": FULL_PRICE * qty, "leaderFee": FEE * qty, "prepaid": PREPAID * qty}, data={"orders": batch})


def stock_left(db, gid):
    rows = db.execute("""SELECT s.sku,s.stock_cap-SUM(COALESCE(i.paid_qty,0)) remaining FROM shop_skus s
                         LEFT JOIN shop_items i ON i.gid=s.gid AND i.sku=s.sku WHERE s.gid=? GROUP BY s.sku""", (gid,))
    return {r["sku"]: r["remaining"] for r in rows}


def accept(db, g, payload, now):
    gid = g["id"]
    if g["phase"] in ("draft", "proposed", "quoted", "open"):
        fail("wrong_phase", "请先提交按款汇总的生产单。")
    decisions = payload.get("decisions")
    if not isinstance(decisions, list) or not 1 <= len(decisions) <= len(CATALOG):
        fail("invalid_decisions", "请选择要接单或拒接的款式。", 400)
    known = {r["sku"]: r for r in db.execute("SELECT * FROM shop_skus WHERE gid=?", (gid,))}
    requested, changed = set(), []
    for item in decisions:
        if not isinstance(item, dict):
            fail("invalid_decisions", "请按款式提交决定。", 400)
        sku, decision = item.get("sku"), item.get("decision")
        if not isinstance(sku, str) or sku not in known or sku in requested or decision not in ("accept", "reject"):
            fail("invalid_decisions", "未知款式、重复款式或接单决定无效。", 400)
        requested.add(sku)
        reason = named_text(item, "reason", 100) if decision == "reject" else ""
        cap = item.get("limit")
        if cap is not None and (decision != "accept" or type(cap) is not int or not 1 <= cap <= 999999):
            fail("invalid_limit", "接单限量须为正整数。", 400)
        old = known[sku]
        if old["decision"] == decision and old["reason"] == reason and old["stock_cap"] == cap:
            continue
        if old["decision"] != "pending" or g["closed_at"] is not None:
            fail("decision_locked", "已确认的款式决定不能修改。")
        changed.append((sku, decision, reason, cap))
    if not changed:
        return
    db.executemany("UPDATE shop_skus SET decision=?,reason=?,stock_cap=?,seed_due=? WHERE gid=? AND sku=?",
                   ((d, why, cap, now + SEED_BUY_WINDOW if cap is not None else None, gid, sku)
                    for sku, d, why, cap in changed))
    raw = db.execute("SELECT sku,SUM(qty) qty FROM shop_items WHERE gid=? GROUP BY sku", (gid,)).fetchall()
    counts = {row["sku"]:row["qty"] for row in raw}
    missing = db.execute("""SELECT 1 FROM shop_items i JOIN shop_skus s ON s.gid=i.gid AND s.sku=i.sku
                            WHERE i.gid=? AND s.decision='pending' LIMIT 1""", (gid,)).fetchone()
    if not missing:
        db.execute("UPDATE shop_groups SET phase='accepted' WHERE id=?", (gid,))
    public = [{"sku": sku, "decision": d, "quantity": counts.get(sku, 0), "limit": cap,
               "reason": why if why in REJECT_REASONS else "其他供货原因" if why else "",
               "reasonDigest": hashlib.sha256(why.encode("utf-8")).hexdigest() if why else None}
              for sku, d, why, cap in changed]
    log_event(db, gid, now, "accept", "工厂", "按款确认生产单", "工厂确认接单款式及供货情况。",
              items=lines({sku:counts.get(sku, 0) for sku, _, _, _ in changed}), data={"decisions": public})
    rows = db.execute("""SELECT i.oid,i.sku,i.qty-i.paid_qty qty FROM shop_items i JOIN shop_orders o ON o.gid=i.gid AND o.id=i.oid
                         JOIN shop_skus s ON s.gid=i.gid AND s.sku=i.sku
                         WHERE i.gid=? AND o.buyer IS NULL AND i.paid_qty<i.qty AND s.decision='accept'
                         AND s.stock_cap IS NULL ORDER BY i.oid,i.sku""", (gid,))
    pay_lines(db, gid, rows, now, seed=True)


def close_pay(db, g, now):
    gid = g["id"]
    if g["closed_at"] is not None:
        return
    if g["phase"] not in ("submitted", "accepted"):
        fail("wrong_phase", "请先截止报名并提交生产单。")
    registered = receipts(db, gid)
    decided = db.execute("SELECT 1 FROM shop_skus WHERE gid=? AND decision!='pending' LIMIT 1", (gid,)).fetchone()
    if registered and not decided:
        fail("wrong_phase", "请先由工厂审核款式。")
    pay_due_seeds(db, gid, now)
    paid = receipts(db, gid, paid=True)
    qty = sum(r["quantity"] for r in paid)
    formed = qty >= MINIMUM
    unit = tier(qty) if formed else 0
    db.execute("UPDATE shop_groups SET phase=?,unit=?,closed_at=? WHERE id=?", ("pay_closed" if formed else "failed", unit, now, gid))
    log_event(db, gid, now, "close-pay", "团长", "截止付款并按实付个数锁价",
              f"{len(paid)} 单实付 {qty} 个。" + (f"每个商品 ¥{unit}。" if formed else "未达起订量，取消本团。"),
              items=items_total(paid), amounts={"unitPrice": unit}, data={"paidOrderCount": len(paid), "orders": paid})
    refund_unit = FULL_PRICE - unit if formed else PREPAID
    if not formed:
        db.execute("UPDATE shop_orders SET status='refunded' WHERE gid=? AND status='paid'", (gid,))
    if paid and refund_unit:
        for order in paid:
            order["amounts"] = {"refunded": order["quantity"] * refund_unit}
        log_event(db, gid, now, "discount-refund" if formed else "failed-refund", "模拟支付渠道",
                  "阶梯退差到账" if formed else "流团退款到账", f"每个已付商品原路退 ¥{refund_unit}，共退 ¥{qty * refund_unit}。",
                  items=items_total(paid), amounts={"refunded": qty * refund_unit, "perItem": refund_unit}, data={"orders": paid})


def distribute(db, g, payload, now):
    gid = g["id"]
    if g["phase"] not in ("batch_received", "distributed"):
        fail("wrong_phase", "须先签收工厂整箱。")
    if is_batch_paused(db, gid):
        fail("batch_paused", "整箱异议处理中，分发已暂停。")
    shipments = receipts(db, gid, paid=True)
    chosen = selection(payload, {r["orderId"] for r in shipments})
    done = {r[0] for r in db.execute("SELECT id FROM shop_orders WHERE gid=? AND distributed=1", (gid,))}
    sending = [r for r in shipments if r["orderId"] in chosen - done]
    if not sending:
        return
    db.executemany("UPDATE shop_orders SET distributed=1,seed_receive_at=CASE WHEN buyer IS NULL THEN ? END WHERE gid=? AND id=?",
                   ((now + 2, gid, r["orderId"]) for r in sending))
    if len(done) + len(sending) == len(shipments):
        db.execute("UPDATE shop_groups SET phase='distributed' WHERE id=?", (gid,))
    log_event(db, gid, now, "distribute", "团长", "按收货清单分发", f"本次分发 {len(sending)} 笔订单，等待各拼友本人确认。",
              items=items_total(sending), data={"orders": sending})


def paid_items(db, gid, oid):
    return [dict(r) for r in db.execute("SELECT sku,paid_qty qty FROM shop_items WHERE gid=? AND oid=? AND paid_qty>0 ORDER BY sku", (gid, oid))]


def open_claim(db, g, order, payload, now):
    if order["status"] != "received":
        fail("not_received", "确认收货后可以申请人工售后。")
    reason, note = payload.get("reason"), short_text(payload, "note")
    if not isinstance(reason, str) or reason not in REASONS:
        fail("invalid_reason", "请选择售后原因。", 400)
    gid, oid = g["id"], order["id"]
    history = db.execute("SELECT * FROM shop_claims WHERE gid=? AND oid=? ORDER BY number", (gid, oid)).fetchall()
    if any(c["reason"] == reason and c["note"] == note for c in history):
        return
    if history and history[-1]["closed"] is None:
        fail("claim_open", "当前人工售后仍在处理。")
    number = len(history) + 1
    db.execute("INSERT INTO shop_claims(gid,oid,number,reason,note,created) VALUES(?,?,?,?,?,?)", (gid, oid, number, reason, note, now))
    log_event(db, gid, now, "manual-claim", "拼友", "申请人工售后", "提交人工售后，原结算记录保留。", oid=oid,
              items=paid_items(db, gid, oid), data={"claimId": number, "responsibleRole": REASONS[reason]})


def pay_order(db, g, oid, payload, now):
    gid = g["id"]
    records = db.execute("""SELECT i.sku,i.qty,i.paid_qty FROM shop_items i JOIN shop_skus s
                            ON s.gid=i.gid AND s.sku=i.sku WHERE i.gid=? AND i.oid=? AND s.decision='accept'""", (gid, oid))
    approved = {r["sku"]: r for r in records}
    key = payload.get("requestId")
    selected = payload.get("items")
    if key is not None and (not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,100}", key) or selected is None):
        fail("invalid_request_id", "付款请求须附有效编号及已确认的购物清单。", 400)
    if selected is None:
        if any(r["paid_qty"] for r in approved.values()):
            return
        selected = lines({sku: r["qty"] for sku, r in approved.items()})
        if not selected:
            fail("cannot_pay", "目前没有可付款的已接商品。")
    if not isinstance(selected, list) or not 1 <= len(selected) <= len(CATALOG):
        fail("invalid_payment_items", "请确认本次付款的款式和数量。", 400)
    cart = {}
    for item in selected:
        sku, qty = (item.get("sku"), item.get("qty")) if isinstance(item, dict) else (None, None)
        if not isinstance(sku, str) or sku not in approved or sku in cart or type(qty) is not int or not 1 <= qty <= approved[sku]["qty"]:
            fail("invalid_payment_items", "付款清单超出已报名且已接的款式或数量。", 400)
        cart[sku] = qty
    encoded = canonical(lines(cart))
    if key is not None:
        prior = db.execute("SELECT cart FROM shop_pay_requests WHERE gid=? AND oid=? AND request_id=?", (gid, oid, key)).fetchone()
        if prior and prior[0] != encoded:
            fail("request_conflict", "同一付款请求编号已用于其他清单。")
        if prior:
            return
    deltas = []
    for sku, qty in cart.items():
        row = approved[sku]
        delta = qty if key is not None else max(0, qty - row["paid_qty"])
        if delta > row["qty"] - row["paid_qty"]:
            fail("already_paid", "本次数量超过订单未付数量，请重新核对。")
        if delta:
            deltas.append({"oid": oid, "sku": sku, "qty": delta})
    if not deltas:
        return
    if g["phase"] not in ("submitted", "accepted"):
        fail("cannot_pay", "付款已截止。")
    pay_lines(db, gid, deltas, now)
    if key is not None:
        db.execute("INSERT INTO shop_pay_requests VALUES(?,?,?,?)", (gid, oid, key, encoded))


def settle_order(db, g, order, now, seed=False):
    gid, oid = g["id"], order["id"]
    if order["status"] == "received":
        return
    if not order["distributed"] or order["status"] not in ("paid", "reshipping") or is_batch_paused(db, gid):
        fail("wrong_status", "本单当前不能签收。")
    items = paid_items(db, gid, oid)
    qty = sum(i["qty"] for i in items)
    if not qty:
        fail("wrong_status", "本单没有实付商品。")
    db.execute("UPDATE shop_orders SET status='received' WHERE gid=? AND id=?", (gid, oid))
    title = "预置拼友模拟签收" if seed else "本人确认收货"
    log_event(db, gid, now, "receive-seed" if seed else "receive", "模拟拼友" if seed else "拼友", title,
              f"{oid} 已确认收到 {qty} 个。", oid=oid, items=items)
    log_event(db, gid, now, "settle-seed" if seed else "settle", "模拟支付渠道", "本单分账与解冻",
              f"本单服务费 ¥{qty*FEE} 分给团长，商品款 ¥{qty*g['unit']} 为工厂解冻。", oid=oid, items=items,
              amounts={"factoryPaid": qty * g["unit"], "leaderPaid": qty * FEE}, data={"unitPrice": g["unit"]})


def pay_due_seeds(db, gid, now):
    rows = db.execute("""SELECT i.oid,i.sku,i.qty-i.paid_qty qty FROM shop_items i JOIN shop_orders o
                         ON o.gid=i.gid AND o.id=i.oid JOIN shop_skus s ON s.gid=i.gid AND s.sku=i.sku
                         WHERE i.gid=? AND o.buyer IS NULL AND s.seed_due<=? AND i.seed_attempted=0
                         AND s.decision='accept' AND i.qty>i.paid_qty ORDER BY s.seed_due,i.oid,i.sku""", (gid, now))
    left = stock_left(db, gid)
    winners, attempted = [], []
    for row in rows:
        attempted.append((gid, row["oid"], row["sku"]))
        if row["qty"] <= left[row["sku"]]:
            winners.append(row)
            left[row["sku"]] -= row["qty"]
    db.executemany("UPDATE shop_items SET seed_attempted=1 WHERE gid=? AND oid=? AND sku=?", attempted)
    pay_lines(db, gid, winners, now, seed=True)


def register_arrival(db, g, now):
    if g["arrived_at"] is not None:
        return g["arrived_at"]
    db.execute("UPDATE shop_groups SET arrived_at=? WHERE id=?", (now, g["id"]))
    log_event(db, g["id"], now, "batch-arrived", "模拟物流", "登记整箱到货", "整箱到货，开始计算 48 小时验收期。",
              data={"arrivedAt": now, "deadlineAt": now + BATCH_WINDOW})
    return now


def latest_batch(db, gid):
    return db.execute("SELECT * FROM shop_batch_issues WHERE gid=? ORDER BY number DESC LIMIT 1", (gid,)).fetchone()


def is_batch_paused(db, gid):
    issue = latest_batch(db, gid)
    return bool(issue and issue["status"] == "open")


def batch_case(db, g, action, payload, now):
    gid = g["id"]
    issue = latest_batch(db, gid)
    if action == "batch-dispute":
        if payload.get("role", "团长") not in ("团长", "leader"):
            fail("wrong_role", "整箱验收异议由团长提交。", 403)
        reason, qty = payload.get("reason"), payload.get("quantity")
        if not isinstance(reason, str) or reason not in BATCH_REASONS or type(qty) is not int or qty < 1:
            fail("invalid_batch_issue", "请选择整箱异议原因并填写实际影响数量。", 400)
        if issue and issue["reason"] == reason and qty == issue["qty"]:
            return
        if issue and issue["status"] == "open":
            fail("batch_paused", "已有整箱异议正在协商。")
        distributed = db.execute("SELECT 1 FROM shop_orders WHERE gid=? AND distributed=1 LIMIT 1", (gid,)).fetchone()
        if g["phase"] not in ("shipped", "batch_received") or distributed:
            fail("wrong_phase", "请在整箱到货且开始分发前提出整箱异议。")
        all_qty = db.execute("SELECT SUM(paid_qty) FROM shop_items WHERE gid=?", (gid,)).fetchone()[0] or 0
        if qty > all_qty:
            fail("invalid_batch_issue", "异议数量超过本批实付件数。", 400)
        arrived = register_arrival(db, g, now)
        deadline = arrived + BATCH_WINDOW
        if now > deadline:
            fail("batch_window_closed", "整箱到货已超过约定的 48 小时验收期。")
        number = issue["number"] + 1 if issue else 1
        db.execute("""INSERT INTO shop_batch_issues(gid,number,reason,qty,opened,deadline,status)
                      VALUES(?,?,?,?,?,?,'open')""", (gid, number, reason, qty, now, deadline))
        log_event(db, gid, now, action, "团长", "提交整箱验收异议", "暂停整批分发与未结款项。",
                  data={"caseId": number, "reason": reason, "affectedQuantity": qty, "deadlineAt": deadline})
        return
    role = {"factory": "工厂", "leader": "团长"}.get(payload.get("role"), payload.get("role"))
    if role not in ("工厂", "团长"):
        fail("wrong_role", "请以工厂或团长身份确认整箱处理方案。", 403)
    if not issue:
        fail("no_batch_issue", "当前没有整箱异议。")
    case_id = payload.get("caseId", issue["number"])
    if case_id != issue["number"]:
        fail("wrong_batch_issue", "异议记录已更新，请刷新后核对。")
    choice = "refund" if action == "batch-refund" else "resolve"
    if issue["status"] != "open":
        if issue["proposal"] == choice:
            return
        fail("batch_case_closed", "整箱异议已经处理。")
    if issue["proposal"] == choice and issue["proposed_by"] == role:
        return
    if (("expectedProposal" in payload and payload["expectedProposal"] != issue["proposal"]) or
            ("expectedProposedBy" in payload and payload["expectedProposedBy"] != issue["proposed_by"])):
        fail("batch_proposal_changed", "整箱处理方案已更新，请重新核对后确认。")
    if issue["proposal"] != choice:
        db.execute("UPDATE shop_batch_issues SET proposal=?,proposed_by=? WHERE gid=? AND number=?",
                   (choice, role, gid, case_id))
        log_event(db, gid, now, "batch-proposal", role, "提出整箱处理方案",
                  "建议整批退还未结余款。" if choice == "refund" else "建议恢复整批交付。",
                  data={"caseId": case_id, "proposal": choice})
        return
    status = "refunded" if choice == "refund" else "resolved"
    db.execute("UPDATE shop_batch_issues SET status=?,resolved=? WHERE gid=? AND number=?", (status, now, gid, case_id))
    log_event(db, gid, now, action, role, "双方确认整箱处理方案",
              "双方确认退还本批未结余款。" if choice == "refund" else "双方确认恢复本批交付。",
              data={"caseId": case_id, "proposal": choice, "proposedBy": issue["proposed_by"]})
    if choice == "refund":
        paid = receipts(db, gid, paid=True)
        qty = sum(r["quantity"] for r in paid)
        db.execute("UPDATE shop_orders SET status='refunded',resolution='batch-refund' WHERE gid=? AND status='paid'", (gid,))
        db.execute("UPDATE shop_groups SET phase='batch_refunded' WHERE id=?", (gid,))
        for r in paid:
            r["amounts"] = {"refunded": (g["unit"] + FEE) * r["quantity"]}
        log_event(db, gid, now, "batch-refund-paid", "模拟支付渠道", "整批未结余款原路退回", "已退回每笔订单剩余的商品款及服务费。",
                  items=items_total(paid), amounts={"refunded": (g["unit"]+FEE)*qty}, data={"caseId": case_id, "orders": paid})


def progress_shop(db, gid, now):
    """Run due simulated actors within the caller's own write transaction, before handling an HTTP operation."""
    g = group_row(db, gid)
    if g["phase"] in ("submitted", "accepted"):
        pay_due_seeds(db, gid, now)
    if g["phase"] == "shipped" and g["arrived_at"] is None and now >= g["shipped_at"] + 2:
        register_arrival(db, g, g["shipped_at"] + 2)
    if g["phase"] in ("batch_received", "distributed") and not is_batch_paused(db, gid):
        due = db.execute("""SELECT * FROM shop_orders WHERE gid=? AND buyer IS NULL AND distributed=1
                            AND status='paid' AND seed_receive_at<=? ORDER BY id""", (gid, now)).fetchall()
        for order in due:
            settle_order(db, g, order, now, seed=True)


def member(db, g, buyer, action, payload, now):
    gid = g["id"]
    o = db.execute("SELECT * FROM shop_orders WHERE gid=? AND buyer=?", (gid, buyer)).fetchone()
    if not o or ("orderId" in payload and o["id"] != payload["orderId"]):
        fail("not_your_order", "仅可操作自己报名的订单。", 403)
    oid = o["id"]
    if action == "manual-claim":
        open_claim(db, g, o, payload, now)
        return
    if action == "pay":
        pay_order(db, g, oid, payload, now)
        return
    if not o["distributed"]:
        fail("not_distributed", "须等团长把本单分发给你。")
    if action == "receive":
        settle_order(db, g, o, now)
        return
    items = paid_items(db, gid, oid)
    qty = sum(i["qty"] for i in items)
    reason = payload.get("reason")
    if not isinstance(reason, str) or reason not in REASONS:
        fail("invalid_reason", "请选择售后原因。", 400)
    n = round_number(payload)
    if n < o["round"] or (n == o["round"] and reason == o["reason"]):
        return
    if n != o["round"] + 1 or o["status"] not in ("paid", "reshipping"):
        fail("wrong_status", "请核对本单状态和异议轮次。")
    db.execute("UPDATE shop_orders SET status='disputed',reason=?,round=?,resolution=NULL WHERE gid=? AND id=?", (reason, n, gid, oid))
    log_event(db, gid, now, "dispute", "拼友", "提出本单异议", "本单暂停分账，已交对应责任方处理。", oid=oid, items=items,
              amounts={"held": qty * (g["unit"] + FEE)}, data={"round": n, "responsibleRole": REASONS[reason]})


def handle_case(db, g, action, payload, now):
    gid, oid = g["id"], payload.get("orderId")
    if not isinstance(oid, str):
        fail("invalid_order", "请选择订单。", 400)
    role = payload.get("role")
    if action in ("reply-claim", "close-claim"):
        n = payload.get("claimId", 1)
        if type(n) is not int or n < 1:
            fail("invalid_claim", "请选择有效的售后单。", 400)
        c = db.execute("SELECT * FROM shop_claims WHERE gid=? AND oid=? AND number=?", (gid, oid, n)).fetchone()
        if not c:
            fail("claim_not_found", "未找到人工售后单。", 404)
        if role != REASONS[c["reason"]]:
            fail("wrong_role", "请由对应责任方处理。", 403)
        if action == "reply-claim":
            reply = short_text(payload, "reply", True)
            if c["reply"] == reply:
                return
            if c["closed"] is not None:
                fail("claim_closed", "人工售后单已关闭。")
            db.execute("UPDATE shop_claims SET reply=?,answered=? WHERE gid=? AND oid=? AND number=?", (reply, now, gid, oid, n))
            title = "人工售后答复"
        else:
            if c["closed"] is not None:
                return
            db.execute("UPDATE shop_claims SET closed=? WHERE gid=? AND oid=? AND number=?", (now, gid, oid, n))
            title = "关闭人工售后"
        log_event(db, gid, now, action, role, title, "人工售后进度已登记，未变更既有结算。", oid=oid, items=paid_items(db, gid, oid), data={"claimId": n})
        return
    o = db.execute("SELECT * FROM shop_orders WHERE gid=? AND id=?", (gid, oid)).fetchone()
    if not o:
        fail("order_not_found", "本团没有该订单。", 404)
    n = round_number(payload)
    if n < o["round"]:
        return
    if role not in ("工厂", "团长") or role != REASONS.get(o["reason"]):
        fail("wrong_role", "请由对应责任方处理。", 403)
    if n == o["round"] and o["resolution"] == action:
        return
    if n != o["round"] or o["status"] != "disputed":
        fail("not_disputed", "只能处理本轮待办异议。")
    is_refund = action == "refund"
    db.execute("UPDATE shop_orders SET resolution=?,status=? WHERE gid=? AND id=?", (action, "refunded" if is_refund else "reshipping", gid, oid))
    items = paid_items(db, gid, oid)
    qty = sum(i["qty"] for i in items)
    log_event(db, gid, now, action, role, "同意余款退款" if is_refund else "安排补发", "本单由责任方处理。", oid=oid, items=items, data={"round": n})
    if is_refund:
        amount = qty * (g["unit"] + FEE)
        log_event(db, gid, now, "dispute-refund", "模拟支付渠道", "异议退款到账", f"退回剩余 ¥{amount}，本单不再分账。",
                  oid=oid, items=items, amounts={"refunded": amount, "totalOrderRefund": qty * PREPAID, "leaderPaid": 0, "factoryPaid": 0})


def order_view(row, items, g, buyer):
    quantity = sum(i["qty"] for i in items)
    accepted = sum(i["acceptedQty"] for i in items)
    paid = sum(i["paidQty"] for i in items)
    rejected = sum(i["qty"] for i in items if i["decision"] == "reject")
    pending = quantity - accepted - rejected
    unit = FULL_PRICE if g["unit"] is None else g["unit"]
    failed = g["phase"] == "failed"
    can_pay = g["phase"] in ("submitted", "accepted")
    payment_items = [{"sku": i["sku"], "qty": i["acceptedQty"] - i["paidQty"]} for i in items
                     if can_pay and i["acceptedQty"] > i["paidQty"]]
    blocked = can_pay and any(i["availableQty"] < i["acceptedQty"] - i["paidQty"] for i in items)
    payable = 0 if blocked or not can_pay else accepted - paid
    if accepted == quantity:
        acceptance = "accepted"
    elif rejected == quantity:
        acceptance = "rejected"
    elif accepted or rejected:
        acceptance = "partial"
    else:
        acceptance = "pending"
    money = Counter()
    for item in items:
        pieces = item["paidQty"]
        item_goods = pieces * unit
        item_fee = pieces * FEE
        settled = row["status"] == "received"
        amounts = {"prepaid": pieces * PREPAID, "goods": item_goods, "fee": item_fee,
                   "discountRefund": 0 if failed else pieces * (FULL_PRICE - unit),
                   "failureRefund": pieces * PREPAID if failed else 0,
                   "disputeRefund": item_goods + item_fee if row["resolution"] == "refund" else 0,
                   "batchRefund": item_goods + item_fee if row["resolution"] == "batch-refund" else 0,
                   "factoryPaid": item_goods if settled else 0, "leaderPaid": item_fee if settled else 0}
        amounts["refundTotal"] = amounts["discountRefund"] + amounts["failureRefund"] + amounts["disputeRefund"] + amounts["batchRefund"]
        amounts["held"] = amounts["prepaid"] - amounts["refundTotal"] - amounts["factoryPaid"] - amounts["leaderPaid"]
        amounts["leaderDue"] = 0 if row["status"] == "refunded" else item_fee
        amounts["leaderPending"] = amounts["leaderDue"] - amounts["leaderPaid"]
        item.update(amounts)
        money.update(amounts)
    return {"id": row["id"], "mine": row["buyer"] == buyer and row["buyer"] is not None,
            "seed": row["buyer"] is None, "responded": True, "accepted": bool(accepted),
            "paid": bool(paid), "distributed": bool(row["distributed"]), "status": row["status"],
            "items": items, "quantity": quantity, "acceptedQty": accepted, "paidQty": paid,
            "paymentItems": payment_items, "paymentBlocked": blocked,
            "pendingQty": pending, "rejectedQty": rejected, "payableQty": payable, "payableAmount": payable * PREPAID,
            "acceptanceStatus": acceptance, **money,
            "reason": row["reason"], "disputeRound": row["round"], "responsibleRole": REASONS.get(row["reason"])}


def read_shop(db, gid, buyer, role=None):
    g = group_row(db, gid)
    manager = g["creator"] == buyer
    leader = manager and role in ("leader", "团长")
    sku_rows = db.execute("SELECT * FROM shop_skus WHERE gid=? ORDER BY sku", (gid,))
    summary = {row["sku"]: {**CATALOG[row["sku"]], "decision": row["decision"], "reason": row["reason"],
                            "limit": row["stock_cap"], "limited": row["stock_cap"] is not None, "seedPayAt": row["seed_due"],
                            "signupQty": 0, "acceptedQty": 0, "rejectedQty": 0, "paidQty": 0}
               for row in sku_rows}
    by_order = defaultdict(list)
    for item in db.execute("SELECT * FROM shop_items WHERE gid=? ORDER BY oid,sku", (gid,)):
        sku, qty = item["sku"], item["qty"]
        s = summary[sku]
        data = {**CATALOG[sku], "qty": qty, "decision": s["decision"], "reason": s["reason"],
                "acceptedQty": qty if s["decision"] == "accept" else 0, "paidQty": item["paid_qty"]}
        by_order[item["oid"]].append(data)
        s["signupQty"] += qty
        s["acceptedQty"] += data["acceptedQty"]
        s["rejectedQty"] += qty if s["decision"] == "reject" else 0
        s["paidQty"] += data["paidQty"]
    for s in summary.values():
        s["remaining"] = s["limit"] - s["paidQty"] if s["limited"] else None
        if s["limited"]:
            s["acceptedQty"] = min(s["acceptedQty"], s["limit"])
    for group_items in by_order.values():
        for item in group_items:
            s = summary[item["sku"]]
            unpaid = item["acceptedQty"] - item["paidQty"]
            item.update(limit=s["limit"], remaining=s["remaining"], limited=s["limited"],
                        availableQty=(min(unpaid, s["remaining"]) if s["limited"] else unpaid)
                        if g["phase"] in ("submitted", "accepted") else 0)
    rows = db.execute("SELECT * FROM shop_orders WHERE gid=? ORDER BY rowid", (gid,)).fetchall()
    orders = [order_view(r, by_order[r["id"]], g, buyer) for r in rows]
    mine = next((o for o in orders if o["mine"]), None)
    my_id = mine["id"] if mine else None
    claims = defaultdict(list)
    for c in db.execute("SELECT * FROM shop_claims WHERE gid=? AND (? OR oid=?) ORDER BY oid,number", (gid, manager, my_id)):
        claims[c["oid"]].append({"claimId": c["number"], "orderId": c["oid"], "reason": c["reason"],
                                 "note": c["note"], "reply": c["reply"], "responsibleRole": REASONS[c["reason"]],
                                 "createdAt": c["created"], "answeredAt": c["answered"], "closedAt": c["closed"],
                                 "status": "closed" if c["closed"] is not None else "answered" if c["reply"] else "open"})
    visible = []
    for o, r in zip(orders, rows):
        if manager or o["mine"]:
            o["manualClaims"] = claims[o["id"]]
            o["manualClaim"] = o["manualClaims"][-1] if o["manualClaims"] else None
            if leader or o["mine"]:
                o["recipient"] = json.loads(r["recipient"])
            visible.append(o)
        else:
            # The shared group page only needs anonymous signup and factory acceptance.
            visible.append({k: o[k] for k in ("id", "mine", "seed", "responded", "accepted", "acceptanceStatus", "quantity", "acceptedQty")})
    money_keys = ("prepaid", "held", "factoryPaid", "leaderPaid", "leaderDue", "leaderPending",
                  "discountRefund", "disputeRefund", "failureRefund", "batchRefund")
    totals = {key: sum(o[key] for o in orders) for key in money_keys}
    totals["refunded"] = sum(o["refundTotal"] for o in orders)
    totals["factoryMerchantHeld"] = totals["held"]
    events = []
    for row in db.execute("SELECT public_json,digest FROM shop_events WHERE group_id=? ORDER BY seq", (gid,)):
        public = json.loads(row["public_json"])
        events.append({**public, "public": public, "hash": "0x" + row["digest"], "digest": row["digest"], "chainStatus": "pending"})
    signup_qty = sum(o["quantity"] for o in orders)
    paid_qty = sum(o["paidQty"] for o in orders)
    shipment = None
    if g["shipped_at"] is not None:
        shipment = {"carrier": g["carrier"], "trackingNumber": g["tracking"] if manager or (mine and mine["paid"]) else None,
                    "shippedAt": g["shipped_at"], "commitment": shipment_commitment(g["carrier"], g["tracking"])}
    notices = []
    for event in events:
        if event["action"] == "accept":
            for decision in event["data"]["decisions"]:
                sku = decision["sku"]
                s = summary[sku]
                detail = f"限量 {s['limit']} 个，按付款成功顺序锁定。" if s["limited"] else (
                    "该款已接单。" if decision["decision"] == "accept" else "该款未接单。")
                notices.append({"kind": "accept", "at": event["at"], "sku": sku, "title": s["name"] + "接单通知",
                                "detail": detail, "limit": s["limit"], "remaining": s["remaining"]})
    case = latest_batch(db, gid)
    batch_issue = None if not case else {"id": case["number"], "caseId": case["number"], "status": case["status"],
                 "reason": case["reason"], "quantity": case["qty"], "openedAt": case["opened"], "deadlineAt": case["deadline"],
                 "resolvedAt": case["resolved"], "proposal": case["proposal"], "proposedBy": case["proposed_by"]}
    deadline = g["arrived_at"] + BATCH_WINDOW if g["arrived_at"] is not None else None
    return {"id": gid, "phase": g["phase"], "canManage": manager, "targetCount": g["target_count"],
            "factory": "山涧布偶工坊", "seedCount": g["seed_count"], "catalog": list(CATALOG.values()), "catalogs": list(CATALOG.values()),
            "skuSummary": list(summary.values()), "signupCount": signup_qty, "signupOrderCount": len(orders),
            "acceptedCount": sum(s["acceptedQty"] for s in summary.values()), "acceptedOrderCount": sum(o["accepted"] for o in orders),
            "acceptedOrderIds": [o["id"] for o in orders if o["accepted"]], "paidCount": paid_qty, "count": paid_qty,
            "paidOrderCount": sum(o["paid"] for o in orders), "distributedCount": sum(o["paidQty"] for o in orders if o["distributed"]),
            "distributedOrderCount": sum(o["distributed"] for o in orders), "receivedOrderCount": sum(o["status"] == "received" for o in orders),
            "unit": tier(paid_qty) if g["unit"] is None else g["unit"], "prepay": FULL_PRICE, "fee": FEE,
            "minQuantity": MINIMUM, "discountQuantity": DISCOUNT_AT, "leadDays": LEAD_DAYS,
            "closedAt": g["closed_at"], "shipDueAt": g["closed_at"] + LEAD_DAYS * 86400 if g["closed_at"] is not None and g["phase"] != "failed" else None,
            "shipment": shipment, "orders": visible, "mine": mine, "totals": totals, "events": events,
            "notices": notices, "batchIssue": batch_issue, "batchReasons": list(BATCH_REASONS),
            "batchIssueReasons": list(BATCH_REASONS), "batchArrivedAt": g["arrived_at"], "batchIssueDeadlineAt": deadline,
            "reasonOptions": list(REASONS), "reasonRoles": REASONS.copy(), "rejectReasons": list(REJECT_REASONS),
            "recipientOptions": recipient_options(gid, buyer)}


def act_shop(db, gid, buyer, action, payload, now):
    g = group_row(db, gid)
    if not isinstance(payload, dict):
        fail("invalid_payload", "操作参数应为对象。", 400)
    if action == "respond":
        signup(db, g, buyer, payload, now)
    elif action in ("pay", "receive", "dispute", "manual-claim"):
        member(db, g, buyer, action, payload, now)
    else:
        if action not in TRANSITIONS and action not in ("accept", "close-pay", "distribute", "refund", "reship", "reply-claim", "close-claim",
                                                       "batch-dispute", "batch-resolve", "batch-refund"):
            fail("not_found", "未找到此操作。", 404)
        if g["creator"] != buyer:
            fail("not_manager", "仅创建团的浏览器可演示团长或工厂。", 403)
        if action in TRANSITIONS:
            transition(db, g, action, payload, now)
        elif action == "accept":
            accept(db, g, payload, now)
        elif action == "close-pay":
            close_pay(db, g, now)
        elif action == "distribute":
            distribute(db, g, payload, now)
        elif action in ("batch-dispute", "batch-resolve", "batch-refund"):
            batch_case(db, g, action, payload, now)
        else:
            handle_case(db, g, action, payload, now)
    return read_shop(db, gid, buyer, role=payload.get("viewRole"))
