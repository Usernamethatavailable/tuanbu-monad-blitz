(() => {
  'use strict';

  const workshop = '山涧印制工坊';
  const item = '栗栗熊 · 亚克力挂件拼印';
  const recentKey = 'tuanbu:v3:last-team';
  const tabs = ['member', 'leader', 'factory'];
  const roles = { member: '拼友', leader: '团长', factory: '工厂' };
  const phases = { open: '认购中', closed: '已截止', accepted: '工厂已接单', shipped: '工厂已发货', distributed: '已整批分发', failed: '未成团' };
  const statuses = { paid: '已预付', received: '已签收', disputed: '异议处理中', refunded: '已退款', reshipping: '已安排补发' };
  const reasonDefaults = ['未收到', '缺件', '破损', '与约定不符'];
  const currency = amount => '¥' + amount;
  const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const date = stamp => clock.format(new Date(stamp));
  let team = null;
  let teamId = '';
  let role = 'member';
  let modal = '';
  let selectedOrder = '';
  let selectedRound = 0;
  let busy = false;
  let polling = false;
  let sequence = 0;
  let errorText = '';
  const byId = id => document.getElementById(id);
  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }
  function button(action, label, className = 'quiet-link', orderId) {
    const node = element('button', className, label);
    node.type = 'button'; node.dataset.action = action;
    if (orderId) node.dataset.order = orderId;
    return node;
  }
  const mainButton = (id, label, orderId) => button(id, label, 'btn-main role-action', orderId);
  const nextTab = (id, label) => button('tab-' + id, label, 'quiet-link role-next');
  const note = text => element('p', 'sheet-note', text);
  function facts(entries, className = 'role-facts') {
    const dl = element('dl', className);
    for (const [label, value] of entries) {
      const line = element('div'); line.append(element('dt', '', label), element('dd', '', value)); dl.append(line);
    }
    return dl;
  }
  function sheetRow(label, value) {
    const line = element('div', 'sheet-row'); line.append(element('span', '', label), element('strong', '', value)); return line;
  }
  function controls(...nodes) {
    const wrap = element('div', 'role-toolbar sheet-actions'); wrap.append(...nodes); return wrap;
  }
  const title = text => element('h2', 'role-panel-title', text);
  const info = text => element('p', 'role-panel-note', text);
  const totalPrepay = () => team.prepay + team.fee;
  const acceptedCount = () => team.acceptedCount ?? team.acceptedOrderIds?.length ?? 0;

  function memberPanel() {
    const o = team.mine;
    if (!o) {
      if (team.phase !== 'open') return [title(team.phase === 'failed' ? '本团未成团' : '这团已截止'), info('你没有认购本团，可查看整团记录和资金去向。'), button('money', '查看收款明细')];
      return [title('这 ' + totalPrepay() + ' 元付给谁'), info('已有 ' + team.count + ' 份。截止满 5 份，货款从 88 元降到 66 元，每份退 22 元。'),
        facts([['工厂货款预付', currency(team.prepay)], ['团长分货费', currency(team.fee)], ['满 5 份，每份最终合计', currency(66 + team.fee)]]),
        mainButton('join', '付 ' + totalPrepay() + ' 元拼一份')];
    }
    const amounts = [['我已预付', currency(o.prepaid)], ['商品款 / 团长服务费', team.phase === 'failed' ? '未成交' : currency(o.goods) + ' / ' + currency(o.fee)],
      ...(team.phase !== 'open' ? [['已原路退回', currency(o.refundTotal ?? (o.discountRefund + o.disputeRefund + (o.failureRefund || 0)))], ['订单待结算', currency(o.held)]] : [])];
    const receipt = facts(amounts);
    if (team.phase === 'failed') return [title('未成团，已退全款'), info('有效份数不足 3 份，商品款和服务费一并原路退回。'), receipt, button('money', '查看退款记录')];
    if (o.status === 'received') return [title('我的一份已签收'), info('本单已按截止价结算，工厂实收 ' + currency(o.factoryPaid) + '，团长实收 ' + currency(o.leaderPaid) + '。'), receipt, button('money', '查看本团收款明细')];
    if (o.status === 'refunded') return [title('我的一份已退款'), info('这笔订单已退回剩余商品款及服务费，其他拼友的订单各自结算。'), receipt];
    if (o.status === 'disputed') return [title('我的订单有异议'), info((o.reason ? o.reason + '。' : '') + '本单余款暂停结算，等待工厂处理。'), receipt, nextTab('factory', team.canManage ? '切到工厂处理异议 →' : '查看工厂处理进度 →')];
    if (team.phase === 'closed' && acceptedCount() > 0) return [
      title(o.accepted ? '我的一份已接单' : '我的一份待工厂接单'),
      info('截止实付 ' + team.count + ' 份，工厂已接 ' + acceptedCount() + ' 份。齐单后再整批发货。'), receipt, nextTab('factory', '查看工厂接单清单 →')
    ];
    if (team.phase === 'distributed') return [title(o.status === 'reshipping' ? '工厂已安排补发' : '团长已分发，等你签收'),
      info('收到自己的挂件、核对无误后确认。工厂和团长只结算这一份。'), receipt,
      mainButton('receive', '确认收到我的一份'), button('dispute', o.status === 'reshipping' ? '补发仍有问题' : '我的一份有问题')];
    const steps = {
      open: ['已拼一份，等待截止', '当前有 ' + team.count + ' 份实付。团长截止后按有效份数计价。', 'leader', '查看团长截止'],
      closed: ['已锁定每份 ' + currency(team.unit), '本单已退差价 ' + currency(o.discountRefund) + '，余款待签收。', 'factory', '查看工厂接单'],
      accepted: ['工厂已确认接单', '这批挂件正在制作，确认发货后可在下方看到记录。', 'factory', '查看工厂发货'],
      shipped: ['工厂已整批发出', '货正在寄往团长。团长签收分发后，再核对你自己的一份。', 'leader', '查看团长分发']
    };
    const [heading, summary, next, label] = steps[team.phase];
    return [title(heading), info(summary), receipt, nextTab(next, (team.canManage ? '切到' + roles[next] + '继续' : label) + ' →')];
  }
  function leaderPanel() {
    const common = facts([['有效实付', team.count + ' 份'], ['已结算服务费', currency(team.totals.leaderPaid)]]);
    if (team.phase === 'open') return [title('核对实付份数'), info('你可以继续邀请拼友，也可以截止拼团。截止后停止认购，并按份数处理差价。'), common,
      team.canManage ? mainButton('close-group', '截止并按实付份数结算') : note('只有本团管理者可以截止。'), button('share', '分享团单')];
    if (team.phase === 'shipped') return [title('工厂已发出 ' + team.count + ' 份'), info('收到并清点整批挂件后分发，拼友随后各自签收。'), common,
      team.canManage ? mainButton('distribute', '确认整批签收并分发') : note('等待团长确认整批签收。')];
    if (team.phase === 'failed') return [title('未达起订量，已流团'), info('所有已付订单退回商品款和服务费。'), common, button('money', '查看退款去向')];
    if (team.phase === 'distributed') return [title('这批挂件已分发'), info('团长的整批签收已记录。真实参与的拼友各自确认后才结算。'), common, nextTab('member', team.mine ? '回到我的一份 →' : '查看拼友进度 →')];
    return [title(team.phase === 'closed' ? '拼团已截止' : '工厂已接单'), info('共 ' + team.count + ' 份，商品单价 ' + currency(team.unit) + '，每份服务费 ' + currency(team.fee) + '。'), common,
      nextTab('factory', (team.canManage ? '切到工厂继续' : '查看工厂进度') + ' →')];
  }
  function factoryPanel() {
    const common = facts([['工厂', workshop], ['团单数量', team.count + ' 份'], ['工厂已结算', currency(team.totals.factoryPaid)]]);
    if (team.phase === 'open') return [title('等待团长截止'), info('已登记 ' + team.count + ' 份。截止后，工厂按一张生产单确认规格与数量。'), common, nextTab('leader', '去看团长进度 →')];
    if (team.phase === 'failed') return [title('本团不安排生产'), info('未达起订量，商品款及服务费已退回。'), common, button('money', '查看收款去向')];
    if (team.phase === 'closed') return [title(acceptedCount() ? '还有 ' + (team.count - acceptedCount()) + ' 份待接' : '核对整批生产单'),
      info('截止实付 ' + team.count + ' 份，工厂已接 ' + acceptedCount() + ' 份。每份为同款 10 枚；确认齐单后才能发货。'), common,
      team.canManage ? mainButton('accept', acceptedCount() ? '补确认接单' : '核对接单清单') : note('等待工厂确认接单。')];
    if (team.phase === 'accepted') return [title('工厂正在制作'), info('按生产单核对数量。整批发出后登记发货，等待团长清点。'), common,
      team.canManage ? mainButton('ship', '确认整批发出') : note('等待工厂发货。')];
    if (team.phase === 'shipped') return [title('这批挂件已发货'), info('接下来由团长签收整批并分发，货款随每位拼友签收分别结算。'), common, nextTab('leader', '去看团长分发 →')];
    const disputes = team.orders.filter(o => o.status === 'disputed');
    if (disputes.length) {
      const list = element('ul', 'order-list');
      disputes.forEach(o => {
        const li = element('li');
        li.append(element('strong', '', '订单 ' + o.id), element('p', '', (o.reason || '有异议') + ' · 暂停结算 ' + currency(o.held)));
        if (team.canManage) li.append(controls(button('factory-refund', '退还本单余款', 'btn-secondary', o.id), button('factory-reship', '为此单补发', 'btn-secondary', o.id)));
        list.append(li);
      });
      return [title(disputes.length + ' 笔订单待处理'), info('只处理提出异议的订单，其他拼友照常签收。'), common, list];
    }
    return [title('已整批交给团长'), info('各笔订单按签收状态独立结算。'), common, nextTab('member', '查看拼友签收 →')];
  }
  function eventList(events) {
    const list = element('ol', 'record-list');
    for (const event of [...events].reverse()) {
      const li = element('li');
      li.append(element('strong', '', event.title), element('p', '', event.detail), element('small', '', date(event.at) + ' · ' + (roles[event.role] || event.role)));
      list.append(li);
    }
    return list;
  }
  function recentEvents() {
    const batch = [];
    for (const e of team.events) {
      const last = batch.at(-1);
      if (e.title.startsWith('预置') && last?.originalTitle === e.title && last.at === e.at) {
        last.quantity++;
        last.title = last.quantity + ' 笔' + e.title;
        last.detail = '每笔回执可在完整时间线中逐一核对。';
      } else batch.push({ ...e, originalTitle: e.title, quantity: 1 });
    }
    return batch.slice(-3);
  }
  function render() {
    const panel = byId('role-content');
    const timeline = byId('timeline');
    const activeTab = document.querySelector('[data-role="' + role + '"]');
    document.querySelectorAll('#roles-tabs [data-role]').forEach(node => {
      const active = node.dataset.role === role;
      node.setAttribute('aria-selected', String(active)); node.tabIndex = active ? 0 : -1;
      node.classList.toggle('active', active);
    });
    if (activeTab?.id) panel.setAttribute('aria-labelledby', activeTab.id);
    if (!team) { panel.replaceChildren(info(errorText || '正在打开团单…'), ...(errorText ? [mainButton('retry', '重新读取团单')] : [])); timeline.replaceChildren(); return; }
    const values = { groupId: team.id, groupPhase: phases[team.phase], count: team.count, unit: team.unit, fee: team.fee, prepay: team.prepay };
    document.querySelectorAll('[data-field]').forEach(el => {
      if (Object.hasOwn(values, el.dataset.field)) el.textContent = values[el.dataset.field];
    });
    const content = role === 'member' ? memberPanel() : role === 'leader' ? leaderPanel() : factoryPanel();
    panel.replaceChildren(...(errorText ? [note(errorText), button('retry', '重新读取团单')] : []), ...content);
    const recent = recentEvents();
    timeline.replaceChildren(eventList(recent));
    if (team.events.length > recent.length) timeline.append(button('records', '查看全部 ' + team.events.length + ' 条记录'));
    if (busy || errorText) panel.querySelectorAll('.role-action, [data-action="factory-refund"], [data-action="factory-reship"]').forEach(b => b.disabled = true);
  }
  function setRole(next, focus = false) {
    if (!tabs.includes(next)) return;
    role = next; render();
    if (focus) document.querySelector('#roles-tabs [data-role="' + next + '"]').focus();
  }

  function terms() {
    return [['品名', item], ['款式与规格', '1 份 = 10 枚已定稿的同款挂件。'], ['制作与收款工厂', workshop], ['示例报价', '3–4 份 ¥88 / 份，5 份起 ¥66 / 份。'],
      ['费用', '每人预付货款 ¥88、团长服务费 ¥3，共 ¥91。'], ['截止与退款', '团长截止后按有效实付份数锁价。达到 5 份，每人原路退 ¥22；不足 3 份，货款与服务费原路全退。'],
      ['接单范围', '仅接受国内、开团前已确认可按约定账期结算的供方。'],
      ['生产与交付', '计划最多 32 天：3 天集单、15 天生产、7 天寄送分货、7 天日常核对。有争议的订单单独跟进。'],
      ['逐单结算', '拼友无异议签收后，商品款结给工厂，¥3 服务费结给团长。有异议只暂停本单；可退款或补发。'],
      ['记录来源', '本地共享服务记录各角色的模拟操作，支付与资金回执均为模拟。读团单无需连接钱包。']];
  }
  function orderLabel(o) {
    return [o.mine ? '我的订单' : '订单', o.id, o.seed ? '（预置）' : ''].join(' ');
  }
  function financials() {
    const t = team.totals;
    const nodes = [sheetRow('工厂已结算', currency(t.factoryPaid)), sheetRow('团长已结算', currency(t.leaderPaid)),
      sheetRow('订单待结算', currency(t.held)), sheetRow('已原路退回（含差价）', currency(t.refunded))];
    for (const o of team.orders) {
      nodes.push(sheetRow(orderLabel(o), statuses[o.status] || o.status),
        note('预付 ' + currency(o.prepaid) + ' · 工厂实收 ' + currency(o.factoryPaid) + ' · 团长实收 ' + currency(o.leaderPaid) +
          ' · 待结算 ' + currency(o.held) + ' · 已退 ' + currency(o.refundTotal ?? (o.discountRefund + o.disputeRefund + (o.failureRefund || 0)))));
    }
    return nodes;
  }
  function shareUrl() {
    const url = new URL(location.href);
    url.search = ''; url.searchParams.set('team', team.id); url.hash = '';
    return url.href;
  }
  function modalParts(id) {
    if (id === 'failure') return ['操作结果待核实', [note(errorText), controls(mainButton('retry', '重新读取团单'), button('dismiss', '关闭'))]];
    if (id === 'join') return ['确认拼一份', [sheetRow('商品', item + ' × 1'), sheetRow('商品预付款 · ' + workshop, currency(team.prepay)),
      sheetRow('团长服务费', currency(team.fee)), sheetRow('本次模拟支付', currency(totalPrepay())), note('5 份起每份退 ¥22 差价。团长的服务费在本人无异议签收后结算。'),
      controls(mainButton('confirm-join', '确认模拟支付 ' + currency(totalPrepay())), button('dismiss', '取消'))]];
    if (id === 'terms') return ['拼团约定', [sheetRow('团号 / 报价版本', team.id + ' / V1'), ...terms().map(pair => sheetRow(...pair)),
      controls(button('share', '分享本团'), button('download', '下载本团副本'), button('new', '另开体验团'))]];
    if (id === 'money') return ['收款去向', financials()];
    if (id === 'records') return ['本团记录', [sheetRow('团号', team.id), eventList(team.events)]];
    if (id === 'share') return ['分享本团', [note('同一链接进入同一团单。本机地址可以在这台电脑的另一个浏览器或无痕窗口打开。'),
      sheetRow('团单链接', shareUrl()), controls(mainButton('copy', '复制团单链接'))]];
    if (id === 'close-group') {
      const msg = team.count < 3 ? '本团未达到 3 份，每位拼友的 ¥91 将全额原路退回。' :
        '本团将按 ' + team.count + ' 份锁定货款 ' + currency(team.unit) + ' / 份，每份退回差价 ' + currency(team.prepay - team.unit) + '。';
      return ['截止本团？', [note(msg), note('截止后不再接受新认购。'), controls(mainButton('confirm-close', '确认截止'), button('dismiss', '继续收单'))]];
    }
    if (id === 'accept') {
      const selected = new Set(team.acceptedOrderIds || []);
      const list = element('div', 'order-list acceptance-list');
      team.orders.forEach(o => {
        const label = element('label', 'acceptance-choice');
        const box = element('input'); box.type = 'checkbox'; box.name = 'accept-order'; box.value = o.id;
        box.checked = true; box.disabled = selected.has(o.id) || o.accepted;
        label.append(box, element('span', '', orderLabel(o) + (box.disabled ? ' · 已接单' : ' · 1 份')));
        list.append(label);
      });
      return ['核对工厂接单清单', [sheetRow('截止实付', team.count + ' 份'), sheetRow('工厂已确认', acceptedCount() + ' 份'),
        note('默认勾选全部。取消暂未接下的订单，之后可补确认。已确认的订单保留原回执。'), list,
        controls(mainButton('confirm-accept', '确认勾选的订单'), button('dismiss', '取消'))]];
    }
    if (id === 'dispute') {
      const select = element('select', 'dispute-reason');
      select.id = 'dispute-reason';
      for (const reason of team.reasonOptions || reasonDefaults) { const item = element('option', '', reason); item.value = reason; select.append(item); }
      const label = element('label', 'sheet-note', '选择遇到的问题'); label.htmlFor = select.id;
      return ['我的订单有问题', [label, select, note('发起后暂停结算这一份的商品款和服务费，等待工厂处理。'), controls(mainButton('confirm-dispute', '提交异议'), button('dismiss', '取消'))]];
    }
    if (id === 'factory-refund' || id === 'factory-reship') {
      const o = team.orders.find(o => o.id === selectedOrder);
      if (!o || o.status !== 'disputed' || o.disputeRound !== selectedRound) return ['订单状态已更新', [note('该轮异议已经处理。'), button('dismiss', '关闭')]];
      const refund = id === 'factory-refund';
      return [refund ? '退还这笔订单？' : '登记这笔补发？', [sheetRow('订单', o.id), sheetRow('问题', o.reason || '订单异议'),
        note(refund ? '本单剩余 ' + currency(o.held) + '（含服务费）将退回拼友，工厂与团长均不入账。' : '该笔订单将保持待签收状态。拼友收到补发件后，自行确认结算。'),
        controls(mainButton(refund ? 'confirm-refund' : 'confirm-reship', refund ? '确认退还余款' : '确认已补发'), button('dismiss', '取消'))]];
    }
    if (id === 'new') {
      const label = element('label', 'sheet-note', '新团已有几份模拟认购？');
      const select = element('select'); select.id = 'seed-count'; label.htmlFor = select.id;
      for (const n of [4, 3, 1]) { const opt = element('option', '', n + ' 份'); opt.value = n; select.append(opt); }
      return ['另开体验团', [note('当前团单可通过原链接继续查看。新团有独立链接、认购和记录。'), label, select, controls(mainButton('confirm-new', '创建新团'), button('dismiss', '留在本团'))]];
    }
  }
  function fillModal() {
    const result = modalParts(modal);
    if (!result) return;
    byId('detail-title').textContent = result[0];
    byId('detail-body').replaceChildren(...result[1]);
  }
  function openModal(id) {
    modal = id; fillModal();
    const dialog = byId('detail');
    if (!dialog.open) dialog.showModal();
    const heading = byId('detail-title'); heading.tabIndex = -1; heading.focus({ preventScroll: true });
    byId('detail-body').scrollTop = 0;
  }
  function dismiss() { modal = ''; if (byId('detail').open) byId('detail').close(); }
  function exportTeam() {
    const publicOrders = team.orders.map(({ id, seed, accepted, status, prepaid, goods, fee, discountRefund, disputeRefund, failureRefund, refundTotal, held, factoryPaid, leaderPaid }) =>
      ({ id, seed, accepted, status, prepaid, goods, fee, discountRefund, disputeRefund, failureRefund, refundTotal, held, factoryPaid, leaderPaid }));
    const doc = {
      原型: '团簿 · 模拟数据', 团号: team.id, 报价版本: 'V1', 拼团约定: Object.fromEntries(terms()),
      阶段: phases[team.phase], phase: team.phase, 有效实付份数: team.count,
      当前商品单价: team.unit, 截止商品单价: team.phase === 'open' ? null : team.unit,
      工厂接单份数: acceptedCount(), acceptedOrderIds: team.acceptedOrderIds,
      订单: publicOrders, 收款去向: team.totals, 事件: team.events
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json;charset=utf-8' }));
    const link = element('a'); link.href = url; link.download = '团簿-' + team.id + '.json';
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
  async function api(path, body) {
    const options = { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(6500) };
    if (body !== undefined) { options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify(body); }
    const res = await fetch('/api/v3/groups' + path, options);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '团单服务暂不可用。');
    if (!data.id || !Array.isArray(data.orders) || !Array.isArray(data.events)) throw new Error('未收到有效的团单回执。');
    return data;
  }
  function adopt(data) {
    team = data; teamId = data.id; errorText = '';
    try { localStorage.setItem(recentKey, teamId); } catch { /* The link retains the group. */ }
    const url = new URL(location.href);
    if (url.searchParams.get('team') !== teamId) { url.searchParams.set('team', teamId); history.replaceState(null, '', url); }
  }
  async function request(action, body, confirmedModal) {
    if (busy || (confirmedModal && modal !== confirmedModal)) return;
    const previous = team;
    busy = true; sequence++; render();
    byId('detail-body').querySelectorAll('button').forEach(b => b.disabled = true);
    try {
      const path = action === 'new' ? '' : '/' + encodeURIComponent(teamId) + (action === 'read' ? '' : '/' + action);
      const data = await api(path, action === 'read' ? undefined : (body || {}));
      adopt(data);
      if (action === 'new') role = 'member';
      dismiss();
    } catch (error) {
      team = previous;
      errorText = error.name === 'TypeError' || error.name === 'TimeoutError' ? '暂时无法连接。请重新读取团单，核对本次操作结果。' : error.message;
      openModal('failure');
    } finally { busy = false; render(); }
  }
  async function refresh() {
    if (!teamId || busy || polling || document.hidden) return;
    polling = true;
    const token = sequence;
    try {
      const data = await api('/' + encodeURIComponent(teamId));
      if (sequence !== token) return;
      const changed = JSON.stringify(team) !== JSON.stringify(data) || errorText;
      if (changed) {
        adopt(data); render();
        if (['money', 'records', 'close-group', 'factory-refund', 'factory-reship'].includes(modal)) fillModal();
      }
    } catch {
      if (sequence === token && !errorText) { errorText = '与本团失去连接，正在重新读取。'; render(); }
    } finally { polling = false; }
  }
  function copy() {
    const text = shareUrl();
    const fallback = () => { const input = element('input'); input.value = text; input.readOnly = true; input.setAttribute('aria-label', '团单链接'); byId('detail-body').append(input); input.select(); };
    if (!navigator.clipboard) { fallback(); return; }
    navigator.clipboard.writeText(text).then(() => byId('detail-body').append(note('链接已复制。')), fallback);
  }
  function handle(node) {
    if (busy) return;
    const action = node.dataset.action;
    if (action === 'dismiss' || action === 'close') { dismiss(); return; }
    if (action === 'retry') { void request(teamId ? 'read' : 'new'); return; }
    if (!team) return;
    if (action.startsWith('tab-')) { setRole(action.slice(4), true); return; }
    if (['terms', 'money', 'records', 'share', 'new'].includes(action)) { openModal(action); return; }
    if (action === 'download') { exportTeam(); return; }
    if (action === 'copy') { copy(); return; }
    if (errorText) { openModal('failure'); return; }
    if (action === 'join' && !team.mine && team.phase === 'open') openModal('join');
    if (action === 'confirm-join' && !team.mine && team.phase === 'open') void request('join', {}, 'join');
    if (action === 'confirm-new' && modal === 'new') void request('new', { seedCount: Number(byId('seed-count').value) }, 'new');
    const activeOrder = team.mine && ['paid', 'reshipping'].includes(team.mine.status) && team.phase === 'distributed';
    if (activeOrder && action === 'receive') void request('receive');
    if (activeOrder && action === 'dispute') { selectedRound = (team.mine.disputeRound || 0) + 1; openModal('dispute'); }
    if (activeOrder && action === 'confirm-dispute' && modal === 'dispute') {
      void request('dispute', { reason: byId('dispute-reason').value, round: selectedRound }, 'dispute');
    }
    if (!team.canManage) return;
    if (action === 'close-group' && team.phase === 'open') openModal(action);
    if (action === 'confirm-close' && team.phase === 'open') void request('close', {}, 'close-group');
    if (action === 'accept' && team.phase === 'closed') openModal('accept');
    if (action === 'confirm-accept' && team.phase === 'closed' && modal === 'accept') {
      const ids = [...byId('detail-body').querySelectorAll('input[name="accept-order"]:checked')].map(box => box.value);
      if (ids.length > acceptedCount()) void request('accept', { orderIds: ids }, 'accept');
      else byId('detail-body').append(note('请至少选择一份尚未接单的订单。'));
    }
    const allowed = { ship: 'accepted', distribute: 'shipped' };
    if (allowed[action] === team.phase) void request(action);
    if (['factory-refund', 'factory-reship'].includes(action) && team.orders.some(o => o.id === node.dataset.order && o.status === 'disputed')) {
      selectedOrder = node.dataset.order; selectedRound = team.orders.find(o => o.id === selectedOrder).disputeRound; openModal(action);
    }
    if (['confirm-refund', 'confirm-reship'].includes(action)) {
      const target = team.orders.find(o => o.id === selectedOrder && o.status === 'disputed');
      if (!target || target.disputeRound !== selectedRound) return;
      const kind = action.slice(8); void request(kind, { orderId: selectedOrder, round: selectedRound }, 'factory-' + kind);
    }
  }
  function init() {
    const url = new URL(location.href);
    let recent = '';
    try { recent = localStorage.getItem(recentKey); } catch { /* The explicit link takes precedence. */ }
    teamId = url.searchParams.get('team') || recent || '';
    document.addEventListener('click', event => {
      const tab = event.target.closest('#roles-tabs [data-role]');
      if (tab) { setRole(tab.dataset.role); return; }
      const node = event.target.closest('[data-action]'); if (node && !node.disabled) handle(node);
    });
    byId('roles-tabs').addEventListener('keydown', event => {
      const tab = event.target.closest('[data-role]');
      if (!tab) return;
      const index = tabs.indexOf(tab.dataset.role);
      const next = { ArrowRight: (index + 1) % 3, ArrowLeft: (index + 2) % 3, Home: 0, End: 2 }[event.key];
      if (next !== undefined) { event.preventDefault(); setRole(tabs[next], true); }
    });
    byId('detail').addEventListener('close', () => { if (!byId('detail').open) modal = ''; });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
    render(); void request(teamId ? 'read' : 'new'); setInterval(refresh, 1700);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
