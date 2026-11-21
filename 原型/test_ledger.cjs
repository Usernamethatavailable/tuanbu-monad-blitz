const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const script = readFileSync(require.resolve('./ledger.js'), 'utf8');
const groupId = '8fe4c84714bd';
const eventId = groupId + '-00002';
const transaction = '0x' + 'a'.repeat(64);
const blockHash = '0x' + 'b'.repeat(64);
const address = '0x' + 'c'.repeat(40);
const publisher = '0x' + 'd'.repeat(40);
const topic = '0x' + 'e'.repeat(64);
const explorer = 'https://testnet.monadscan.com';

class Element {
  constructor() {
    this.children = [];
    this.dataset = {};
    this.events = {};
  }
  addEventListener(name, fn) { this.events[name] = fn; }
  append(...children) { this.children.push(...children); }
  querySelectorAll() { return []; }
  replaceChildren(...children) { this.children = children; }
  showModal() { this.open = true; }
  close() { this.open = false; this.events.close(); }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  setAttribute(name, value) { this[name] = value; }
}

const descendants = el => el.children.flatMap(child => [child, ...descendants(child)]);

function proof({ local = false, shared = false, stages = false, clipboardAllowed = true, mutate = () => {} } = {}) {
  const body = new Element();
  const dialog = new Element();
  const elements = { 'proof-body': body, 'proof-panel': dialog, 'proof-title': new Element(), 'proof-close': new Element() };
  const document = new Element();
  document.getElementById = id => elements[id];
  document.createElement = tag => Object.assign(new Element(), { tag });
  const publicRecord = { at: 1, detail: '测试报价', groupId, id: eventId };
  const digest = createHash('sha256').update(JSON.stringify(publicRecord)).digest('hex');
  const record = {
    id: eventId, public: publicRecord, digest, tx: transaction, block: 123, blockHash, action: 'propose',
    submittedBy: publisher, chainStatus: 'confirmed', role: '工厂', at: 1, title: '工厂报价'
  };
  const network = { name: '本地测试链', chainId: 31337, rpc: 'http://127.0.0.1:18545', address, marker: '0x5455414e05' };
  if (!local) Object.assign(network, { name: 'Monad 测试网', chainId: 10143, rpc: 'https://rpc.example.test',
    marker: '0xa1b2c3d4', topic, publisher, explorer });
  const tx = { input: network.marker + digest, to: address, from: publisher, hash: transaction, blockHash, blockNumber: '0x7b' };
  const receipt = { status: '0x1', transactionHash: transaction, blockHash, blockNumber: '0x7b',
    logs: local ? [] : [{ address, topics: [topic, '0x' + digest], data: '0x' }] };
  const replies = { eth_chainId: '0x' + network.chainId.toString(16), eth_getTransactionByHash: tx, eth_getTransactionReceipt: receipt };
  mutate({ record, network, tx, receipt, replies });
  const location = new URL('https://demo.example/shop.html?shop=' + groupId + (shared ? '&proof=' + eventId : '') + '#buyer');
  const clipboard = [];
  runInNewContext(script, {
    document, URL, location, AbortSignal, TextEncoder, crypto: webcrypto,
    navigator: clipboardAllowed ? { clipboard: { writeText: async value => clipboard.push(value) } } : {},
    window: { tuanbuShopSnapshot: () => ({ id: groupId, events: [record], ledger: network }) },
    fetch: async (_url, options) => {
      const result = replies[JSON.parse(options.body).method];
      if (result instanceof Error) throw result;
      return { ok: true, json: async () => ({ result }) };
    }
  });
  if (shared) document.events['shop:update']();
  else document.events.click({ target: { closest: () => ({ dataset: { eventId: stages ? undefined : eventId } }) } });
  return { body, dialog, clipboard, update: document.events['shop:update'] };
}

async function verify(options) {
  const { body } = proof(options);
  body.children.find(el => el.textContent === '独立核验').events.click();
  const result = body.children.find(el => el.role === 'status');
  for (let i = 0; i < 100 && result.textContent.startsWith('正在'); i++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  return result.textContent;
}

test('checks a successful Monad contract receipt and its digest event', async () => {
  assert.match(await verify(), /^核对通过/);
  assert.match(await verify({ mutate: ({ receipt }) => { receipt.logs = []; } }), /^核对未通过/);
  assert.match(await verify({ mutate: ({ receipt }) => { receipt.logs[0].address = publisher; } }), /^核对未通过/);
  assert.match(await verify({ mutate: ({ receipt }) => { receipt.logs[0].topics[1] = topic; } }), /^核对未通过/);
  assert.match(await verify({ mutate: ({ receipt }) => { receipt.logs[0].removed = true; } }), /^核对未通过/);
});

test('rejects a substituted publisher, chain, or quote', async () => {
  assert.match(await verify({ mutate: ({ record, tx }) => { record.submittedBy = tx.from = address; } }), /^核对未通过/);
  assert.match(await verify({ mutate: ({ replies }) => { replies.eth_chainId = '0x1'; } }), /^核对未通过/);
  assert.match(await verify({ mutate: ({ record }) => { record.public.detail = '报价已更改'; } }), /^核对未通过/);
});

test('keeps existing local transaction proofs usable', async () => {
  assert.match(await verify({ local: true }), /^核对通过/);
});

test('leaves verification available when the explorer configuration is invalid', async () => {
  assert.match(await verify({ mutate: ({ network }) => { network.explorer = 'not-an-https-url'; } }), /^核对通过/);
});

test('reports an unavailable RPC separately from a failed proof', async () => {
  assert.match(await verify({ mutate: ({ replies }) => { replies.eth_chainId = new Error('offline'); } }), /无法连接链节点/);
  assert.match(await verify({ mutate: ({ replies }) => { replies.eth_getTransactionReceipt = null; } }), /^核对未通过/);
});

test('shares a single receipt with a fresh visitor and links its explorer transaction', async () => {
  const sender = proof();
  const buyer = proof({ shared: true });
  assert.equal(buyer.dialog.open, true);
  assert.equal(buyer.body.children.find(el => el.tag === 'h3').textContent, '工厂报价');
  assert.equal(descendants(buyer.body).find(el => el.tag === 'a').href, explorer + '/tx/' + transaction);
  buyer.dialog.close();
  buyer.update();
  assert.equal(buyer.dialog.open, false);
  await descendants(sender.body).find(el => el.textContent === '复制单据链接').events.click();
  assert.equal(sender.clipboard[0], 'https://demo.example/shop.html?shop=' + groupId + '&proof=' + eventId + '#buyer');
});

test('lets the sender select the link when clipboard access is unavailable', async () => {
  const { body } = proof({ clipboardAllowed: false });
  await descendants(body).find(el => el.textContent === '复制单据链接').events.click();
  const input = descendants(body).find(el => el.tag === 'input');
  assert.equal(input['aria-label'], '单据链接');
  assert.equal(input.focused, true);
  assert.equal(input.selected, true);
  assert.equal(new URL(input.value).searchParams.get('proof'), eventId);
});

test('shows rejected writes in the proof and stage without offering verification', () => {
  const mutate = ({ record }) => { record.chainStatus = 'failed'; };
  const details = descendants(proof({ mutate }).body);
  const stages = descendants(proof({ mutate, stages: true }).body);
  assert.equal(details.some(el => el.textContent === '写入失败'), true);
  assert.equal(details.some(el => el.textContent === '独立核验'), false);
  assert.equal(stages.some(el => el.textContent === '写入失败'), true);
});
