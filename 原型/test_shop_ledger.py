import sqlite3
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import shop_ledger as ledger
import shop_service as shop


class LedgerTest(unittest.TestCase):
    group = 'ab1234567890'
    event = group + '-00001'
    sender = '0x' + '12' * 20
    address = '0x' + '34' * 20
    digest = '56' * 32
    tx_hash = '0x' + '78' * 32
    block_hash = '0x' + '90' * 32

    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        shop.init_shop_db(self.db)
        self.db.execute('INSERT INTO shop_events VALUES(?,?,?,?,?)', (self.group, 1, self.event, '{}', self.digest))
        self.db.execute('''CREATE TABLE shop_anchors (event_id TEXT PRIMARY KEY, tx TEXT NOT NULL,
            raw TEXT NOT NULL, block INTEGER, block_hash TEXT, recorded_from TEXT NOT NULL)''')
        self.db.execute('INSERT INTO shop_anchors VALUES(?,?,?,?,?,?)',
                        (self.event, self.tx_hash, '0x01', 1, self.block_hash, self.sender))
        self.db.commit()
        ledger.init_ledger(self.db)
        self.db.commit()

    def config(self):
        account = Mock(address=self.sender)
        account.sign_transaction.return_value = SimpleNamespace(raw_transaction=b'\x02\x01',
                                                               hash=bytes.fromhex(self.tx_hash[2:]))
        return ledger.ContractLedger(address=self.address, account=account,
            rpc_url='https://private.invalid/key', public_rpc='https://public.invalid')

    def proof(self, config=None):
        snapshot = {'id': self.group, 'events': [{'id': self.event}]}
        return ledger.attach_anchors(self.db, snapshot, config)

    def test_network_switch_does_not_relabel_local_receipt(self):
        self.assertTrue(hasattr(ledger, 'ContractLedger'), 'Monad contract mode is missing')
        self.assertEqual(self.proof()['events'][0]['tx'], self.tx_hash)
        proof = self.proof(self.config())
        self.assertEqual(proof['ledger']['rpc'], 'https://public.invalid')
        self.assertEqual(proof['events'][0]['chainStatus'], 'pending')
        self.assertNotIn('tx', proof['events'][0])

    def test_persisted_transaction_is_reused_after_lost_broadcast_response(self):
        self.assertTrue(hasattr(ledger, 'ContractLedger'), 'Monad contract mode is missing')
        config = self.config()
        state = {'sent': False}

        def rpc(method, params=()):
            if method == 'eth_getTransactionReceipt':
                if not state['sent']:
                    return None
                log = {'address': self.address, 'topics': [config.topic, '0x' + self.digest], 'data': '0x'}
                return {'status':'0x1', 'transactionHash':self.tx_hash, 'blockNumber':'0x11',
                        'blockHash':self.block_hash, 'to':self.address, 'from':self.sender,
                        'logs':[log]}
            if method == 'eth_sendRawTransaction':
                self.assertEqual(self.proof(config)['events'][0]['tx'], self.tx_hash)
                self.assertEqual(params, ['0x0201'])
                state['sent'] = True
                raise TimeoutError('broadcast response was lost')
            return {'eth_chainId':'0x279f', 'eth_call':'0x' + '0' * 24 + self.sender[2:],
                    'eth_getTransactionCount':'0x0', 'eth_estimateGas':'0x6000',
                    'eth_getBlockByNumber':{'baseFeePerGas':'0x20'}, 'eth_maxPriorityFeePerGas':'0x1'}[method]

        def writer():
            result = ledger.AnchorWriter(Path(':memory:'), config)
            result.rpc = rpc
            return result

        with self.assertRaises(TimeoutError):
            writer().anchor_next(self.db)
        self.assertEqual(self.proof(config)['events'][0]['chainStatus'], 'pending')
        self.assertTrue(writer().anchor_next(self.db))
        config.account.sign_transaction.assert_called_once()
        self.assertEqual(self.proof(config)['events'][0]['block'], 17)
        self.assertEqual(self.proof()['events'][0]['block'], 1)

    def test_incorrect_event_marks_only_that_anchor_failed(self):
        config = self.config()
        writer = ledger.AnchorWriter(Path(':memory:'), config)
        with self.db:
            self.db.execute('''INSERT INTO shop_ledger_anchors(scope,event_id,tx,raw,recorded_from)
                VALUES (?,?,?,?,?)''', (config.scope, self.event, self.tx_hash, '0x01', self.sender))
        receipt = {'status':'0x1', 'transactionHash':self.tx_hash, 'blockNumber':'0x11',
                   'blockHash':self.block_hash, 'to':self.address, 'from':self.sender, 'logs':[]}
        writer.rpc = lambda method, params=(): {'eth_chainId':'0x279f', 'eth_getTransactionReceipt':receipt}[method]
        with self.assertLogs(ledger.LOG, level='WARNING'):
            self.assertTrue(writer.anchor_next(self.db))
        self.assertEqual(self.proof(config)['events'][0]['chainStatus'], 'failed')
        self.assertFalse(writer.anchor_next(self.db))

    def test_type_two_transaction_can_be_recovered_to_the_publisher(self):
        try:
            from eth_account import Account
            from eth_utils import keccak
        except ImportError:
            self.skipTest('requirements-chain.txt is optional for local preview')
        account = Account.create()
        config = ledger.ContractLedger(address='0x' + 'ab' * 20, account=account,
            rpc_url='https://private.invalid/key', public_rpc='https://public.invalid')
        writer = ledger.AnchorWriter(Path(':memory:'), config)
        writer.rpc = lambda method, params=(): {
            'eth_call':'0x' + '0' * 24 + account.address[2:].lower(),
            'eth_getTransactionCount':'0x0', 'eth_estimateGas':'0x6000',
            'eth_getBlockByNumber':{'baseFeePerGas':'0x20'}, 'eth_maxPriorityFeePerGas':'0x1'}[method]
        sender, tx_hash, raw = writer.signed_transaction(self.digest)
        self.assertTrue(raw.startswith('0x02'))
        self.assertEqual(sender, account.address)
        self.assertEqual(Account.recover_transaction(raw), sender)
        self.assertEqual(tx_hash, '0x' + keccak(hexstr=raw).hex())
