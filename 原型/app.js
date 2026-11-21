(() => {
  'use strict';

  const factory = '山涧布偶工坊';
  const leader = '栗子';
  const groupId = 'TB-1121';
  const deadline = '11 月 21 日 18:00';
  const settings = {
    regular: { otherPaid: 4 },
    unfunded: { otherPaid: 1 },
    standard: { otherPaid: 3 },
    mismatch: { otherPaid: 4, factoryQuantity: 4 }
  };
  const requested = new URLSearchParams(location.search).get('case');
  const scenario = Object.hasOwn(settings, requested) ? requested : 'regular';
  const setup = settings[scenario];
  const storageKey = 'tuanbu:prototype:v2:' + groupId + ':' + scenario;
  const seconds = { cutoff: 20, processing: 27, refunded: 33, accepted: 38, sent: 44, delivered: 50 };
  const terms = [
    ['团号 / 报价版本', groupId + ' / V1'],
    ['商品', '栗栗熊 · 奶油棕 · 20 cm 棉花娃娃'],
    ['制作与收款', factory],
    ['团长', leader + '（负责分发）'],
    ['起订与报价', '3 份起订，3–4 份每份 ¥88，5 份起每份 ¥66。'],
    ['认购费用', '每份预付 ¥88，组织费 ¥0。'],
    ['截止时间', deadline + '（北京时间，模拟日期）'],
    ['结算与退款', '截止时以有效实付份数锁价。未达 3 份原路退全款；达到 5 份每份原路退 ¥22 差价。'],
    ['约定交期', '成团后 30 天内由工厂整批发货；团长签收后分发给团员。'],
    ['约定变更', '首笔付款后收款方、报价和截止时间锁定。需要换厂或加价时，取消原团、办理退款，再另开团。'],
    ['报价确认', factory + ' · SIM-GROUP-01（模拟）']
  ];

  let order = null;
  let view = 'group';
  let sheet = '';
  let sheetVersion = '';
  let restartOrderId = '';
  let storageAvailable = true;
  let mode = 'starting';
  let remote = null;
  let remoteId = '';
  let lastServerTime = 0;
  let lastResponseTime = 0;
  let busy = false;
  let syncing = false;
  let requestNumber = 0;
  let connectivity = '';
  let lastPoll = 0;
  const recentGroupKey = 'tuanbu:last-shared-group';
  const isMember = () => mode === 'shared' ? Boolean(remote?.state.mine) : Boolean(order);
  const publicId = () => mode === 'shared' && remoteId ? remoteId : groupId;
  function activeTerms() {
    return terms.map(([key, value], index) => [key, index === 0 ? publicId() + ' / V1' : value]);
  }

  function loadOrder() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (saved && Number.isSafeInteger(saved.paidAt) && saved.paidAt > 0 &&
          Number.isSafeInteger(saved.receivedAt) && saved.receivedAt >= 0 &&
          Object.keys(seconds).every(key => saved[key] === saved.paidAt + seconds[key] * 1000) &&
          (!saved.receivedAt || saved.receivedAt >= saved.delivered)) return saved;
      return null;
    } catch {
      return order;
    }
  }
  function saveOrder(next) {
    try {
      if (next) localStorage.setItem(storageKey, JSON.stringify(next));
      else localStorage.removeItem(storageKey);
    } catch {
      storageAvailable = false;
    }
    order = next;
  }
  function makeOrder(paidAt) {
    const next = { paidAt, receivedAt: 0 };
    for (const [key, offset] of Object.entries(seconds)) next[key] = paidAt + offset * 1000;
    return next;
  }
  function status(now = Date.now()) {
    if (mode === 'shared' && remote) {
      const { count, closed, accepted, delivery: step, refund: stage } = remote.state;
      const unit = remote.state.unitPrice ?? (count >= 5 ? 66 : 88);
      const failed = closed && count < 3;
      const final = closed ? (failed ? 0 : unit) : null;
      const refund = closed ? (remote.state.duePerOrder ?? (88 - final)) : 0;
      const refundStage = !closed ? 'pending' : !refund ? 'none' : stage === 'none' ? 'due' : stage;
      const mismatch = accepted != null && accepted !== count;
      return { count, unit, closed, failed, final, refund, refundStage, accepted, mismatch,
        sent: step >= 1, delivered: step >= 2, received: step >= 3,
        done: isMember() && (step >= 3 || (failed && refundStage === 'paid')) };
    }
    const count = setup.otherPaid + (order ? 1 : 0);
    const unit = count >= 5 ? 66 : 88;
    const closed = Boolean(order && now >= order.cutoff);
    const failed = closed && count < 3;
    const final = closed ? (failed ? 0 : unit) : null;
    const refund = closed ? 88 - final : 0;
    const refundStage = !closed ? 'pending' : !refund ? 'none' :
      now < order.processing ? 'due' : now < order.refunded ? 'processing' : 'paid';
    const accepted = closed && !failed && now >= order.accepted ? (setup.factoryQuantity ?? count) : null;
    const mismatch = accepted !== null && accepted !== count;
    const sent = accepted !== null && !mismatch && now >= order.sent;
    const delivered = sent && now >= order.delivered;
    const received = delivered && Boolean(order.receivedAt);
    const done = received || (failed && refundStage === 'paid');
    return { count, unit, closed, failed, final, refund, refundStage, accepted, mismatch, sent, delivered, received, done };
  }
  function delivery(s) {
    if (s.failed) return '未成团，无需发货';
    if (s.mismatch) return '接单数量有差异，暂停发货';
    if (s.received) return '我的一份已签收';
    if (s.delivered) return '团长已签收，待我收货';
    if (s.sent) return '工厂已发出，正寄往团长';
    if (s.accepted !== null) return '工厂已接单，制作中';
    return s.closed ? '等待工厂接单' : '成团后安排制作';
  }
  const refundPhrases = { pending: '退款待结算', none: '无需退款', due: '应退金额', processing: '原路退款处理中', paid: '已原路退回' };
  function presentation(s, now) {
    const money = n => '¥' + n;
    const serverNow = lastServerTime + (now - lastResponseTime);
    const remaining = mode === 'shared' && remote?.startedAt ? Math.max(0, Math.ceil((remote.startedAt + seconds.cutoff * 1000 - serverNow) / 1000)) :
      order ? Math.max(0, Math.ceil((order.cutoff - now) / 1000)) : 20;
    const groupHint = s.closed ? (s.failed ? '拼团未成，原路退全款' : '已成团，单价 ' + s.unit + ' 元') :
      s.count >= 5 ? '已到 66 元一份' : '再拼 ' + (5 - s.count) + ' 份，单价降到 66 元';
    const groupPriceNote = s.closed ? '截止共 ' + s.count + ' 份实付。' + (s.refund ? '每份应原路退 ' + s.refund + ' 元。' : '按原报价成交，无需退款。') :
      '已有 ' + s.count + ' 份。先付 88 元，截止满 5 份，每份退 22 元。';
    let title = '已认购，等待截止';
    let hint = '本团已有 ' + s.count + ' 份实付。约 ' + remaining + ' 秒后按有效份数锁定成交价。';
    if (s.closed) {
      title = s.failed ? '未达到起订量' : '已成团，每份 ' + money(s.final);
      hint = s.failed ? '截止仅 ' + s.count + ' 份，不安排生产。你的 ¥88 将原路退回。' : '截止共 ' + s.count + ' 份实付，已按工厂原报价结算。';
    }
    if (s.refundStage === 'processing') hint = '支付渠道已受理 ' + money(s.refund) + ' 退款，正在原路处理。';
    if (s.refundStage === 'paid') hint = '模拟支付渠道已确认 ' + money(s.refund) + ' 退回原付款账户。';
    if (s.failed && s.refundStage === 'paid') title = '未成团，已退全款';
    if (s.mismatch) { title = '接单数量待核对'; hint = '截止实付 ' + s.count + ' 份，工厂仅接 ' + s.accepted + ' 份。已暂停发货，请查看本团记录。'; }
    else if (s.received) { title = '我的一份已签收'; hint = '已保存你的签收回执，可在本团记录中核对。'; }
    else if (s.delivered) { title = '团长已签收整批'; hint = '拿到自己的栗栗熊后，请确认收货。'; }
    else if (s.sent) { title = '工厂已发货'; hint = '整批栗栗熊正在寄往团长，收货后由团长分发。'; }
    else if (s.accepted !== null) { title = '工厂已接单'; hint = factory + '确认制作 ' + s.accepted + ' 份。'; }
    return {
      groupHint, groupPriceNote,
      deadline, primaryLabel: isMember() ? '查看我的订单' : s.closed ? '查看本团记录' : '88 元拼一份',
      orderTitle: title, orderHint: hint, priceLabel: s.closed ? '最终商品金额' : '当前阶梯价',
      finalAmount: money(s.closed ? s.final : s.unit),
      refundLabel: s.closed ? refundPhrases[s.refundStage] : '按当前份数预计退',
      refundAmount: s.closed ? money(s.refund) : money(s.count < 3 ? 88 : 88 - s.unit),
      delivery: delivery(s), payee: factory, count: s.count, unit: s.unit
    };
  }
  function render() {
    const now = Date.now();
    const s = status(now);
    const values = presentation(s, now);
    if (mode === 'starting') {
      values.groupHint = '正在打开这份团单…'; values.groupPriceNote = '';
      values.primaryLabel = '读取团单中';
    }
    if (connectivity) {
      if (view === 'group') { values.groupHint = connectivity; values.groupPriceNote = ''; values.primaryLabel = '重新连接'; }
      else values.orderHint = connectivity;
    }
    document.getElementById('group-view').hidden = view !== 'group';
    document.getElementById('order-view').hidden = view !== 'order';
    document.querySelectorAll('[data-field]').forEach(node => {
      const key = node.dataset.field;
      if (Object.hasOwn(values, key) && node.textContent !== String(values[key])) node.textContent = values[key];
    });
    document.querySelectorAll('[data-action="member"]').forEach(button => { button.hidden = !s.delivered || s.received || !isMember(); button.disabled = busy || Boolean(connectivity); });
    document.querySelectorAll('[data-action="primary"]').forEach(button => { button.disabled = busy || (mode === 'starting' && !connectivity); });
    const version = [s.count, s.closed, s.refundStage, s.accepted, s.sent, s.delivered, s.received, connectivity].join('/');
    if (sheet === 'records' && version !== sheetVersion) fillSheet('records', s);
    sheetVersion = version;
  }
  function showView(next, focus = true) {
    closeSheet();
    view = next === 'order' && isMember() ? 'order' : 'group';
    render();
    if (focus) {
      const title = document.querySelector('#' + view + '-view h1, #' + view + '-view h2');
      if (title) { title.tabIndex = -1; title.focus({ preventScroll: true }); }
      window.scrollTo(0, 0);
    }
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function row(label, value) {
    const line = element('div', undefined, 'sheet-row');
    line.append(element('span', label), element('strong', value));
    return line;
  }
  const note = text => element('p', text, 'sheet-note');
  function button(id, label, primary = false) {
    const node = element('button', label, primary ? 'btn-main' : 'btn-secondary');
    node.dataset.action = id; node.type = 'button';
    return node;
  }
  function actions(...buttons) {
    const line = element('div', undefined, 'sheet-actions');
    line.append(...buttons);
    return line;
  }
  function recordRows(s) {
    if (mode === 'shared' && remote) return remote.state.records;
    const rows = [
      ['11/21 17:30', '拼团单', factory, 'SIM-GROUP-01', '确认 V1 报价、收款方和交期。'],
      ['11/21 17:59', '付款登记', '模拟支付渠道', 'SIM-PAY-BASE', '其他团员合计 ' + setup.otherPaid + ' 份有效实付，每份 ¥88。']
    ];
    if (!order) return rows;
    rows.push(['11/21 17:59:40', '我的付款', '模拟支付渠道', 'SIM-PAY-ME', '向' + factory + '预付 ¥88，认购 1 份。']);
    if (s.closed) rows.push(['11/21 18:00', '截止计价', '模拟团单规则', 'SIM-CLOSE-01',
      '有效实付 ' + s.count + ' 份。' + (s.failed ? '未成团，商品金额 ¥0。' : '成交价每份 ¥' + s.final + '。') + '每份应退 ¥' + s.refund + '。']);
    if (['processing', 'paid'].includes(s.refundStage)) rows.push(['11/21 18:02', '退款处理中', '模拟支付渠道', 'SIM-REFUND-01', '已受理原路退款 ¥' + s.refund + '。']);
    if (s.refundStage === 'paid') rows.push(['11/21 18:08', '退款到账', '模拟支付渠道', 'SIM-REFUND-02', '本订单 ¥' + s.refund + ' 已原路退回。']);
    if (s.accepted !== null) rows.push(['11/22 10:00', '生产单', factory, 'SIM-PROD-01',
      '栗栗熊 20 cm，截止实付 ' + s.count + ' 份，工厂确认接单 ' + s.accepted + ' 份。' + (s.mismatch ? '数量不符，暂停发货。' : '数量一致。')]);
    if (s.sent) rows.push(['12/08 14:30', '交付单 · 发货', factory, 'SIM-SHIP-01', '已将 ' + s.accepted + ' 份整批寄给团长。']);
    if (s.delivered) rows.push(['12/10 10:00', '交付单 · 整批签收', '团长' + leader, 'SIM-LEADER-01', '已签收整批，开始分发给团员。']);
    if (s.received) rows.push(['团长签收后', '交付单 · 单份签收', '我（演示团员）', 'SIM-MEMBER-01', '本人已确认收到 1 份。']);
    return rows;
  }
  function records(s) {
    const list = element('ol', undefined, 'record-list');
    recordRows(s).forEach(([time, label, who, id, detail]) => {
      const item = element('li');
      item.append(element('strong', label + ' · ' + time), element('p', detail), element('small', who + ' · ' + id));
      list.append(item);
    });
    const nodes = [row('团号 / 报价版本', publicId() + ' / V1'), note(mode === 'shared' ?
      '同一团号共享实付数量。付款、退款、工厂和团长回执均为模拟，只有本人能确认自己的一份。' :
      '这是单机体验。记录时间为模拟日期，付款、退款与交付均采用模拟回执。'), list];
    if (!storageAvailable) nodes.push(note('浏览器未允许本地保存，关闭页面后本次订单会丢失。'));
    nodes.push(actions(button('download', '保存团单与记录')));
    if (s.done) nodes.push(actions(button('restart', '重新体验')));
    return nodes;
  }
  function fillSheet(id, s = status()) {
    const titles = { join: '认购一份栗栗熊', group: '拼团约定', records: '本团记录', restart: '重新体验这次拼团？', error: '暂时无法完成操作', share: '分享团单' };
    const body = document.getElementById('detail-body');
    document.getElementById('detail-title').textContent = titles[id];
    let nodes;
    if (id === 'join') nodes = [
      row('商品', '栗栗熊 · 20 cm × 1 份'), row('本次预付', '¥88'), row('收款方', factory),
      note('首位参与者确认模拟付款后约 20 秒截止。按截止份数计价，退款和交付会自动推进；不会扣款。'),
      actions(button('confirm-join', '确认模拟付款 ¥88', true), button('close', '取消'))
    ];
    else if (id === 'group') nodes = [
      ...activeTerms().map(([key, value]) => row(key, value)), note((mode === 'shared' ? '这是共享团单。' : '这是单机体验。') + '首位参与者确认模拟付款后约 20 秒截止计价，约 50 秒走完工厂发货和团长签收。'),
      actions(button('download', '保存团单与记录'), button('sheet-records', '本团记录'), ...(mode === 'shared' ? [button('share', '分享团单')] : []))
    ];
    else if (id === 'records') nodes = records(s);
    else if (id === 'restart') nodes = [note(mode === 'shared' ? '将创建一张新团单。当前团单和其他团员的订单仍可通过原链接查看。' : '将清除这一次的本地模拟订单与签收记录，回到认购前。'), actions(button('confirm-restart', '重新开始'), button('close', '保留当前订单', true))];
    else if (id === 'share') nodes = [note('用同一地址打开即可进入本团。回环地址可在本机的另一个浏览器或无痕窗口使用。'), row('团单链接', location.href), actions(button('copy', '复制团单链接', true))];
    else nodes = [note(connectivity || '本次操作尚未确认，请重新读取团单状态。'), actions(button('retry', '重新读取团单', true), button('close', '关闭'))];
    body.replaceChildren(...nodes);
  }
  function openSheet(id) {
    sheet = id;
    fillSheet(id);
    const dialog = document.getElementById('detail');
    if (!dialog.open) dialog.showModal();
    const heading = document.getElementById('detail-title');
    heading.tabIndex = -1; heading.focus({ preventScroll: true });
    dialog.scrollTop = 0;
    document.getElementById('detail-body').scrollTop = 0;
  }
  function closeSheet() {
    const dialog = document.getElementById('detail');
    sheet = '';
    if (dialog.open) dialog.close();
  }
  function download() {
    const lines = ['团簿 · 拼团约定与本团记录（模拟）', '',
      ...activeTerms().map(([label, value]) => label + '：' + value), '', '本团记录（导出时已发生的回执）',
      ...recordRows(status()).map(([time, label, who, id, detail]) => [time, label, who, id, detail].join(' | '))];
    const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/plain;charset=utf-8' }));
    const link = element('a');
    link.href = url; link.download = publicId() + '-V1-团单副本.txt';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
  function remember(id) {
    try { localStorage.setItem(recentGroupKey, id); } catch { /* The URL also identifies this group. */ }
    const url = new URL(location.href);
    url.searchParams.set('g', id);
    history.replaceState(null, '', url);
  }
  async function request(route, method = 'GET') {
    const response = await fetch('/api/groups' + route, { method, cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(6000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '团单服务暂不可用。');
    if (typeof data.id !== 'string' || !data.state || !Array.isArray(data.state.records)) throw new Error('未收到有效的团单回执。');
    return data;
  }
  function applyRemote(data) {
    remote = data; remoteId = data.id;
    lastServerTime = data.now; lastResponseTime = Date.now(); connectivity = ''; lastPoll = Date.now();
  }
  async function operation(route, method) {
    const token = ++requestNumber;
    const data = await request(route, method);
    if (token === requestNumber) applyRemote(data);
    return token === requestNumber;
  }
  async function connect() {
    const url = new URL(location.href);
    const explicit = url.searchParams.get('g');
    const fixture = scenario !== 'regular';
    let recent = null;
    try { recent = localStorage.getItem(recentGroupKey); } catch { /* Storage may be disabled. */ }
    if (location.protocol === 'file:' || fixture) {
      mode = 'local'; order = loadOrder(); connectivity = ''; return;
    }
    // An explicit shared link or previously verified service must never open as a local paid order.
    const health = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
    if (health.status === 404 || (health.ok && health.headers.get('content-type')?.includes('text/html'))) {
      if (explicit || recent || mode === 'shared') throw new Error('此地址暂时无法读取共享团单。');
      mode = 'local'; order = loadOrder(); connectivity = ''; return;
    }
    if (!health.ok || !(await health.json()).ok) throw new Error('团单服务暂时不可用。');
    mode = 'shared';
    remoteId = explicit || recent || '';
    await operation(remoteId ? '/' + encodeURIComponent(remoteId) : '', remoteId ? 'GET' : 'POST');
    remember(remoteId);
  }
  async function retry() {
    try {
      if (mode === 'shared' && remoteId) {
        await operation('/' + encodeURIComponent(remoteId), 'GET'); remember(remoteId);
      } else await connect();
      showView(isMember() ? 'order' : 'group', false);
    } catch (error) { displayError(error); }
  }
  function displayError(error) {
    connectivity = error instanceof TypeError || error.name === 'TimeoutError' ?
      '暂时连接不到团单服务。本次操作结果待核实，请重新连接。' : error.message;
    render(); openSheet('error');
  }
  async function poll() {
    if (mode !== 'shared' || !remote || !remoteId || busy || syncing || document.hidden || Date.now() - lastPoll < 1500) return;
    const token = requestNumber;
    syncing = true; lastPoll = Date.now();
    try {
      const next = await request('/' + encodeURIComponent(remoteId));
      if (token === requestNumber) {
        const wasMine = isMember();
        applyRemote(next);
        if (wasMine !== isMember()) showView(isMember() ? 'order' : 'group', false);
        else render();
      }
    } catch {
      if (token === requestNumber) { connectivity = '连接已中断，正在重新读取团单。'; render(); }
    } finally { syncing = false; }
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(location.href);
      document.getElementById('detail-body').append(note('团单链接已复制。'));
    } catch {
      const input = element('input'); input.type = 'text'; input.readOnly = true; input.value = location.href;
      input.setAttribute('aria-label', '可复制的团单链接');
      document.getElementById('detail-body').append(input); input.select();
    }
  }
  async function handle(action) {
    if (busy) return;
    if (mode === 'local' && storageAvailable) order = loadOrder();
    if (action === 'retry' || (action === 'primary' && connectivity)) {
      busy = true; try { await retry(); } finally { busy = false; render(); } return;
    }
    if (mode === 'starting' && action !== 'close') return;
    switch (action) {
      case 'primary': if (isMember()) showView('order'); else openSheet(status().closed ? 'records' : 'join'); break;
      case 'confirm-join':
        if (sheet !== 'join') return;
        if (mode === 'shared') { await submit('join'); break; }
        if (!order) saveOrder(makeOrder(Date.now()));
        showView('order'); break;
      case 'back-group': showView('group'); break;
      case 'sheet-group': openSheet('group'); break;
      case 'sheet-records': openSheet('records'); break;
      case 'member': {
        const s = status();
        if (!isMember() || !s.delivered || s.received) return;
        if (mode === 'shared') { await submit('receive'); break; }
        saveOrder({ ...order, receivedAt: Date.now() });
        showView('order'); break;
      }
      case 'download': download(); break;
      case 'share': if (mode === 'shared') openSheet('share'); break;
      case 'copy': if (mode === 'shared') await copyLink(); break;
      case 'restart':
        if (!status().done) return;
        restartOrderId = mode === 'shared' ? remoteId : order.paidAt;
        openSheet('restart'); break;
      case 'confirm-restart':
        if (sheet !== 'restart' || !status().done || restartOrderId !== (mode === 'shared' ? remoteId : order.paidAt)) return;
        if (mode === 'shared') { await submit('create'); break; }
        saveOrder(null); showView('group'); break;
      case 'close': closeSheet(); break;
    }
  }
  async function submit(action) {
    busy = true;
    document.querySelectorAll('#detail-body [data-action]').forEach(button => { button.disabled = true; });
    render();
    try {
      const path = action === 'create' ? '' : '/' + encodeURIComponent(remoteId) + '/' + action;
      await operation(path, 'POST');
      remember(remoteId);
      if (action !== 'create' && !isMember()) throw new Error('服务未确认你的订单，请重新读取团单。');
      showView(isMember() ? 'order' : 'group');
    } catch (error) { displayError(error); }
    finally { busy = false; render(); }
  }
  async function init() {
    render();
    document.addEventListener('click', event => {
      const target = event.target.closest('[data-action]');
      if (target && !target.disabled) handle(target.dataset.action);
    });
    document.getElementById('detail').addEventListener('close', () => {
      if (!document.getElementById('detail').open) sheet = '';
    });
    window.addEventListener('storage', event => {
      if (mode !== 'local' || (event.key !== storageKey && event.key !== null)) return;
      const previous = order;
      order = loadOrder();
      if (!order || (order && !previous)) showView(order ? 'order' : 'group', false);
      else render();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); void poll(); } });
    try { await connect(); showView(isMember() ? 'order' : 'group', false); }
    catch (error) { displayError(error); }
    setInterval(() => { render(); void poll(); }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
