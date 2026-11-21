"""Local v4 cotton-doll group simulator. The HTTP caller owns the SQLite transaction."""

import secrets

from roles_service import ApiError


MINIMUM, DISCOUNT_AT = 50, 100
FULL_PRICE, DISCOUNT_PRICE, FEE = 88, 66, 3
PREPAID = FULL_PRICE + FEE
LEAD_DAYS = 15
FACTORY = "山涧布偶工坊"
REASONS = {"生产质量问题": "工厂", "与确认样不符": "工厂", "分装漏发": "团长", "分装错发": "团长"}
PHASES = ("draft", "proposed", "quoted", "open", "submitted", "accepted", "pay_closed",
          "started", "shipped", "batch_received", "distributed")
MEMBER_ACTIONS = {"respond", "pay", "receive", "dispute", "manual-claim"}
SIMPLE_STEPS = {
    "propose": ("draft", "proposed", "团长", "提交开团提案", "提交已定样的栗栗熊棉花娃娃给工厂核定。"),
    "quote": ("proposed", "quoted", "工厂", "确认款式与报价", "确认 50 个起订、100 个起 ¥66，付款截止后 15 天内发货。"),
    "publish": ("quoted", "open", "团长", "公开招募报名", "开始登记拼友意向，报名无需付款。"),
    "submit-production": ("open", "submitted", "团长", "截止报名并提交生产单", "按报名清单提交工厂逐单核定。"),
    "start": ("pay_closed", "started", "工厂", "按实付清单开工", "排产以付款截止时的实付个数为准。"),
    "ship": ("started", "shipped", "工厂", "整箱发货", "按最终实付清单将整箱棉花娃娃寄给团长。"),
    "receive-batch": ("shipped", "batch_received", "团长", "整箱签收入库", "团长已收到整箱，等待逐单分发。"),
}


