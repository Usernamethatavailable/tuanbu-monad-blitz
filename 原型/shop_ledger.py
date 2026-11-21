"""Anchor committed shop events through a contract or the local Anvil preview."""

import json
import logging
import os
import re
import sqlite3
import threading
import time
import urllib.request
from contextlib import closing
from dataclasses import dataclass, field
from urllib.parse import urlsplit


LOCAL_RPC = "http://127.0.0.1:18545"
CHAIN_ID = 31337
MARKER = "0x5455414e05"
RECORD_ADDRESS = "0x0000000000000000000000000000000000545541"
LOCAL_SCOPE = "anvil-preview"
MONAD_CHAIN_ID = 10143
MONAD_RPC = "https://testnet-rpc.monad.xyz"
ANCHOR_SELECTOR = "0xeecdf927"  # anchor(bytes32)
PUBLISHER_SELECTOR = "0x8c72c54e"  # publisher()
ANCHORED_TOPIC = "0xc8f7565859107929ba4b285bfb17dfba069f69ab64447f49d6fecb70f6bd552b"
MAX_GAS = 50_000
MAX_FEE_PER_GAS = 500_000_000_000  # Testnet ceiling of 500 gwei.
LOG = logging.getLogger(__name__)


@dataclass(frozen=True)
class ContractLedger:
    address: str
    account: object = field(repr=False)
    rpc_url: str = field(repr=False)
    public_rpc: str
    chain_id: int = MONAD_CHAIN_ID
    name: str = "Monad 测试网"
    explorer: str = "https://testnet.monadscan.com"

    @property
    def scope(self):
        return f"{self.chain_id}:{self.address.lower()}"

    @property
    def topic(self):
        return ANCHORED_TOPIC

    def metadata(self):
        return {"name": self.name, "chainId": self.chain_id, "rpc": self.public_rpc,
                "address": self.address, "marker": ANCHOR_SELECTOR, "topic": self.topic,
                "explorer": self.explorer, "publisher": self.account.address}


def load_monad_config():
    address = os.environ.get("TUANBU_MONAD_CONTRACT", "").strip()
    secret = os.environ.get("TUANBU_MONAD_PRIVATE_KEY", "").strip()
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", address) or int(address, 16) == 0:
        raise ValueError("TUANBU_MONAD_CONTRACT must be the deployed Monad Testnet contract address")
    if not re.fullmatch(r"(?:0x)?[0-9a-fA-F]{64}", secret):
        raise ValueError("TUANBU_MONAD_PRIVATE_KEY must be supplied as a server secret")
    try:
        from eth_account import Account
        from eth_utils import to_checksum_address
    except ImportError:
        raise ValueError("Install the dependencies in requirements-chain.txt") from None
    try:
        account = Account.from_key(secret)
    except (ValueError, TypeError):
        raise ValueError("TUANBU_MONAD_PRIVATE_KEY is invalid") from None
    for name in ("TUANBU_MONAD_RPC_URL", "TUANBU_MONAD_PUBLIC_RPC_URL"):
        try:
            url = urlsplit(os.environ.get(name, MONAD_RPC))
            if url.scheme == "https" and url.hostname and not url.username and not url.password and not url.fragment:
                continue
        except ValueError:
            pass
        raise ValueError(f"{name} must be an HTTPS RPC URL")
    return ContractLedger(to_checksum_address(address), account,
                          os.environ.get("TUANBU_MONAD_RPC_URL", MONAD_RPC),
                          os.environ.get("TUANBU_MONAD_PUBLIC_RPC_URL", MONAD_RPC))


def init_ledger(db):
    db.execute("""CREATE TABLE IF NOT EXISTS shop_ledger_anchors (
        scope TEXT NOT NULL, event_id TEXT NOT NULL, tx TEXT NOT NULL, raw TEXT NOT NULL,
        block INTEGER, block_hash TEXT, recorded_from TEXT NOT NULL, failure TEXT,
        PRIMARY KEY(scope,event_id)
    )""")
    if "failure" not in {row[1] for row in db.execute("PRAGMA table_info(shop_ledger_anchors)")}:
        db.execute("ALTER TABLE shop_ledger_anchors ADD COLUMN failure TEXT")
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='shop_anchors'").fetchone():
        db.execute("""INSERT OR IGNORE INTO shop_ledger_anchors(scope,event_id,tx,raw,block,block_hash,recorded_from)
            SELECT ?, event_id, tx, raw, block, block_hash, recorded_from FROM shop_anchors""", (LOCAL_SCOPE,))


