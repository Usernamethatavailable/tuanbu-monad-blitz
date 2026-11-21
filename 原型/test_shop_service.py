"""Run from this directory with python -B -m unittest -v test_shop_service."""

import hashlib
import json
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

import shop_service as shop
from roles_service import ApiError


class ShopTests(unittest.TestCase):
    now = 1795240000

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / "shop.sqlite"
        with closing(self.connect()) as db, db:
            shop.init_shop_db(db)

    def connect(self):
        db = sqlite3.connect(self.path, timeout=8)
        db.row_factory = sqlite3.Row
        return db

    def create(self, seeds=0):
        with closing(self.connect()) as db, db:
            self.gid = shop.create_shop(db, "manager", self.now, {"seedCount": seeds})["id"]
        for action in ("propose", "quote", "publish"):
            self.call(action)

    def call(self, action, actor="manager", data=None):
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            result = shop.act_shop(db, self.gid, actor, action, data or {}, self.now)
        self.conserved(result)
        return result

    def read(self, actor="manager", role=None):
        with closing(self.connect()) as db:
            return shop.read_shop(db, self.gid, actor, role=role)

    def conserved(self, snapshot):
        t = snapshot["totals"]
        self.assertEqual(t["prepaid"], 91 * snapshot["paidCount"])
        self.assertEqual(t["prepaid"], t["held"] + t["factoryPaid"] + t["leaderPaid"] + t["refunded"])
        self.assertEqual(t["leaderDue"], t["leaderPaid"] + t["leaderPending"])

    def signed_up(self, actor, bear=0, rabbit=0):
        items = [{"sku": sku, "qty": qty} for sku, qty in (("bear", bear), ("rabbit", rabbit)) if qty]
        return self.call("respond", actor, {"items": items, "recipientId": "leaf"})["mine"]

    def decide(self, **decisions):
        return self.call("accept", data={"decisions": [
            {"sku": sku, "decision": value, "reason": "面料缺货" if value == "reject" else ""}
            for sku, value in decisions.items()]})

    def pay(self, actor):
        return self.call("pay", actor, {"items": self.read(actor)["mine"]["paymentItems"]})

    def deliver(self):
        self.call("start")
        self.call("ship", data={"carrier": "顺丰速运", "trackingNumber": "SF-DEMO-20261121"})
        self.call("receive-batch")
        return self.call("distribute")

    def denied(self, code, action, actor="manager", data=None):
        before = self.read()
        with self.assertRaises(ApiError) as error:
            self.call(action, actor, data)
        self.assertEqual(code, error.exception.code)
        self.assertEqual(before, self.read())

    def progress(self):
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            shop.progress_shop(db, self.gid, self.now)
        state = self.read()
        self.conserved(state)
        return state

    def limited(self, cap):
        return self.call("accept", data={"decisions": [{"sku": "bear", "decision": "accept"},
            {"sku": "rabbit", "decision": "accept", "limit": cap}]})

    def test_real_buyers_compete_and_explicit_partial_cart_is_idempotent(self):
        self.create()
        for actor in ("alice", "bob"):
            self.signed_up(actor, bear=1, rabbit=2)
        self.call("submit-production")
        self.limited(3)
        self.assertEqual(self.read("visitor")["notices"][-1]["remaining"], 3)
        def buy(actor):
            try:
                self.call("pay", actor, {"requestId": "mix", "items": [{"sku": "bear", "qty": 1}, {"sku": "rabbit", "qty": 2}]})
                return actor, "paid"
            except ApiError as error:
                return actor, error.code
        with ThreadPoolExecutor(max_workers=2) as pool:
            result = dict(pool.map(buy, ("alice", "bob")))
        self.assertEqual(sorted(result.values()), ["paid", "stock_short"])
        loser = next(a for a, v in result.items() if v != "paid")
        snapshot = self.read(loser)
        self.assertEqual((snapshot["paidCount"], snapshot["mine"]["prepaid"], snapshot["mine"]["paymentBlocked"]), (3, 0, True))
        self.assertEqual(snapshot["mine"]["items"][1]["availableQty"], 1)
        cart = {"requestId": "adjusted", "items": [{"sku": "rabbit", "qty": 1}]}
        first = self.call("pay", loser, cart)
        self.assertEqual(first, self.call("pay", loser, cart))
        self.denied("request_conflict", "pay", loser, {"requestId": "adjusted", "items": [{"sku": "bear", "qty": 1}]})
        self.denied("stock_short", "pay", loser, {**cart, "requestId": "another"})
        final = self.call("pay", loser, {"requestId": "just-bear", "items": [{"sku": "bear", "qty": 1}]})
        self.assertEqual((final["paidCount"], final["skuSummary"][1]["remaining"], final["mine"]["paidQty"]), (5, 0, 2))

    def test_migrate_legacy_paid_boolean_preserves_receipts_and_frozen_amounts(self):
        self.create()
        self.signed_up("alice", bear=100)
        self.call("submit-production")
        self.decide(bear="accept")
        self.pay("alice")
        before = self.call("close-pay")
        with closing(self.connect()) as db, db:
            db.execute("ALTER TABLE shop_items DROP COLUMN paid_qty")
            shop.init_shop_db(db)
            # A previous release could persist ALTER TABLE but roll back its backfill.
            db.execute("UPDATE shop_items SET paid_qty=0 WHERE paid=1")
            shop.init_shop_db(db)
        after = self.read()
        self.assertEqual((after["events"], after["totals"], after["paidCount"]), (before["events"], before["totals"], 100))

    def test_limited_fixture_competition_and_independent_seed_receipts(self):
        self.create(99)
        self.signed_up("alice", bear=1, rabbit=1)
        self.call("submit-production")
        first = self.limited(4)
        self.assertEqual((first["signupCount"], first["paidCount"], first["skuSummary"][1]["remaining"]), (107, 99, 4))
        self.assertEqual((first["acceptedCount"], first["skuSummary"][1]["acceptedQty"]), (104, 4))
        self.now += 1
        self.pay("alice")
        self.now += 18
        self.assertEqual(self.progress()["paidCount"], 101)
        self.now += 1
        cut = self.call("close-pay")
        self.assertEqual((cut["paidCount"], cut["skuSummary"][1]["remaining"], cut["totals"]["discountRefund"]), (104, 0, 2288))
        self.assertEqual(self.progress()["events"], cut["events"])
        distributed = self.deliver()
        self.assertEqual((distributed["receivedOrderCount"], distributed["totals"]["held"]), (0, 7176))
        self.now += 1
        self.assertEqual(self.progress()["receivedOrderCount"], 0)
        self.now += 1
        progress = self.progress()
        self.assertEqual((progress["receivedOrderCount"], progress["totals"]["held"]), (99, 138))
        for action in ("receive-seed", "settle-seed"):
            events = [e for e in progress["events"] if e["action"] == action]
            self.assertEqual(len({e["orderId"] for e in events}), 99)
        self.assertEqual(progress, self.progress())
        final = self.call("receive", "alice")["totals"]
        self.assertEqual((final["prepaid"], final["factoryPaid"], final["leaderPaid"], final["held"]), (9464, 6864, 312, 0))

    def ship_hundred(self):
        self.create()
        self.signed_up("alice", bear=100)
        self.call("submit-production")
        self.decide(bear="accept")
        self.pay("alice")
        self.call("close-pay")
        self.call("start")
        self.call("ship", data={"carrier": "顺丰速运", "trackingNumber": "SF-SAMPLE-100"})
        self.now += 2
        self.progress()

    def test_batch_issue_requires_two_approvals_and_returns_only_remaining_money(self):
        self.ship_hundred()
        data = {"reason": "整箱少件", "quantity": 4}
        issue = self.call("batch-dispute", data=data)
        self.assertEqual(issue["batchIssue"]["deadlineAt"], self.now + 48*3600)
        self.denied("batch_paused", "receive-batch")
        self.denied("not_manager", "batch-refund", "alice", {"role": "团长"})
        first = self.call("batch-refund", data={"role": "工厂"})
        self.assertEqual(first["totals"]["held"], 6900)
        self.assertEqual(first, self.call("batch-refund", data={"role": "工厂"}))
        self.denied("batch_proposal_changed", "batch-refund", data={"role": "团长", "expectedProposal": None})
        confirmed = {"role": "团长", "expectedProposal": "refund", "expectedProposedBy": "工厂"}
        final = self.call("batch-refund", data=confirmed)
        self.assertEqual(final, self.call("batch-refund", data=confirmed))
        self.assertEqual((final["phase"],final["totals"]["batchRefund"],final["totals"]["refunded"],final["totals"]["held"]),
                         ("batch_refunded",6900,9100,0))
        self.assertEqual(final["totals"]["leaderDue"], 0)
        self.assertEqual(self.progress(), final)

    def test_batch_resolution_and_expiry_do_not_settle_member_orders(self):
        self.ship_hundred()
        data = {"reason": "整箱破损", "quantity": 2}
        self.denied("invalid_batch_issue", "batch-dispute", data={**data, "quantity": 101})
        self.now += 48 * 3600
        self.call("batch-dispute", data=data)
        self.call("batch-resolve", data={"role": "团长"})
        self.assertEqual(self.call("batch-resolve", data={"role":"工厂"})["batchIssue"]["status"], "resolved")
        self.now += 1
        self.denied("batch_window_closed", "batch-dispute", data={**data, "quantity": 3})
        self.call("receive-batch")
        self.call("distribute")
        self.assertEqual(self.progress()["receivedOrderCount"], 0)
        self.assertEqual(self.call("receive", "alice")["totals"]["held"], 0)

    def test_mixed_order_at_discount_boundary_and_no_signature_on_distribution(self):
        self.create(99)
        s = self.signed_up("alice", bear=1, rabbit=1)
        self.assertEqual(s["quantity"], 2)
        self.assertEqual((self.read()["signupCount"], self.read()["signupOrderCount"]), (107, 100))
        self.call("submit-production")
        self.decide(bear="accept", rabbit="reject")
        mine = self.read("alice")["mine"]
        self.assertEqual((mine["status"], mine["acceptanceStatus"], mine["payableAmount"]), ("registered", "partial", 91))
        self.pay("alice")
        cut = self.call("close-pay")
        self.assertEqual((cut["paidCount"], cut["paidOrderCount"], cut["unit"]), (100, 100, 66))
        self.assertEqual((cut["totals"]["prepaid"], cut["totals"]["refunded"]), (9100, 2200))
        delivered = self.deliver()
        t = delivered["totals"]
        self.assertEqual((t["held"], t["factoryPaid"], t["leaderPaid"], t["leaderPending"]), (6900, 0, 0, 300))
        self.assertEqual(delivered["receivedOrderCount"], 0)
        self.assertTrue(all(o["status"] == "paid" for o in delivered["orders"]))
        self.assertEqual(self.read()["shipment"]["trackingNumber"], "SF-DEMO-20261121")
        self.denied("not_your_order", "receive", data={"orderId": "DD-001"})
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _: self.call("receive", "alice"), range(4)))
        final = self.read()
        t = final["totals"]
        self.assertEqual((t["held"], t["factoryPaid"], t["leaderPaid"], t["leaderPending"]), (6831, 66, 3, 297))
        self.assertEqual(sum(e["action"] == "settle" for e in final["events"]), 1)

    def test_empty_all_unpaid_or_rejected_can_close(self):
        for case in ("empty", "unpaid", "all_rejected"):
            with self.subTest(case=case):
                self.create()
                if case != "empty":
                    self.signed_up("alice", rabbit=5)
                self.call("submit-production")
                if case == "unpaid":
                    self.decide(rabbit="accept")
                if case == "all_rejected":
                    self.decide(rabbit="reject")
                    self.denied("cannot_pay", "pay", "alice")
                    self.assertEqual(self.read("alice")["mine"]["acceptanceStatus"], "rejected")
                failed = self.call("close-pay")
                self.assertEqual((failed["phase"], failed["paidCount"], failed["totals"]["refunded"]), ("failed", 0, 0))
                self.assertEqual(failed, self.call("close-pay"))

    def test_tiers_and_quantities(self):
        for quantity, unit, refund in ((49, 0, 49 * 91), (50, 88, 0), (99, 88, 0), (100, 66, 2200)):
            with self.subTest(quantity=quantity):
                self.create()
                for invalid in (0, -1, False, 1.5):
                    self.denied("invalid_items", "respond", "alice", {"items": [{"sku": "bear", "qty": invalid}]})
                self.signed_up("alice", bear=quantity)
                self.call("submit-production")
                self.decide(bear="accept")
                self.pay("alice")
                closed = self.call("close-pay")
                self.assertEqual((closed["paidOrderCount"], closed["paidCount"], closed["unit"], closed["totals"]["refunded"]), (1, quantity, unit, refund))

    def test_later_sku_acceptance_needs_separate_payment_confirmation(self):
        self.create()
        self.signed_up("alice", bear=2, rabbit=3)
        self.call("submit-production")
        self.decide(bear="accept")
        first = {"items": self.read("alice")["mine"]["paymentItems"]}
        s = self.call("pay", "alice", first)
        self.assertEqual(s["totals"]["prepaid"], 182)
        self.decide(rabbit="accept")
        self.assertEqual(self.call("pay", "alice", first)["totals"]["prepaid"], 182)
        self.assertEqual(self.call("pay", "alice")["totals"]["prepaid"], 182)
        self.assertEqual(self.pay("alice")["totals"]["prepaid"], 455)

    def test_same_order_has_separate_receipt_amounts_for_both_skus(self):
        self.create()
        self.signed_up("alice", bear=90, rabbit=10)
        self.call("submit-production")
        self.decide(bear="accept", rabbit="accept")
        self.pay("alice")
        self.call("close-pay")
        self.call("start")
        self.denied("invalid_text", "ship", data={"carrier": "顺丰速运", "trackingNumber": ""})
        self.call("ship", data={"carrier": "顺丰速运", "trackingNumber": "SF-SAMPLE-123"})
        self.call("receive-batch")
        self.call("distribute")
        received = self.call("receive", "alice")["mine"]
        by_sku = {line["sku"]: line for line in received["items"]}
        for key in ("goods", "fee", "prepaid", "discountRefund", "factoryPaid", "leaderPaid", "held"):
            self.assertEqual(received[key], sum(line[key] for line in received["items"]))
        self.assertEqual((by_sku["bear"]["discountRefund"], by_sku["rabbit"]["discountRefund"]), (1980, 220))
        self.assertEqual((by_sku["bear"]["factoryPaid"], by_sku["rabbit"]["leaderPaid"]), (5940, 30))
        shipment = self.read()["shipment"]
        proof = shop.shipment_commitment(shipment["carrier"], shipment["trackingNumber"])
        event = next(e for e in self.read()["events"] if e["action"] == "ship")
        self.assertEqual(event["public"]["data"]["shipmentCommitment"], proof)

    def test_private_shipping_public_digest_and_isolated_dispute(self):
        self.create()
        alice = self.signed_up("alice", bear=51, rabbit=1)["id"]
        self.signed_up("bob", bear=50)
        self.call("submit-production")
        self.decide(bear="accept", rabbit="reject")
        for buyer in ("alice", "bob"):
            self.pay(buyer)
        self.call("close-pay")
        self.deliver()
        self.call("receive", "bob")
        self.call("dispute", "alice", {"reason": "分装漏发"})
        self.denied("wrong_role", "refund", data={"orderId": alice, "role": "工厂"})
        before = self.read()["totals"]
        self.assertEqual((before["held"], before["factoryPaid"], before["leaderPaid"]), (51 * 69, 50 * 66, 50 * 3))
        self.call("reship", data={"orderId": alice, "role": "团长"})
        self.call("dispute", "alice", {"reason": "生产质量问题", "round": 2})
        self.call("refund", data={"orderId": alice, "role": "工厂", "round": 2})
        own = self.read("alice")["mine"]
        self.assertEqual((own["refundTotal"], own["leaderPaid"], own["factoryPaid"]), (51 * 91, 0, 0))
        person = own["recipient"]
        self.assertEqual(next(o for o in self.read("manager", "leader")["orders"] if o["id"] == alice)["recipient"], person)
        for actor, role in (("manager", "factory"), ("anon", "leader"), ("bob", "buyer")):
            self.assertNotIn(person["address"], str(self.read(actor, role)))
        bob = self.read("bob")["mine"]["id"]
        settled = self.read()["totals"]
        self.call("manual-claim", "bob", {"reason": "生产质量问题", "note": "私密售后资料甲"})
        self.call("reply-claim", data={"orderId": bob, "role": "工厂", "reply": "私密售后回复乙"})
        self.call("close-claim", data={"orderId": bob, "role": "工厂"})
        self.assertEqual(self.read()["totals"], settled)
        public = self.read("anon")["events"]
        self.assertEqual(len({e["id"] for e in public}), len(public))
        for e in public:
            content = json.dumps(e["public"], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            for private in (person["address"], person["name"], person["phone"], "SF-DEMO-20261121", "私密售后资料甲", "私密售后回复乙"):
                self.assertNotIn(private, content)
            self.assertEqual("0x" + hashlib.sha256(content.encode()).hexdigest(), e["hash"])
            self.assertEqual(e["public"]["quantity"], sum(i["qty"] for i in e["public"]["items"]))
        settlement = next(e["public"] for e in public if e["action"] == "settle")
        self.assertEqual((settlement["orderId"], settlement["quantity"], settlement["amounts"]), (bob, 50, {"factoryPaid": 3300, "leaderPaid": 150}))

    def test_editable_recipient_stays_private_and_order_replay_keeps_confirmation(self):
        self.create(2)
        data = {"items": [{"sku": "bear", "qty": 2}], "recipientId": "leaf"}
        for edit in ({"name": ""}, {"phone": "abc123"}, {"phone": "123-45"}, {"address": "街"},
                     {"address": "路" * 161}, {"name": "王" * 41}):
            self.denied("invalid_recipient", "respond", "alice", {**data, "recipient": edit})
        personal = {"name": "方嘉歆", "phone": "1" + "38" + "0" * 8, "address": "澄川市荷塘路89号杏花苑6栋503室"}
        s = self.call("respond", "alice", {**data, "recipient": personal})
        saved = s["mine"]["recipient"]
        self.assertEqual(saved, {**personal, "id": "leaf"})
        self.assertEqual(saved, self.call("respond","alice",{**data, "recipient":{"name":"重试"}})["mine"]["recipient"])
        self.assertEqual(saved, next(o for o in self.read("manager","leader")["orders"] if o["id"]==s["mine"]["id"])["recipient"])
        for snapshot in (self.read("other","leader"), self.read("manager","factory"), s["events"]):
            encoded = json.dumps(snapshot, ensure_ascii=False)
            self.assertTrue(all(value not in encoded for value in personal.values()))
        base = self.read("bob")["recipientOptions"][1]
        local = "(020) 0000-0208"
        edited = self.call("respond","bob",{**data, "recipient":{"phone":local}})["mine"]["recipient"]
        self.assertEqual(edited,{**base, "phone":local})
        seed = self.read("manager","leader")["orders"][0]["recipient"]
        self.assertNotIn("演示", seed["name"] + seed["address"])
        self.assertTrue(seed["phone"].startswith("000-"))
        self.assertRegex(seed["address"], r"[0-9]+栋[0-9]+室$")

    def test_only_exact_legacy_samples_are_refreshed(self):
        self.create(1)
        self.signed_up("alice", bear=1)
        self.signed_up("bob", bear=1)
        suffix = hashlib.sha256(f"{self.gid}/alice".encode()).hexdigest()[:6].upper()
        old_seed = {"name":"演示拼友001","phone":"000-0000-0001","address":"演示市样品区虚构街 1 号"}
        old = {"id":"leaf","name":"演示拼友小叶·"+suffix,"phone":f"000-{int(suffix,16)%10000:04}-0102",
               "address":"演示市树叶区样品路 2 号 · 演示室 "+suffix}
        edited = {**old, "name":"旧地址自填"}
        with closing(self.connect()) as db, db:
            for doc, oid in ((old_seed,"DD-001"),(old,"DD-002"),(edited,"DD-003")):
                db.execute("UPDATE shop_orders SET recipient=? WHERE gid=? AND id=?", (shop.canonical(doc),self.gid,oid))
            shop.init_shop_db(db)
            shop.init_shop_db(db)
        seed, account, custom = self.read("manager","leader")["orders"]
        self.assertEqual(seed["recipient"],shop.seed_recipient(1))
        self.assertEqual(account["recipient"], self.read("alice")["recipientOptions"][1])
        self.assertEqual(custom["recipient"],edited)


if __name__ == "__main__":
    unittest.main()
