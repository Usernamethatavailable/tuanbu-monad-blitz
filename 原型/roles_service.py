"""Three-role group-order simulation. The caller owns the SQLite transaction."""

import secrets

FEE = 3
GOODS_PREPAYMENT = 88
MINIMUM = 3
PREPAID = GOODS_PREPAYMENT + FEE
REASONS = ("未收到", "缺件", "破损", "与约定不符")
MANAGER_ACTIONS = {"close", "accept", "ship", "distribute", "refund", "reship"}
STEPS = ("open", "closed", "accepted", "shipped", "distributed")


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code


def unit_price(count):
    return 66 if count >= 5 else GOODS_PREPAYMENT


def init_db(db):
    db.execute("""CREATE TABLE IF NOT EXISTS role_groups (
        id TEXT PRIMARY KEY, creator TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'open',
        locked_unit INTEGER
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS role_orders (
        group_id TEXT NOT NULL REFERENCES role_groups(id), id TEXT NOT NULL, buyer TEXT,
        status TEXT NOT NULL DEFAULT 'paid', reason TEXT, resolution TEXT, dispute_round INTEGER NOT NULL DEFAULT 0,
        in_production INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(group_id, id), UNIQUE(group_id, buyer)
    )""")
    if "dispute_round" not in {column[1] for column in db.execute("PRAGMA table_info(role_orders)")}:
        db.execute("ALTER TABLE role_orders ADD COLUMN dispute_round INTEGER NOT NULL DEFAULT 0")
        db.execute("UPDATE role_orders SET dispute_round=1 WHERE reason IS NOT NULL")
    db.execute("""CREATE TABLE IF NOT EXISTS role_events (
        seq INTEGER PRIMARY KEY, group_id TEXT NOT NULL REFERENCES role_groups(id),
        at INTEGER NOT NULL, role TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL,
        order_id TEXT
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS role_events_by_group ON role_events(group_id, seq)")


def event(db, group, now, role, title, detail, order_id=None):
    db.execute("INSERT INTO role_events(group_id,at,role,title,detail,order_id) VALUES (?,?,?,?,?,?)",
               (group, now, role, title, detail, order_id))


def add_order(db, group, buyer, now):
    number = 1 + db.execute("SELECT COUNT(*) FROM role_orders WHERE group_id=?", (group,)).fetchone()[0]
    order_id = f"DD-{number:03d}"
    db.execute("INSERT INTO role_orders(group_id,id,buyer) VALUES (?,?,?)", (group, order_id, buyer))
    title = "预置订单模拟付款" if buyer is None else "模拟付款"
    event(db, group, now, "团员", title,
          f"{order_id} 已付 ¥{PREPAID}，含商品预付 ¥{GOODS_PREPAYMENT} 和团长服务费 ¥{FEE}。", order_id)


def create_group(db, buyer, now, *, seed_count=4):
    if type(seed_count) is not int or seed_count not in (1, 3, 4):
        raise ApiError(400, "invalid_seed", "预置订单数可选 1、3 或 4 份。")
    group = secrets.token_hex(6)
    db.execute("INSERT INTO role_groups(id,creator) VALUES (?,?)", (group, buyer))
    event(db, group, now, "工厂", "确认拼团报价", "山涧印制工坊确认栗栗熊亚克力挂件稿件。3 份起印，每份 ¥88；5 份起每份 ¥66。")
    for _ in range(seed_count):
        add_order(db, group, None, now)
    return act(db, group, buyer, "read", {}, now)


def order_view(row, group, buyer, manager):
    mine = row["buyer"] == buyer and row["buyer"] is not None
    failed = group["phase"] == "failed"
    goods = GOODS_PREPAYMENT if group["locked_unit"] is None else group["locked_unit"]
    discount = 0 if failed else GOODS_PREPAYMENT - goods
    failure_refund = PREPAID if failed else 0
    dispute_refund = goods + FEE if row["resolution"] == "refund" else 0
    refunded = discount + failure_refund + dispute_refund
    settled = row["status"] == "received"
    factory_paid, leader_paid = (goods, FEE) if settled else (0, 0)
    held = PREPAID - refunded - factory_paid - leader_paid
    return {
        "id": row["id"], "mine": mine, "seed": row["buyer"] is None, "status": row["status"],
        "goods": goods, "fee": FEE, "prepaid": PREPAID, "discountRefund": discount,
        "disputeRefund": dispute_refund, "failureRefund": failure_refund, "refundTotal": refunded,
        "held": held, "factoryPaid": factory_paid, "leaderPaid": leader_paid,
        "reason": row["reason"] if mine or manager else None, "accepted": bool(row["in_production"]),
        "disputeRound": row["dispute_round"],
    }


def snapshot(db, group, buyer):
    group_id = group["id"]
    manager = group["creator"] == buyer
    rows = db.execute("SELECT * FROM role_orders WHERE group_id=? ORDER BY rowid", (group_id,))
    orders = [order_view(row, group, buyer, manager) for row in rows]
    events = db.execute("""SELECT at,role,title,detail,order_id AS orderId FROM role_events
                           WHERE group_id=? ORDER BY seq""", (group_id,))
    totals = {field: sum(order[field] for order in orders) for field in ("prepaid", "factoryPaid", "leaderPaid", "held")}
    totals["refunded"] = sum(order["refundTotal"] for order in orders)
    unit = group["locked_unit"] if group["locked_unit"] is not None else unit_price(len(orders))
    accepted = [order["id"] for order in orders if order["accepted"]]
    return {
        "id": group_id, "phase": group["phase"], "count": len(orders), "unit": unit,
        "fee": FEE, "prepay": GOODS_PREPAYMENT, "canManage": manager,
        "mine": next((order for order in orders if order["mine"]), None),
        "orders": orders, "events": [dict(row) for row in events], "totals": totals,
        "acceptedOrderIds": accepted, "acceptedCount": len(accepted), "reasonOptions": list(REASONS),
    }


def accept_orders(db, group, payload, now):
    group_id, phase = group["id"], group["phase"]
    if phase == "failed":
        raise ApiError(409, "not_formed", "本团未成团，无需生产。")
    if phase == "open":
        raise ApiError(409, "wrong_phase", "请先截止计价，再确认生产清单。")
    rows = db.execute("SELECT id,in_production FROM role_orders WHERE group_id=? ORDER BY rowid", (group_id,)).fetchall()
    known = {row["id"] for row in rows}
    if "orderIds" in payload:
        ids = payload["orderIds"]
        if not isinstance(ids, list) or not ids or not all(isinstance(item, str) for item in ids):
            raise ApiError(400, "invalid_orders", "请至少选择一个有效订单号。")
        chosen = set(ids)
        if not chosen.issubset(known):
            raise ApiError(400, "invalid_orders", "生产清单只能包含本团已付的订单。")
    else:
        chosen = known
    added = [row["id"] for row in rows if row["id"] in chosen and not row["in_production"]]
    if not added:
        return
    db.executemany("UPDATE role_orders SET in_production=1 WHERE group_id=? AND id=?",
                   [(group_id, order_id) for order_id in added])
    signed = sum(row["in_production"] for row in rows) + len(added)
    if signed == len(rows):
        db.execute("UPDATE role_groups SET phase='accepted' WHERE id=?", (group_id,))
    title = "确认生产订单" if signed == len(rows) else "部分接单"
    detail = f"工厂本次确认 {', '.join(added)}，累计接单 {signed}/{len(rows)} 份。"
    event(db, group_id, now, "工厂", title, detail)


def advance_group(db, group, action, now):
    group_id, phase = group["id"], group["phase"]
    if action == "close":
        if phase != "open":
            return
        count = db.execute("SELECT COUNT(*) FROM role_orders WHERE group_id=?", (group_id,)).fetchone()[0]
        next_phase = "failed" if count < MINIMUM else "closed"
        unit = 0 if next_phase == "failed" else unit_price(count)
        discount = GOODS_PREPAYMENT - unit
        db.execute("UPDATE role_groups SET phase=?,locked_unit=? WHERE id=?", (next_phase, unit, group_id))
        if next_phase == "failed":
            db.execute("UPDATE role_orders SET status='refunded' WHERE group_id=?", (group_id,))
            detail = f"{count} 份未达起订量，每单应退商品款和服务费合计 ¥{PREPAID}。"
        else:
            detail = f"锁定 {count} 份，每份商品款 ¥{unit}，每单退差 ¥{discount}，合计退差 ¥{discount * count}。"
        event(db, group_id, now, "团长", "截止计价", detail)
        if next_phase == "failed":
            event(db, group_id, now, "模拟支付渠道", "流团退款到账",
                  f"已原路退回 {count} 单商品款与服务费，每单 ¥{PREPAID}，共 ¥{count * PREPAID}。")
        elif discount:
            event(db, group_id, now, "模拟支付渠道", "退差到账",
                  f"已按截止价格原路退回 {count} 单差价，每单 ¥{discount}，共 ¥{count * discount}。")
        return

    target, role, title = {
        "ship": ("shipped", "工厂", "整批发货"),
        "distribute": ("distributed", "团长", "签收入库并分货"),
    }[action]
    if phase == "failed":
        raise ApiError(409, "not_formed", "本团未成团，无需生产或交付。")
    current_step, next_step = STEPS.index(phase), STEPS.index(target)
    if current_step >= next_step:
        return
    if action == "ship" and phase == "closed":
        raise ApiError(409, "incomplete_production", "工厂接单数量与实付清单尚未对齐，补齐后才能发货。")
    if current_step + 1 != next_step:
        raise ApiError(409, "wrong_phase", "请先完成前一个拼团步骤。")
    db.execute("UPDATE role_groups SET phase=? WHERE id=?", (target, group_id))
    accepted = db.execute("SELECT COUNT(*) FROM role_orders WHERE group_id=? AND in_production=1", (group_id,)).fetchone()[0]
    details = {"ship": f"工厂按已接清单，将 {accepted} 份挂件整批寄往团长。",
               "distribute": f"团长签收 {accepted} 份并开始分货，每份独立结算。"}
    event(db, group_id, now, role, title, details[action])
    if action == "distribute":
        seeds = db.execute("SELECT id FROM role_orders WHERE group_id=? AND buyer IS NULL AND status='paid' ORDER BY rowid", (group_id,)).fetchall()
        for row in seeds:
            settle(db, group, row["id"], now, seed=True)


def settle(db, group, order_id, now, seed=False):
    db.execute("UPDATE role_orders SET status='received' WHERE group_id=? AND id=?", (group["id"], order_id))
    title = "预置团员模拟签收" if seed else "单份签收"
    event(db, group["id"], now, "团员", title,
          f"{order_id} 签收，模拟结算给工厂 ¥{group['locked_unit']}、团长 ¥{FEE}。", order_id)


def buyer_action(db, group, buyer, action, payload, now):
    group_id = group["id"]
    order = db.execute("SELECT * FROM role_orders WHERE group_id=? AND buyer=?", (group_id, buyer)).fetchone()
    if action == "join":
        if order:
            return
        if group["phase"] != "open":
            raise ApiError(409, "group_closed", "本团已截止，无法新增认购。")
        add_order(db, group_id, buyer, now)
        return
    if not order or ("orderId" in payload and payload["orderId"] != order["id"]):
        raise ApiError(403, "not_your_order", "仅可操作自己已认购的订单。")
    if group["phase"] != "distributed":
        raise ApiError(409, "not_distributed", "请等团长签收入库并分货。")
    status, order_id = order["status"], order["id"]
    if action == "receive":
        if status == "received":
            return
        if status not in ("paid", "reshipping"):
            raise ApiError(409, "wrong_status", "当前订单不能签收，请查看异议处理记录。")
        settle(db, group, order_id, now)
        return

    reason = payload.get("reason")
    if reason not in REASONS:
        raise ApiError(400, "invalid_reason", "请选择列表中的异议原因。")
    attempt = request_round(payload)
    current = order["dispute_round"]
    if attempt < current or (attempt == current and order["reason"] == reason):
        return
    if attempt != current + 1 or status not in ("paid", "reshipping"):
        raise ApiError(409, "wrong_status", "请刷新订单，确认当前异议轮次和补发状态。")
    db.execute("""UPDATE role_orders SET status='disputed',reason=?,dispute_round=?,resolution=NULL
                  WHERE group_id=? AND id=?""", (reason, attempt, group_id, order_id))
    event(db, group_id, now, "团员", "单份异议",
          f"{order_id} 第 {attempt} 次提出异议，暂停结算 ¥{group['locked_unit'] + FEE}，其余订单继续。", order_id)


def request_round(payload):
    attempt = payload.get("round", 1)
    if type(attempt) is not int or attempt < 1:
        raise ApiError(400, "invalid_round", "异议轮次应为正整数。")
    return attempt


def resolve(db, group, action, payload, now):
    order_id = payload.get("orderId")
    if not isinstance(order_id, str):
        raise ApiError(400, "missing_order", "请选择要处理的订单。")
    order = db.execute("SELECT * FROM role_orders WHERE group_id=? AND id=?", (group["id"], order_id)).fetchone()
    if not order:
        raise ApiError(404, "order_not_found", "本团没有该订单。")
    attempt = request_round(payload)
    current = order["dispute_round"]
    if attempt < current or (attempt == current and order["resolution"] == action):
        return
    if order["status"] != "disputed" or attempt != current:
        raise ApiError(409, "not_disputed", "只有异议待处理的订单可退款或补发。")
    if action == "refund":
        status, title = "refunded", "同意异议退款"
        detail = f"工厂同意 {order_id} 第 {attempt} 次异议申请，退还剩余商品款与服务费 ¥{group['locked_unit'] + FEE}。"
    else:
        status, title = "reshipping", "单份补发"
        detail = f"{order_id} 已模拟补发，余款继续暂存，待本人签收。"
    db.execute("UPDATE role_orders SET status=?,resolution=? WHERE group_id=? AND id=?", (status, action, group["id"], order_id))
    event(db, group["id"], now, "工厂", title, detail, order_id)
    if action == "refund":
        event(db, group["id"], now, "模拟支付渠道", "异议退款到账",
              f"{order_id} 余款 ¥{group['locked_unit'] + FEE} 已原路退回，本单累计退回 ¥{PREPAID}。", order_id)


def act(db, id, buyer, action, payload, now):
    group = db.execute("SELECT * FROM role_groups WHERE id=?", (id,)).fetchone()
    if not group:
        raise ApiError(404, "not_found", "未找到这个演示团。")
    if action == "read":
        return snapshot(db, group, buyer)
    if not isinstance(payload, dict):
        raise ApiError(400, "invalid_payload", "操作参数格式错误。")
    if action in MANAGER_ACTIONS and buyer != group["creator"]:
        raise ApiError(403, "not_manager", "仅建团浏览器可操作工厂或团长步骤。")
    if action == "accept":
        accept_orders(db, group, payload, now)
    elif action in ("close", "ship", "distribute"):
        advance_group(db, group, action, now)
    elif action in ("refund", "reship"):
        resolve(db, group, action, payload, now)
    elif action in ("join", "receive", "dispute"):
        buyer_action(db, group, buyer, action, payload, now)
    else:
        raise ApiError(404, "not_found", "未找到这个演示动作。")
    group = db.execute("SELECT * FROM role_groups WHERE id=?", (id,)).fetchone()
    return snapshot(db, group, buyer)