def attach_anchors(db, snapshot, config=None):
    scope = config.scope if config else LOCAL_SCOPE
    found = {row["event_id"]: row for row in db.execute("""SELECT a.* FROM shop_ledger_anchors a
        JOIN shop_events e ON e.event_id=a.event_id WHERE a.scope=? AND e.group_id=?""",
        (scope, snapshot["id"]))}
    for event in snapshot["events"]:
        row = found.get(event["id"])
        event["chainStatus"] = "pending"
        if row:
            if row["failure"]:
                event["chainStatus"] = "failed"
            elif row["block"] is not None:
                event["chainStatus"] = "confirmed"
            event["tx"] = row["tx"]
            event["block"] = row["block"]
            event["blockHash"] = row["block_hash"]
            event["submittedBy"] = row["recorded_from"]
    snapshot["ledger"] = config.metadata() if config else {
        "name": "本地 EVM 测试链", "chainId": CHAIN_ID, "rpc": LOCAL_RPC,
        "address": RECORD_ADDRESS, "marker": MARKER}
    return snapshot


class AnchorWriter(threading.Thread):
    def __init__(self, db_path, config=None):
        super().__init__(daemon=True, name="shop-receipts")
        self.db_path = db_path
        self.config = config
        self.scope = config.scope if config else LOCAL_SCOPE
        self.chain_id = config.chain_id if config else CHAIN_ID
        self.rpc_url = config.rpc_url if config else LOCAL_RPC
        self.publisher_checked = False
        self.wake = threading.Event()
        self.stopping = threading.Event()
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def rpc(self, method, params=()):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        req = urllib.request.Request(self.rpc_url, body, {
            "Content-Type": "application/json", "User-Agent": "TuAnBu/1.0",
        })
        try:
            with self.http.open(req, timeout=4) as response:
                result = json.load(response)
        except (OSError, ValueError) as exc:
            # An exception may contain the provider URL and its credentials.
            raise RuntimeError(f"{method}: {type(exc).__name__}") from None
        if "error" in result:
            error = result["error"]
            message = str(error.get("message", "")).lower()
            for reason in ("already known", "insufficient funds", "nonce too low", "underpriced"):
                if reason in message:
                    raise RuntimeError(f"{method}: {reason}")
            raise RuntimeError(f"{method}: JSON-RPC error {error.get('code', 'unknown')}")
        return result["result"]

    def signed_transaction(self, digest):
        config = self.config
        if config is None:
            sender = self.rpc("eth_accounts")[0]
            nonce = self.rpc("eth_getTransactionCount", [sender, "pending"])
            tx = {"from": sender, "to": RECORD_ADDRESS, "nonce": nonce, "data": MARKER + digest,
                  "value": "0x0", "gas": hex(MAX_GAS), "gasPrice": hex(30_000_000_000),
                  "chainId": hex(CHAIN_ID)}
            raw = self.rpc("eth_signTransaction", [tx])
            return sender, self.rpc("web3_sha3", [raw]), raw

        sender = config.account.address
        if not self.publisher_checked:
            word = self.rpc("eth_call", [{"to": config.address, "data": PUBLISHER_SELECTOR}, "latest"])
            if word.lower() != "0x" + "0" * 24 + sender[2:].lower():
                raise RuntimeError("ReceiptRegistry publisher does not match the configured signer")
            self.publisher_checked = True
        call = {"to": config.address, "data": ANCHOR_SELECTOR + digest}
        base_fee = int(self.rpc("eth_getBlockByNumber", ["latest", False])["baseFeePerGas"], 16)
        tip = int(self.rpc("eth_maxPriorityFeePerGas"), 16)
        if base_fee + tip > MAX_FEE_PER_GAS:
            raise RuntimeError("Testnet gas price exceeds the configured ceiling")
        # A fixed ceiling leaves room for base-fee movement while persisted bytes await broadcast.
        max_fee = MAX_FEE_PER_GAS
        estimate = int(self.rpc("eth_estimateGas", [{
            **call, "from": sender, "maxFeePerGas": hex(max_fee), "maxPriorityFeePerGas": hex(tip)
        }]), 16)
        gas = min(MAX_GAS, estimate + estimate // 10)
        if not 21_000 <= estimate <= gas:
            raise RuntimeError("ReceiptRegistry gas estimate is outside the expected range")
        nonce = int(self.rpc("eth_getTransactionCount", [sender, "pending"]), 16)
        tx = config.account.sign_transaction({
            "to": bytes.fromhex(config.address[2:]), "data": call["data"], "type": 2,
            "chainId": config.chain_id, "nonce": nonce, "value": 0, "gas": gas,
            "maxFeePerGas": max_fee, "maxPriorityFeePerGas": tip
        })
        return sender, "0x" + bytes(tx.hash).hex(), "0x" + bytes(tx.raw_transaction).hex()

    def anchor_next(self, db):
        row = db.execute("""SELECT e.event_id, e.digest, a.tx, a.raw, a.recorded_from FROM shop_events e
            LEFT JOIN shop_ledger_anchors a ON e.event_id=a.event_id AND a.scope=?
            WHERE a.block IS NULL AND a.failure IS NULL ORDER BY e.rowid LIMIT 1""", (self.scope,)).fetchone()
        if row is None:
            return False
        if int(self.rpc("eth_chainId"), 16) != self.chain_id:
            raise RuntimeError("Unexpected chain ID")
        event, digest, tx_hash, raw, sender = row
        if raw is None:
            sender, tx_hash, raw = self.signed_transaction(digest)
            with db:
                db.execute("INSERT INTO shop_ledger_anchors(scope,event_id,tx,raw,recorded_from) VALUES(?,?,?,?,?)",
                           (self.scope, event, tx_hash, raw, sender))
        # The same signed bytes can be safely rebroadcast after a timeout or restart.
        receipt = self.rpc("eth_getTransactionReceipt", [tx_hash])
        if receipt is None:
            try:
                self.rpc("eth_sendRawTransaction", [raw])
            except RuntimeError as exc:
                if not str(exc).endswith(": already known"):
                    raise
            receipt = self.rpc("eth_getTransactionReceipt", [tx_hash])
        if receipt is None:
            return False
        if receipt.get("transactionHash", "").lower() != tx_hash.lower():
            raise RuntimeError("Anchor receipt hash mismatched")
        failure = None
        if self.config:
            address = self.config.address.lower()
            valid_log = any(
                log.get("address", "").lower() == address and
                log.get("topics") == [self.config.topic, "0x" + digest] and
                log.get("data") == "0x" and not log.get("removed")
                for log in receipt.get("logs", [])
            )
            if receipt.get("status") == "0x0":
                failure = "交易执行失败"
            elif (receipt.get("to", "").lower() != address or receipt.get("from", "").lower() != sender.lower()
                    or not valid_log):
                failure = "回执缺少匹配的 Anchored 事件"
        if failure:
            with db:
                db.execute("UPDATE shop_ledger_anchors SET failure=? WHERE scope=? AND event_id=?",
                           (failure, self.scope, event))
            LOG.warning("链上单据写入失败 (%s): %s", failure, tx_hash)
            return True
        if receipt.get("status") != "0x1":
            raise RuntimeError("Anchor receipt does not report success")
        with db:
            db.execute("UPDATE shop_ledger_anchors SET block=?, block_hash=? WHERE scope=? AND event_id=?",
                       (int(receipt["blockNumber"], 16), receipt["blockHash"], self.scope, event))
        return True

    def run(self):
        next_log = 0
        with closing(sqlite3.connect(self.db_path, timeout=5)) as db:
            while not self.stopping.is_set():
                try:
                    if self.anchor_next(db):
                        continue
                except (OSError, RuntimeError, sqlite3.Error, ValueError, TypeError, KeyError, IndexError) as exc:
                    if self.config and time.monotonic() >= next_log:
                        reason = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
                        LOG.warning("链上单据仍待写入 (%s)", reason)
                        next_log = time.monotonic() + 30
                self.wake.wait(1.5)
                self.wake.clear()