def init_journey_db(db):
    db.execute("""CREATE TABLE IF NOT EXISTS journey_groups(
        id TEXT PRIMARY KEY, creator TEXT NOT NULL, seed_count INTEGER NOT NULL, phase TEXT NOT NULL,
        target_count INTEGER NOT NULL, unit INTEGER, closed_at INTEGER
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS journey_orders(
        group_id TEXT NOT NULL REFERENCES journey_groups(id), id TEXT NOT NULL, buyer TEXT,
        accepted INTEGER NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 0,
        distributed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'registered',
        reason TEXT, round INTEGER NOT NULL DEFAULT 0, resolution TEXT,
        PRIMARY KEY(group_id,id), UNIQUE(group_id,buyer)
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS journey_events(
        seq INTEGER PRIMARY KEY, group_id TEXT NOT NULL REFERENCES journey_groups(id),
        at INTEGER NOT NULL, role TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, order_id TEXT
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS journey_event_group ON journey_events(group_id,seq)")
    db.execute("""CREATE TABLE IF NOT EXISTS journey_claims(
        group_id TEXT NOT NULL, order_id TEXT NOT NULL, number INTEGER NOT NULL, reason TEXT NOT NULL,
        note TEXT NOT NULL, reply TEXT, opened_at INTEGER NOT NULL, answered_at INTEGER, closed_at INTEGER,
        PRIMARY KEY(group_id,order_id,number), UNIQUE(group_id,order_id,reason,note),
        FOREIGN KEY(group_id,order_id) REFERENCES journey_orders(group_id,id)
    )""")


def fail(code, message, status=409):
    raise ApiError(status, code, message)


def log(db, group, now, role, title, detail, order_id=None):
    db.execute("INSERT INTO journey_events(group_id,at,role,title,detail,order_id) VALUES(?,?,?,?,?,?)",
               (group, now, role, title, detail, order_id))


def get_group(db, group):
    row = db.execute("SELECT * FROM journey_groups WHERE id=?", (group,)).fetchone()
    if not row:
        fail("not_found", "未找到这个演示团。", 404)
    return row


def order_rows(db, group):
    return db.execute("SELECT * FROM journey_orders WHERE group_id=? ORDER BY rowid", (group,)).fetchall()


def create_journey(db, buyer, now, payload):
    if not isinstance(payload, dict):
        fail("invalid_payload", "建团参数应为对象。", 400)
    seeds = payload.get("seedCount", 99)
    if type(seeds) is not int or not 0 <= seeds <= 199:
        fail("invalid_seed", "可设置 0 到 199 个模拟拼友。", 400)
    group = secrets.token_hex(6)
    db.execute("INSERT INTO journey_groups(id,creator,seed_count,phase,target_count) VALUES (?,?,?,'draft',100)",
               (group, buyer, seeds))
    return read_journey(db, group, buyer)


def tier(count):
    return DISCOUNT_PRICE if count >= DISCOUNT_AT else FULL_PRICE


def order_view(row, group, buyer, manage):
    mine = row["buyer"] is not None and row["buyer"] == buyer
    paid = bool(row["paid"])
    failed = group["phase"] == "failed"
    unit = FULL_PRICE if group["unit"] is None else group["unit"]
    goods = unit if paid else 0
    prepaid = PREPAID if paid else 0
    discount = FULL_PRICE - goods if paid and not failed else 0
    failure = prepaid if failed else 0
    dispute = goods + FEE if row["resolution"] == "refund" else 0
    refunded = discount + failure + dispute
    factory_paid, leader_paid = (goods, FEE) if row["status"] == "received" else (0, 0)
    held = prepaid - refunded - factory_paid - leader_paid
    return {
        "id": row["id"], "mine": mine, "seed": row["buyer"] is None, "responded": True,
        "accepted": bool(row["accepted"]), "paid": paid, "distributed": bool(row["distributed"]),
        "status": row["status"], "goods": goods, "fee": FEE, "prepaid": prepaid, "held": held,
        "discountRefund": discount, "failureRefund": failure, "disputeRefund": dispute,
        "refundTotal": refunded, "factoryPaid": factory_paid, "leaderPaid": leader_paid,
        "reason": row["reason"] if mine or manage else None, "disputeRound": row["round"],
        "responsibleRole": REASONS.get(row["reason"]),
    }


def read_journey(db, group, buyer):
    g = get_group(db, group)
    manage = g["creator"] == buyer
    orders = [order_view(row, g, buyer, manage) for row in order_rows(db, group)]
    accepted = [o["id"] for o in orders if o["accepted"]]
    paid = sum(o["paid"] for o in orders)
    totals = {key: sum(o[key] for o in orders) for key in ("prepaid", "factoryPaid", "leaderPaid", "held")}
    totals["factoryMerchantHeld"] = totals["held"]
    totals["refunded"] = sum(o["refundTotal"] for o in orders)
    mine = next((o for o in orders if o["mine"]), None)
    my_id = mine["id"] if mine else None
    claims = db.execute("""SELECT * FROM journey_claims WHERE group_id=? AND (? OR order_id=?)
                           ORDER BY order_id,number""", (group, manage, my_id))
    by_order = {}
    for claim in claims:
        item = {"claimId": claim["number"], "orderId": claim["order_id"], "reason": claim["reason"],
                "responsibleRole": REASONS[claim["reason"]], "note": claim["note"], "reply": claim["reply"],
                "createdAt": claim["opened_at"], "answeredAt": claim["answered_at"], "closedAt": claim["closed_at"],
                "status": "closed" if claim["closed_at"] is not None else "answered" if claim["reply"] else "open"}
        by_order.setdefault(claim["order_id"], []).append(item)
    visible = []
    for order in orders:
        if manage or order["mine"]:
            history = by_order.get(order["id"], [])
            order["manualClaims"] = history
            order["manualClaim"] = history[-1] if history else None
            visible.append(order)
        else:
            visible.append({field: order[field] for field in ("id", "mine", "seed", "responded", "accepted")})
    events = db.execute("""SELECT at,role,title,detail,order_id AS orderId FROM journey_events
                           WHERE group_id=? AND (? OR order_id IS NULL OR order_id=?) ORDER BY seq""", (group, manage, my_id))
    return {
        "id": group, "phase": g["phase"], "canManage": manage, "targetCount": g["target_count"],
        "seedCount": g["seed_count"], "signupCount": len(orders), "acceptedCount": len(accepted),
        "acceptedOrderIds": accepted, "paidCount": paid, "count": paid, "distributedCount": sum(o["distributed"] for o in orders),
        "unit": tier(paid) if g["unit"] is None else g["unit"], "prepay": FULL_PRICE, "fee": FEE,
        "minQuantity": MINIMUM, "discountQuantity": DISCOUNT_AT, "leadDays": LEAD_DAYS, "closedAt": g["closed_at"],
        "shipDueAt": g["closed_at"] + LEAD_DAYS * 86400 if g["closed_at"] is not None and g["phase"] != "failed" else None,
        "mine": mine, "orders": visible, "totals": totals,
        "events": [dict(e) for e in events], "reasonOptions": list(REASONS), "reasonRoles": REASONS.copy(),
    }


def step(db, group, action, payload, now):
    previous, target, who, title, detail = SIMPLE_STEPS[action]
    phase, gid = group["phase"], group["id"]
    if phase == "failed":
        if action in ("propose", "quote", "publish", "submit-production"):
            return
        fail("not_formed", "本团未成团，不能继续生产或交付。")
    if PHASES.index(phase) >= PHASES.index(target):
        return
    if phase != previous:
        fail("wrong_phase", "请先完成上一步。")
    if action == "propose":
        quantity = payload.get("targetCount", group["target_count"])
        if type(quantity) is not int or not 1 <= quantity <= 10000:
            fail("invalid_target", "意向目标应为 1 到 10000 的整数。", 400)
        db.execute("UPDATE journey_groups SET target_count=? WHERE id=?", (quantity, gid))
        detail += f" 本次意向目标 {quantity} 个。"
    if action in ("submit-production", "start", "ship", "receive-batch"):
        rows = order_rows(db, gid)
        if action == "submit-production" and not rows:
            fail("empty_signup", "尚无报名，请先登记意向。")
        count = len(rows) if action == "submit-production" else sum(row["paid"] for row in rows)
        detail += f" 清单数量 {count} 个。"
    db.execute("UPDATE journey_groups SET phase=? WHERE id=?", (target, gid))
    log(db, gid, now, who, title, detail)
    if action == "publish" and group["seed_count"]:
        n = group["seed_count"]
        db.executemany("INSERT INTO journey_orders(group_id,id,buyer) VALUES (?,?,NULL)",
                       ((gid, f"DD-{number:03d}") for number in range(1, n + 1)))
        log(db, gid, now, "拼友", "模拟拼友报名", f"{n} 个预置拼友分别报名，尚未付款。")


def selection(payload, allowed):
    if "orderIds" not in payload:
        return allowed
    ids = payload["orderIds"]
    if not isinstance(ids, list) or not ids or not all(isinstance(item, str) for item in ids):
        fail("invalid_orders", "请至少选择一个有效单号。", 400)
    selected = set(ids)
    if not selected.issubset(allowed):
        fail("invalid_orders", "所选清单中有不属于当前步骤的单号。", 400)
    return selected


def accept(db, group, payload, now):
    gid, phase = group["id"], group["phase"]
    rows = order_rows(db, gid)
    chosen = selection(payload, {r["id"] for r in rows})
    added = [r for r in rows if r["id"] in chosen and not r["accepted"]]
    if phase not in ("submitted", "accepted"):
        if phase in ("draft", "proposed", "quoted", "open") or added:
            fail("wrong_phase", "只有截止报名后、截止付款前可确认生产单。")
        return
    if not added:
        return
    db.executemany("UPDATE journey_orders SET accepted=1 WHERE group_id=? AND id=?", ((gid, r["id"]) for r in added))
    total = sum(r["accepted"] for r in rows) + len(added)
    if total == len(rows):
        db.execute("UPDATE journey_groups SET phase='accepted' WHERE id=?", (gid,))
    log(db, gid, now, "工厂", "确认接单名单", f"本次确认 {len(added)} 个，累计 {total}/{len(rows)} 个。已接单的拼友可以付款。")
    seeds = [r for r in added if r["buyer"] is None]
    if seeds:
        db.executemany("UPDATE journey_orders SET paid=1,status='paid' WHERE group_id=? AND id=?", ((gid, r["id"]) for r in seeds))
        log(db, gid, now, "模拟支付渠道", "预置拼友模拟付款", f"{len(seeds)} 个已接单预置拼友各付 ¥91，共 ¥{len(seeds) * PREPAID} 进入工厂微信二级商户冻结余额，等待逐单结算。")


def close_pay(db, group, now):
    gid, phase = group["id"], group["phase"]
    if group["closed_at"] is not None:
        return
    rows = order_rows(db, gid)
    if phase not in ("submitted", "accepted") or not any(row["accepted"] for row in rows):
        fail("wrong_phase", "请先由工厂确认接单清单，再截止付款。")
    paid = sum(row["paid"] for row in rows)
    formed = paid >= MINIMUM
    unit = tier(paid) if formed else 0
    db.execute("UPDATE journey_groups SET phase=?,unit=?,closed_at=? WHERE id=?",
               ("pay_closed" if formed else "failed", unit, now, gid))
    log(db, gid, now, "团长", "付款截止计价",
        f"报名 {len(rows)} 个、实付 {paid} 个。按实付数{'锁定每个商品价 ¥' + str(unit) if formed else '未达起订量，取消本团'}。")
    if not formed:
        db.execute("UPDATE journey_orders SET status='refunded' WHERE group_id=? AND paid=1", (gid,))
        if paid:
            log(db, gid, now, "模拟支付渠道", "流团退款到账", f"实付的 {paid} 个每个原路退 ¥91，共 ¥{paid * PREPAID}。未付报名未扣款。")
    elif unit < FULL_PRICE:
        difference = FULL_PRICE - unit
        log(db, gid, now, "模拟支付渠道", "阶梯退差到账", f"已付 {paid} 个每个原路退 ¥{difference}，共 ¥{paid * difference}。")


def distribute(db, group, payload, now):
    gid = group["id"]
    if group["phase"] not in ("batch_received", "distributed"):
        fail("wrong_phase", "请先由团长签收整箱。")
    rows = [row for row in order_rows(db, gid) if row["paid"]]
    chosen = selection(payload, {row["id"] for row in rows})
    added = [row for row in rows if row["id"] in chosen and not row["distributed"]]
    if not added:
        return
    db.executemany("UPDATE journey_orders SET distributed=1 WHERE group_id=? AND id=?",
                   ((gid, r["id"]) for r in added))
    total = sum(row["distributed"] for row in rows) + len(added)
    if total == len(rows):
        db.execute("UPDATE journey_groups SET phase='distributed' WHERE id=?", (gid,))
    log(db, gid, now, "团长", "逐单分发", f"本次分发 {len(added)} 个，已分发 {total}/{len(rows)} 个。")
    seeds = [row for row in added if row["buyer"] is None]
    if seeds:
        db.executemany("UPDATE journey_orders SET status='received' WHERE group_id=? AND id=?", ((gid, row["id"]) for row in seeds))
        log(db, gid, now, "拼友", "预置拼友模拟签收", f"{len(seeds)} 个预置拼友各自确认收货。真人拼友须自行确认。")
        log(db, gid, now, "模拟支付渠道", "预置订单模拟逐单结算", f"结算 {len(seeds)} 单，每单向团长分账 ¥{FEE}，向工厂解冻 ¥{group['unit']}。")


def round_number(payload):
    n = payload.get("round", 1)
    if type(n) is not int or n < 1:
        fail("invalid_round", "异议轮次须为正整数。", 400)
    return n


def member_action(db, group, buyer, action, payload, now):
    gid = group["id"]
    order = db.execute("SELECT * FROM journey_orders WHERE group_id=? AND buyer=?", (gid, buyer)).fetchone()
    if action == "respond":
        if order:
            return
        if group["phase"] != "open":
            fail("not_open", "只有公开招募期间可以报名。")
        number = db.execute("SELECT COUNT(*) FROM journey_orders WHERE group_id=?", (gid,)).fetchone()[0] + 1
        oid = f"DD-{number:03d}"
        db.execute("INSERT INTO journey_orders(group_id,id,buyer) VALUES (?,?,?)", (gid, oid, buyer))
        log(db, gid, now, "拼友", "报名一个", f"{oid} 登记报名，未付款。", oid)
        return
    if not order or ("orderId" in payload and payload["orderId"] != order["id"]):
        fail("not_your_order", "只能操作自己的报名订单。", 403)
    oid, status = order["id"], order["status"]
    if action == "manual-claim":
        open_claim(db, gid, order, payload, now)
        return
    if action == "pay":
        if order["paid"]:
            return
        if not order["accepted"] or group["phase"] not in ("submitted", "accepted"):
            fail("cannot_pay", "须在付款截止前，对工厂已确认的本人订单付款。")
        db.execute("UPDATE journey_orders SET paid=1,status='paid' WHERE group_id=? AND id=?", (gid, oid))
        log(db, gid, now, "模拟支付渠道", "拼友模拟付款", f"{oid} 预付商品 ¥88 和团长服务费 ¥3，共 ¥91 进入工厂微信二级商户冻结余额，等待逐单结算。", oid)
        return
    if not order["distributed"]:
        fail("not_distributed", "团长尚未将此单分发给你。")
    if action == "receive":
        if status == "received":
            return
        if status not in ("paid", "reshipping"):
            fail("wrong_status", "当前订单不能签收。")
        db.execute("UPDATE journey_orders SET status='received' WHERE group_id=? AND id=?", (gid, oid))
        log(db, gid, now, "拼友", "本单确认收货", f"{oid} 已确认收到自己的娃娃。", oid)
        log(db, gid, now, "模拟支付渠道", "本单结算", f"{oid} 向团长分账 ¥3，向工厂解冻商品款 ¥{group['unit']}。", oid)
        return
    reason = payload.get("reason")
    if not isinstance(reason, str) or reason not in REASONS:
        fail("invalid_reason", "请从已列明的售后原因中选择。", 400)
    attempt, current = round_number(payload), order["round"]
    if attempt < current or (attempt == current and order["reason"] == reason):
        return
    if attempt != current + 1 or status not in ("paid", "reshipping"):
        fail("wrong_status", "请刷新订单并核对异议轮次。")
    db.execute("UPDATE journey_orders SET reason=?,round=?,resolution=NULL,status='disputed' WHERE group_id=? AND id=?",
               (reason, attempt, gid, oid))
    log(db, gid, now, "拼友", "提交本单异议", f"{oid} 转交{REASONS[reason]}处理，仅本单暂缓结算 ¥{group['unit'] + FEE}。", oid)


def short_text(payload, key, required=False):
    value = payload.get(key, "")
    if not isinstance(value, str) or len(value) > 200 or (required and not value.strip()):
        fail("invalid_text", "请填写不超过 200 个字的文字。" if required else "补充说明最多 200 个字。", 400)
    return value.strip()


def open_claim(db, gid, order, payload, now):
    if order["status"] != "received":
        fail("not_received", "已确认收货的订单可申请人工售后。")
    reason = payload.get("reason")
    if not isinstance(reason, str) or reason not in REASONS:
        fail("invalid_reason", "请选择售后原因。", 400)
    note = short_text(payload, "note")
    oid = order["id"]
    claims = db.execute("SELECT * FROM journey_claims WHERE group_id=? AND order_id=? ORDER BY number",
                        (gid, oid)).fetchall()
    if any(c["reason"] == reason and c["note"] == note for c in claims):
        return
    if claims and claims[-1]["closed_at"] is None:
        fail("claim_open", "已有人工售后单正在处理。")
    number = len(claims) + 1
    db.execute("""INSERT INTO journey_claims(group_id,order_id,number,reason,note,opened_at)
                  VALUES (?,?,?,?,?,?)""", (gid, oid, number, reason, note, now))
    log(db, gid, now, "拼友", "申请人工售后", f"{oid} 售后单 {number} 已转交{REASONS[reason]}处理。", oid)


def handle_claim(db, group, action, payload, now):
    oid, number = payload.get("orderId"), payload.get("claimId", 1)
    if not isinstance(oid, str) or type(number) is not int or number < 1:
        fail("invalid_claim", "请选择要处理的售后单。", 400)
    gid = group["id"]
    claim = db.execute("SELECT * FROM journey_claims WHERE group_id=? AND order_id=? AND number=?",
                       (gid, oid, number)).fetchone()
    if not claim:
        fail("claim_not_found", "没有找到此售后单。", 404)
    role = payload.get("role")
    if role != REASONS[claim["reason"]]:
        fail("wrong_role", "请由这笔售后的责任方处理。", 403)
    if action == "reply-claim":
        reply = short_text(payload, "reply", required=True)
        if reply == claim["reply"]:
            return
        if claim["closed_at"] is not None:
            fail("claim_closed", "该售后单已关闭。")
        db.execute("""UPDATE journey_claims SET reply=?,answered_at=? WHERE group_id=? AND order_id=? AND number=?""",
                   (reply, now, gid, oid, number))
        log(db, gid, now, role, "人工售后答复", f"{oid} 售后单 {number} 已登记答复。", oid)
    elif claim["closed_at"] is None:
        db.execute("UPDATE journey_claims SET closed_at=? WHERE group_id=? AND order_id=? AND number=?", (now, gid, oid, number))
        log(db, gid, now, role, "人工售后关闭", f"{oid} 售后单 {number} 已关闭。", oid)


def resolve(db, group, action, payload, now):
    oid = payload.get("orderId")
    if not isinstance(oid, str):
        fail("invalid_order", "请选择要处理的订单。", 400)
    gid = group["id"]
    order = db.execute("SELECT * FROM journey_orders WHERE group_id=? AND id=?", (gid, oid)).fetchone()
    if not order:
        fail("order_not_found", "本团没有此订单。", 404)
    attempt = round_number(payload)
    if attempt < order["round"]:
        return
    role = payload.get("role")
    if role not in ("工厂", "团长") or role != REASONS.get(order["reason"]):
        fail("wrong_role", "请由该笔异议对应的责任方处理。", 403)
    if attempt == order["round"] and order["resolution"] == action:
        return
    if order["status"] != "disputed" or attempt != order["round"]:
        fail("not_disputed", "仅可处理当前轮次的待办异议。")
    refund = action == "refund"
    db.execute("UPDATE journey_orders SET resolution=?,status=? WHERE group_id=? AND id=?",
               (action, "refunded" if refund else "reshipping", gid, oid))
    log(db, gid, now, role, "同意余款退款" if refund else "安排补发",
        f"{oid} 同意退还剩余款项。" if refund else f"{oid} 已补发，本单继续待结算，等待拼友确认。", oid)
    if refund:
        log(db, gid, now, "模拟支付渠道", "异议退款到账",
            f"{oid} 余款 ¥{group['unit'] + FEE} 已原路退回，累计退 ¥91，本单不再分服务费。", oid)


def act_journey(db, group, buyer, action, payload, now):
    g = get_group(db, group)
    if not isinstance(payload, dict):
        fail("invalid_payload", "操作参数应为对象。", 400)
    if action in MEMBER_ACTIONS:
        member_action(db, g, buyer, action, payload, now)
    else:
        if action not in SIMPLE_STEPS and action not in ("accept", "close-pay", "distribute", "refund", "reship", "reply-claim", "close-claim"):
            fail("not_found", "未找到此操作。", 404)
        if g["creator"] != buyer:
            fail("not_manager", "仅建团浏览器可演示团长和工厂。", 403)
        if action in SIMPLE_STEPS:
            step(db, g, action, payload, now)
        elif action == "accept":
            accept(db, g, payload, now)
        elif action == "close-pay":
            close_pay(db, g, now)
        elif action == "distribute":
            distribute(db, g, payload, now)
        elif action in ("reply-claim", "close-claim"):
            handle_claim(db, g, action, payload, now)
        else:
            resolve(db, g, action, payload, now)
    return read_journey(db, group, buyer)
