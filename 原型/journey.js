(() => {
  'use strict';

  const apiBase = '/api/v4/groups';
  const lastKey = 'tuanbu:journey:v4:last';
  const names = { leader: '团长', buyer: '拼友', factory: '工厂' };
  const tabIds = Object.keys(names);
  const phases = {
    draft: '草稿', proposed: '等待工厂报价', quoted: '工厂已报价', open: '接受报名', submitted: '工厂核对生产单',
    accepted: '已接单，等待付款截止', pay_closed: '已锁价', failed: '未成团', started: '生产中', shipped: '整批已发货', batch_received: '团长已收货', distributed: '已分发'
  };
  const factory = '山涧布偶工坊';
  const product = '栗栗熊 · 20 cm 棉花娃娃';
  const filming = '开箱前开始连续录像，拍清包装面单、拆封过程、数量、娃娃正反面及瑕疵。';
  const fmt = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const byId = id => document.getElementById(id);
  const money = n => '¥' + n;
  const fallbackReasons = ['生产质量问题', '与确认样不符', '分装漏发', '分装错发'];
  let team = null, id = '', role = 'leader', sheet = '', error = '';
  let busy = false, polling = false, generation = 0;
  let claimId = '', claimRound = 0, manualNumber = 0;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function btn(action, text, cls = 'quiet-link', orderId) {
    const b = el('button', cls, text); b.type = 'button'; b.dataset.action = action;
    if (orderId) b.dataset.order = orderId;
    return b;
  }
  const primary = (action, text) => btn(action, text, 'btn-main role-action');
  const note = text => el('p', 'sheet-note', text);
  const heading = text => el('h2', 'role-panel-title', text);
  const hint = text => el('p', 'role-panel-note', text);
  function facts(pairs) {
    const dl = el('dl', 'role-facts');
    for (const [k, v] of pairs) { const line = el('div'); line.append(el('dt', '', k), el('dd', '', v)); dl.append(line); }
    return dl;
  }
  function row(k, v) {
    const n = el('div', 'sheet-row'); n.append(el('span', '', k), el('strong', '', v)); return n;
  }
  function actions(...children) {
    const group = el('div', 'role-toolbar sheet-actions'); group.append(...children); return group;
  }
  function selectInput(key, caption, choices, defaultValue) {
    const wrap = el('div', 'sheet-form-field'), label = el('label', 'sheet-note', caption), select = el('select');
    select.id = key; label.htmlFor = key;
    for (const [value, text] of choices) { const opt = el('option', '', text); opt.value = value; select.append(opt); }
    if (defaultValue !== undefined) select.value = defaultValue;
    wrap.append(label, select); return wrap;
  }
  const amount = () => team.prepay + team.fee;
  const billed = () => !['draft', 'proposed', 'quoted', 'open', 'submitted', 'accepted'].includes(team.phase);
  const paymentOpen = () => ['submitted', 'accepted'].includes(team.phase);
  const stageCounts = () => facts([['已报名', team.signupCount + ' 个'], ['工厂已接', team.acceptedCount + ' 个'], ['已付款', team.paidCount + ' 个']]);
  function managerAction(action, text) {
    return team.canManage ? primary(action, text) : note('等待' + names[role] + '确认。当前浏览器可查看进度。');
  }
  function afterSales(owner) {
    if (!team.canManage) return null;
    const pending = team.orders.filter(o => o.status === 'disputed' && o.responsibleRole === owner);
    const manual = team.orders.filter(o => o.manualClaim && o.manualClaim.responsibleRole === owner && o.manualClaim.status !== 'closed');
    if (!pending.length && !manual.length) return null;
    const list = el('ul', 'order-list');
    for (const o of pending) {
      const li = el('li');
      li.append(el('strong', '', '订单 ' + o.id), el('p', '', (o.reason || '等待处理') + ' · 本单冻结 ' + money(o.held)));
      if (team.canManage) li.append(actions(btn('refund', '退还本单余款', 'btn-secondary', o.id), btn('reship', '登记补发', 'btn-secondary', o.id)));
      list.append(li);
    }
    for (const o of manual) {
      const li=el('li'), c=o.manualClaim;
      li.append(el('strong','','订单 '+o.id+' · 已结算后售后'),el('p','',c.reason+'。'+(c.note||'')));
      if(c.reply)li.append(el('p','','已答复：'+c.reply));
      li.append(actions(...(c.status==='open'?[btn('reply-claim','答复拼友','btn-secondary',o.id)]:[]),btn('close-claim','关闭工单','btn-secondary',o.id)));list.append(li);
    }
    return [heading((pending.length+manual.length) + ' 笔售后待处理'), hint(pending.length?'签收前的异议仅暂停该笔结算。':'已签收订单由责任方人工跟进。'), list];
  }
  function leaderPanel() {
    const p = team.phase;
    if (p === 'draft') return [heading('向工厂发起定制需求'), hint('样品和款式已定稿。先告诉工厂预计要做多少个娃娃。'), managerAction('propose', '填写定制需求')];
    if (p === 'proposed') return [heading('需求已发给工厂'), hint('等待工厂确认起订量、阶梯价与交期。报价确认后就能开团。')];
    if (p === 'quoted') return [heading('工厂报价已收到'), facts([['50–99 个', '¥88 / 个'], ['100 个起', '¥66 / 个'], ['团长服务费', '¥3 / 个']]), managerAction('publish', '发布团单，开始报名'), btn('quote-doc', '查看工厂原报价')];
    if (p === 'open') return [heading('收集拼友报名'), hint('每人报名 1 个，现在不收钱。'+(team.orders.some(o=>o.seed)?'已有 '+team.orders.filter(o=>o.seed).length+' 个由模拟拼友报名。':'')+'报名结束后向工厂提交生产清单。'),
      facts([['已报名', team.signupCount + ' 个'], ['已付款', team.paidCount + ' 个']]),
      ...(team.signupCount ? [managerAction('submit-production', '提交 ' + team.signupCount + ' 个的生产单')] : []), btn('share', '分享报名链接')];
    if (paymentOpen()) return [heading('核对接单和实付数量'), hint('只有工厂已接下的报名可以付款。以截止时实际付款的数量定价。'), stageCounts(),
      ...(team.acceptedCount ? [managerAction('close-pay', '核对并截止付款')] : []), btn('production-doc', '查看工厂接单清单')];
    if (p === 'failed') return [heading('未达到 50 个，已流团'), hint('已付款的拼友各退 ¥91，未付款的报名不产生退款。'), stageCounts(), btn('money', '核对退款去向')];
    if (p === 'shipped') return [heading('工厂已整批发出'), hint('收到后先清点整批数量，分发时再逐一交给拼友。'), facts([['应收数量', team.paidCount + ' 个']]), managerAction('receive-batch', '确认收到整批')];
    if (p === 'batch_received') return [...(afterSales('团长') || []),heading('已签收整批，等待分发'), hint('已分发 '+(team.distributedCount||0)+' / '+team.paidCount+' 个。核对订单后将娃娃交给拼友。'), managerAction('distribute', '核对分发清单')];
    if (p === 'distributed') return afterSales('团长') || [heading('已完成整批分发'), facts([['团长服务费已结算', money(team.totals.leaderPaid)]]), hint('拼友各自签收。如有分装漏发或错发，售后会出现在这里。'), btn('delivery-doc', '查看交付记录')];
    return [heading(p === 'pay_closed' ? '已按实付数量锁价' : '工厂正在生产'), hint('生产与整批发货由工厂确认。'), facts([['实付数量', team.paidCount + ' 个'], ['锁定货款', money(team.unit) + ' / 个']]), btn('production-doc', '查看生产单')];
  }
  function factoryPanel() {
    const p = team.phase;
    if (p === 'draft') return [heading('还未收到定制需求'), hint('团长提交已定稿棉花娃娃的需求后，工厂可以确认报价。')];
    if (p === 'proposed') return [heading('核对需求并报价'), hint('向团长确认阶梯价与生产交期。'),
      facts([['团长预计数量', (team.targetCount ?? 100) + ' 个'], ['50–99 个 / 100 个起', '¥88 / ¥66'], ['生产交期', '付款截止后 15 天内发货']]), managerAction('quote', '确认并发送报价')];
    if (p === 'quoted' || p === 'open') return [heading(p === 'quoted' ? '报价已发给团长' : '等待整批生产清单'), hint(p === 'quoted' ? '团长接受报价并开团后，拼友才能报名。' : '团长收齐报名后会提交生产单。'), btn('quote-doc', '查看本厂报价')];
    if (p === 'submitted') return [heading(team.acceptedCount ? '补核对生产清单' : '核对团长的生产清单'), stageCounts(),
      hint('可确认全部或部分订单。已接单的拼友可向工厂付款，未接的拼友继续等待。'), managerAction('accept', team.acceptedCount ? '补确认订单' : '核对并接单')];
    if (p === 'accepted') return [heading('工厂已接全这批报名'), stageCounts(), hint('付款进入工厂微信二级商户冻结余额。等团长截止计价后开工。'), btn('production-doc', '查看接单清单')];
    if (p === 'pay_closed') return [heading('按实付清单开工'), facts([['实付生产量', team.paidCount + ' 个'], ['商品单价', money(team.unit)]]), managerAction('start', '确认开始生产')];
    if (p === 'started') return [heading('生产中，准备整批发货'), hint('完成制作并核对清单后，将 ' + team.paidCount + ' 个娃娃整批寄给团长。'),...(team.shipDueAt?[facts([['约定最晚发货',fmt.format(new Date(team.shipDueAt*1000))+'（北京时间）']])]:[]), managerAction('ship', '确认整批已发出')];
    if (p === 'failed') return [heading('本团未成团，不安排生产'), hint('工厂冻结余额按已付订单原路退款。'), btn('money', '核对退款去向')];
    if (p === 'distributed' || (p === 'batch_received' && team.distributedCount)) return afterSales('工厂') || [heading('已交付，等待逐单结算'), facts([['工厂货款已结算', money(team.totals.factoryPaid)]]), hint('质量或与确认样不符的问题由工厂处理。'), btn('delivery-doc', '查看交付记录')];
    return [heading(p === 'shipped' ? '整批已发给团长' : '团长已签收整批'), hint('团长负责分发，拼友签收自己的娃娃后才逐单结算。'), btn('delivery-doc', '查看交付记录')];
  }
  function buyerPanel() {
    const p = team.phase, o = team.mine;
    if (!o) {
      if (p === 'open') return [heading('报名 1 个栗栗熊'), hint('报名时不收钱。工厂接下你的订单后，再向工厂付款。'), facts([['商品预付款', '¥88'], ['团长服务费', '¥3'], ['100 个起的商品单价', '¥66']]), primary('respond', '报名 1 个'), btn('quote-doc', '核对工厂报价')];
      const early = ['draft', 'proposed', 'quoted'].includes(p);
      return [heading(early ? '团单尚未开放报名' : '本团报名已结束'), hint(early ? '团长确认工厂报价并发布后，再来报名。' : '你没有本团订单，可以查看公开报价和交付记录。')];
    }
    if (!o.paid) {
      if (o.accepted && paymentOpen()) return [heading('工厂已接下你的 1 个'), hint('付款成功后才计入实付数量。截止满 100 个，商品款每个退 ¥22。'),
        facts([['预付工厂货款', money(team.prepay)], ['团长服务费', money(team.fee)], ['本次合计', money(amount())]]), primary('pay', '模拟付款 ' + money(amount())), btn('production-doc', '核对我的接单记录')];
      if (billed()) return [heading('你没有在截止前付款'), hint('本次报名没有扣款，也不计入生产数量。')];
      return [heading('已报名，尚未付款'), hint(p === 'submitted' ? '工厂暂未接下你的这 1 个。收到接单确认后才可以付款。' : '团长收齐报名后会提交生产单，工厂接单后再付款。'),
        facts([['我的报名', o.id], ['已付金额', '¥0']]), btn('production-doc', '核对生产清单')];
    }
    const receipt = facts([['我已付给工厂商户', money(o.prepaid)], ['已退回', money(o.refundTotal)], ['我的待结算款', money(o.held)]]);
    if (p === 'failed') return [heading('未成团，已退回 ¥91'), hint('含商品预付款 ¥88 和团长服务费 ¥3，均已原路退回。'), receipt];
    if (o.status === 'received') {
      const claim=o.manualClaim;
      const progress=claim?[facts([['人工售后',({open:'等待答复',answered:'已答复',closed:'已关闭'})[claim.status]],['处理方',claim.responsibleRole],['问题',claim.reason],...(claim.note?[['我的说明',claim.note]]:[]),...(claim.reply?[['答复',claim.reply]]:[])])]:[];
      if(!claim||claim.status==='closed')progress.push(btn('manual-claim','申请售后'));
      return [heading('我的娃娃已签收'), hint('本单工厂已收 ' + money(o.factoryPaid) + '，团长已收服务费 ' + money(o.leaderPaid) + '。'), receipt,...progress];
    }
    if (o.status === 'refunded') return [heading('我的售后退款已退回'), hint('该单剩余货款与服务费已一起退回。'), receipt];
    if (o.status === 'disputed') return [heading('售后已交给' + o.responsibleRole), hint((o.reason || '订单异议') + '。仅这一单暂停结算。'), receipt];
    if (o.distributed) return [heading(o.status === 'reshipping' ? '补发已登记，待我签收' : '团长已分发，待我签收'), hint(filming), receipt,
      primary('receive', '确认收到我的娃娃'), btn('dispute', o.status === 'reshipping' ? '补发仍有问题' : '我的娃娃有问题')];
    if (paymentOpen()) return [heading('已付 ¥91，等待截止计价'), hint('目前实付 ' + team.paidCount + ' 个。截止满 100 个，每个退回 ¥22 差价。'), receipt, btn('money', '查看资金去向')];
    const text = { pay_closed: '已锁定商品价，等待开工', started: '工厂正在生产', shipped: '整批已发给团长', batch_received: '团长已收货，等待分发' };
    return [heading(text[p]), hint('截止实付 ' + team.paidCount + ' 个，每个商品款 ' + money(team.unit) + '，服务费 ' + money(team.fee) + '。'), receipt, btn('delivery-doc', '查看交付记录')];
  }
  function nextActor() {
    const o = team.mine, p = team.phase;
    if (p === 'distributed' || o?.distributed) {
      if(o?.manualClaim?.status==='open')return o.manualClaim.responsibleRole==='工厂'?'factory':'leader';
      if (o?.status === 'disputed') return o.responsibleRole === '工厂' ? 'factory' : 'leader';
      return o?.paid && ['paid', 'reshipping'].includes(o.status) ? 'buyer' : null;
    }
    if (p === 'open') return !o ? 'buyer' : 'leader';
    if (paymentOpen()) return o?.accepted && !o.paid ? 'buyer' : p === 'submitted' ? 'factory' : 'leader';
    return ({ draft: 'leader', proposed: 'factory', quoted: 'leader', pay_closed: 'factory', started: 'factory', shipped: 'leader', batch_received: 'leader' })[p];
  }
  function relevantEvents() {
    const mine = team.mine?.id;
    if (role === 'buyer') return team.events.filter(e => e.orderId ? e.orderId === mine : ['发布','报价','截止','交付','退差','退款','发货','分发','分货','签收','开工','生产'].some(s => e.title.includes(s)));
    if (role === 'factory') return team.events.filter(e => e.role === '工厂' || (!e.orderId && /需求|生产单|截止|冻结|退差|商户/.test(e.title)) ||
      (e.orderId && team.orders.some(o => o.id === e.orderId && o.responsibleRole === '工厂') && /异议|退款|补发/.test(e.title)));
    return team.events.filter(e => e.role === '团长' || (!e.orderId && /报价|接单|实付|发货|流团/.test(e.title)) ||
      (e.orderId && team.orders.some(o => o.id === e.orderId && o.responsibleRole === '团长') && /异议|退款|补发/.test(e.title)));
  }
  function timeline(events, limit) {
    const wrap = el('ol', 'record-list');
    for (const e of (limit ? events.slice(-limit) : events).slice().reverse()) {
      const item = el('li'); item.append(el('strong','',e.title), el('p','',e.detail), el('small','',fmt.format(new Date(e.at * 1000)) + ' · ' + e.role)); wrap.append(item);
    }
    return wrap;
  }
  function render() {
    const panel = byId('journey-content'), history = byId('journey-records'), next = byId('journey-next');
    document.querySelectorAll('#journey-tabs [data-role]').forEach(b => {
      const on = b.dataset.role === role; b.tabIndex = on ? 0 : -1; b.setAttribute('aria-selected', String(on)); b.classList.toggle('active', on);
      if (on && b.id) panel.setAttribute('aria-labelledby', b.id);
    });
    if (!team) { panel.replaceChildren(hint(error || '正在读取团单…'), ...(error ? [primary('retry','重新读取')] : [])); history.replaceChildren(); if(next) next.replaceChildren(); return; }
    const values = { groupId: id, phase: phases[team.phase], roleLabel: names[role], signupCount: team.signupCount, acceptedCount: team.acceptedCount, paidCount: team.paidCount };
    document.querySelectorAll('[data-field]').forEach(n => { if(Object.hasOwn(values,n.dataset.field)) n.textContent = values[n.dataset.field]; });
    const content = role === 'leader' ? leaderPanel() : role === 'factory' ? factoryPanel() : buyerPanel();
    panel.replaceChildren(...(error ? [note(error),btn('retry','重新读取')] : []), ...content);
    const actor = nextActor();
    const target = next || panel;
    if (next) { next.replaceChildren(); next.hidden = !actor || actor === role || !team.canManage; }
    if (actor && actor !== role && team.canManage) target.append(btn('tab-' + actor, '下一步 · 切到' + names[actor] + ' →', 'quiet-link role-next'));
    const events = relevantEvents();
    history.replaceChildren(...(events.length ? [timeline(events, 3)] : [note('还没有' + names[role] + '的记录。')]));
    if (events.length > 3) history.append(btn('records','查看' + names[role] + '的全部记录'));
    if (busy || error) panel.querySelectorAll('.role-action').forEach(b => b.disabled = true);
  }
  function agreement() {
    return [
      ['品名', product + ' · 每人报名 1 个'], ['制作及收款工厂', factory], ['起订与报价','50–99 个每个 ¥88；100 个起每个 ¥66。'],
      ['预付金额','商品款 ¥88 + 团长服务费 ¥3 = ¥91。报名与接单均不扣款。'],
      ['付款与截止','向工厂在微信支付的二级商户付款，订单金额先记入冻结余额。截止按有效实付数量计价。100 个起每个原路退 ¥22；不足 50 个每个全退 ¥91。'],
      ['生产与交付','工厂确认生产清单、按实付数量开工，付款截止后 15 天内整批发货。团长清点、签收整批后分发，拼友分别确认收到自己的娃娃。'],
      ['逐单结算','拼友无异议签收后，该单商品款结给工厂、¥3 服务费结给团长。质量问题由工厂处理，分装错漏由团长处理。异议只冻结该单，可补发或原路退还余款及服务费。'],
      ['数据来源','各角色在本地服务中确认。支付与链上回执均为模拟，查单无需连接钱包。']
    ];
  }
  function ownAndOrders(list, renderOrder) {
    const own = list.filter(o => !o.seed), seeded = list.filter(o => o.seed);
    const nodes = own.map(renderOrder);
    if (seeded.length) {
      const details = el('details', 'seed-list'); details.append(el('summary', '', '预置模拟拼友 · ' + seeded.length + ' 个'));
      const group = el('div', 'seed-orders'); seeded.forEach(o => group.append(renderOrder(o))); details.append(group); nodes.push(details);
    }
    return nodes;
  }
  function shareUrl() {
    const url = new URL(location.href); url.pathname = '/journey.html'; url.search = ''; url.searchParams.set('journey', id); url.hash = 'buyer'; return url.href;
  }
  function publicCopy() {
    const orders = team.orders.map(o => ({ id:o.id, seed:o.seed, accepted:o.accepted, paid:o.paid, distributed:o.distributed, status:o.status, prepaid:o.prepaid,
      goods:o.goods, fee:o.fee, refundTotal:o.refundTotal, held:o.held, factoryPaid:o.factoryPaid, leaderPaid:o.leaderPaid }));
    return { 团号:id, 报价版本:'V1', 模拟数据:true, 承诺条款:Object.fromEntries(agreement()), phase:team.phase, 报名:team.signupCount, 工厂接单:team.acceptedCount,
      实付:team.paidCount, 截止单价:billed()?team.unit:null, acceptedOrderIds:team.acceptedOrderIds, orders, 资金去向:team.totals, 确认记录:team.events };
  }
  function exportCopy() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(publicCopy(),null,2)],{type:'application/json;charset=utf-8'}));
    const a = el('a'); a.href=url; a.download='团簿-'+id+'.json'; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),2500);
  }
  function checklist(distribution=false) {
    const box = o => {
      const label=el('label','acceptance-choice'); const input=el('input'); input.type='checkbox'; input.name=distribution?'distribute-order':'accept-order'; input.value=o.id; input.checked=true; input.disabled=Boolean(distribution?o.distributed:o.accepted);
      label.append(input,el('span','',o.id + (o.mine?' · 我的订单':'') + (input.disabled?(distribution?' · 已分发':' · 已接单'):' · 1 个'))); return label;
    };
    const wrap=el('div','acceptance-list'); wrap.append(...ownAndOrders(distribution?team.orders.filter(o=>o.paid):team.orders,box));
    if(distribution) return [row('实付 / 已分发',team.paidCount+' / '+team.distributedCount+' 个'),note('勾选本次分发的订单。真人拼友需要自行确认签收。'),wrap,actions(primary('confirm-distribute','登记勾选订单已分发'),btn('dismiss','取消'))];
    return [row('报名 / 工厂已接',team.signupCount+' / '+team.acceptedCount+' 个'),note('默认勾选全部。暂时未接的订单可取消勾选，之后补确认。'),wrap,actions(primary('confirm-accept','确认勾选的订单'),btn('dismiss','取消'))];
  }
  function modalContent(which) {
    switch(which) {
      case 'error': return ['暂时无法完成操作',[note(error || '本次操作结果待核实，请重新读取团单。'),actions(primary('retry','重新读取团单'),btn('dismiss','关闭'))]];
      case 'terms': return ['拼团约定',[row('团号 / 版本',id+' / V1'),...agreement().map(([k,v])=>row(k,v)),actions(btn('quote-doc','工厂报价'),btn('production-doc','生产清单'),btn('delivery-doc','交付记录'),btn('download','保存完整副本'))]];
      case 'quote-doc': {
        const done = !['draft','proposed'].includes(team.phase);
        const signed = team.events.find(e=>e.role==='工厂' && e.title.includes('报价'));
        return ['工厂报价',[row('工厂',factory),row('报价状态',done?'已确认 · V1':'等待工厂确认'),row('商品',product),
          row('50–99 个 / 100 个起','¥88 / ¥66'),row('团长服务费','¥3 / 个'),row('交期','付款截止后 15 天内发货'),
          ...(signed?[row('工厂确认时间',fmt.format(new Date(signed.at*1000))+'（北京时间）')]:[])]];
      }
      case 'production-doc': return ['本团生产清单',[row('团号',id),stageCounts(),...(team.orders.length?ownAndOrders(team.orders,o=>row(o.id, (o.accepted?'已接':'未接')+(typeof o.paid==='boolean'?' · '+(o.paid?'已付':'未付'):''))) : [note('还没有报名。')])]];
      case 'delivery-doc': {
        const list=team.events.filter(e=>/开工|发货|分发|分货|签收|补发/.test(e.title)&&(!e.orderId || role!=='buyer' || e.orderId===team.mine?.id));
        return ['交付记录',[row('工厂',factory),row('已付数量', team.paidCount+' 个'),...(list.length?[timeline(list)]:[note('还没有发货或签收记录。')])]];
      }
      case 'records': return [names[role]+'的记录',[row('团号',id),timeline(relevantEvents())]];
      case 'money': {
        const t=team.totals;
        const body=role==='buyer' && team.mine ? [row('我的订单',team.mine.id),row('我已付',money(team.mine.prepaid)),row('我已收到退款',money(team.mine.refundTotal)),
          row('我的订单待结算',money(team.mine.held)),row('本单工厂 / 团长已结算',money(team.mine.factoryPaid)+' / '+money(team.mine.leaderPaid))] : [];
        return ['收款去向',[...body,row('整团已实付',money(t.prepaid)),row('工厂商户冻结余额',money(t.factoryMerchantHeld??t.held)),
          row('工厂已结算货款',money(t.factoryPaid)),row('团长已结算服务费',money(t.leaderPaid)),row('整团已原路退款',money(t.refunded)),
          note('以上均为模拟支付账目。冻结金额不能视为工厂已收入。')]];
      }
      case 'share': return ['分享报名链接',[note('打开同一链接可进入本团的拼友页面。本机地址仅供同一台电脑的不同浏览器或无痕窗口使用。'),row('拼友入口',shareUrl()),actions(primary('copy','复制链接'))]];
      case 'new': return ['另开体验团',[note('新团从空草稿开始。当前团仍可用原链接打开。'),selectInput('seed','发布后自动报名的模拟拼友',[[99,'99 个'],[98,'98 个'],[49,'49 个'],[48,'48 个'],[0,'0 个']],99),
        actions(primary('confirm-new','创建新团'),btn('dismiss','取消'))]];
      case 'propose': {
        const wrap=el('div','sheet-form-field'), label=el('label','sheet-note','预计定制数量（个）'), input=el('input'); input.type='number'; input.id='target-quantity'; input.min='1'; input.max='10000'; input.required=true; input.value='100'; label.htmlFor=input.id; wrap.append(label,input);
        return ['提交定制需求',[row('已定稿样品',product),row('接收工厂',factory),wrap,actions(primary('confirm-propose','提交给工厂'),btn('dismiss','取消'))]];
      }
      case 'accept': return ['确认生产订单',checklist()];
      case 'distribute': return ['核对分发清单',checklist(true)];
      case 'pay': return ['确认付款',[row('商品预付款',money(team.prepay)),row('团长服务费',money(team.fee)),row('本次合计',money(amount())),
        row('收款方',factory+' · 微信二级商户'),note('这笔钱先进入工厂商户的冻结余额，付款后才计入实付数量。本次为模拟付款。'),
        actions(primary('confirm-pay','确认模拟付款 '+money(amount())),btn('dismiss','取消'))]];
      case 'close-pay': return ['截止付款？',[stageCounts(), note(team.paidCount<50?'不足 50 个，每笔已付 ¥91 将原路全退。':
        '截止商品价每个 '+money(team.paidCount>=100?66:88)+'，每个已付订单退差价 '+money(team.paidCount>=100?22:0)+'。'),
        note('截止后不能再付款，工厂按实付数量安排生产。'),actions(primary('confirm-close-pay','确认截止'),btn('dismiss','继续收款'))]];
      case 'dispute': return ['我的娃娃有问题',[selectInput('claim-reason','问题类型',(team.reasonOptions||fallbackReasons).map(s=>[s,s])),
        note('分装错漏交团长处理，质量或与确认样不符交工厂处理。只冻结这一单。'),note(filming),actions(primary('confirm-dispute','提交售后'),btn('dismiss','取消'))]];
      case 'manual-claim': {
        const label=el('label','sheet-note','问题说明（最多 200 字）'), input=el('textarea'); input.id='manual-note'; input.maxLength=200; input.rows=3; label.htmlFor=input.id;
        return ['申请人工售后',[selectInput('claim-reason','问题类型',(team.reasonOptions||fallbackReasons).map(s=>[s,s])),label,input,
          note('责任方将查看你的说明并回复。此工单不改变已结算金额。'),actions(primary('confirm-manual','提交给责任方'),btn('dismiss','取消'))]];
      }
      case 'reply-claim':
      case 'close-claim': {
        const o=team.orders.find(o=>o.id===claimId), c=o?.manualClaim;
        if(!c||c.claimId!==manualNumber||c.responsibleRole!==names[role]||c.status==='closed')return ['工单状态已更新',[btn('dismiss','关闭')]];
        const label=el('label','sheet-note','给拼友的答复（最多 200 字）'), input=el('textarea');input.id='manual-reply';input.required=true;input.maxLength=200;input.rows=3;label.htmlFor=input.id;
        return [which==='reply-claim'?'答复人工售后':'关闭人工售后？',[row('订单',o.id),row('原因',c.reason),...(c.note?[row('拼友说明',c.note)]:[]),...(which==='reply-claim'?[label,input]:[]),
          actions(primary('confirm-'+which,which==='reply-claim'?'提交答复':'确认关闭工单'),btn('dismiss','取消'))]];
      }
      case 'refund':
      case 'reship': {
        const o=team.orders.find(o=>o.id===claimId);
        if(!o || o.status!=='disputed' || o.disputeRound!==claimRound) return ['订单状态已更新',[note('这轮售后已处理。'),btn('dismiss','关闭')]];
        return [which==='refund'?'退还本单余款？':'登记已补发？',[row('订单',o.id),row('问题',o.reason),row('处理方',o.responsibleRole),
          note(which==='refund'?'将 '+money(o.held)+' 原路退回，其中包含 ¥3 服务费。':'补发后继续冻结本单，等待拼友签收。'),
          actions(primary('confirm-'+which,which==='refund'?'确认退款':'确认已补发'),btn('dismiss','取消'))]];
      }
    }
  }
  function fillModal() {
    const result=modalContent(sheet); if(!result)return;
    byId('detail-title').textContent=result[0]; byId('detail-body').replaceChildren(...result[1]);
  }
  function open(which) {
    sheet=which; fillModal();
    const dialog=byId('detail'); if(!dialog.open)dialog.showModal();
    const h=byId('detail-title'); h.tabIndex=-1; h.focus({preventScroll:true}); byId('detail-body').scrollTop=0;
  }
  function close() { sheet=''; if(byId('detail').open)byId('detail').close(); }
  function setRole(next, focus=false) {
    if(!tabIds.includes(next))return; role=next;
    const url=new URL(location.href); url.hash=next; history.replaceState(null,'',url); render();
    if(focus) document.querySelector('#journey-tabs [data-role="'+role+'"]')?.focus();
  }
  function adopt(data) {
    team=data; id=data.id; error='';
    try { localStorage.setItem(lastKey,id); } catch { /* The URL also identifies this group. */ }
    const url=new URL(location.href); url.searchParams.set('journey',id); url.hash=role; history.replaceState(null,'',url);
  }
  async function api(action,body) {
    const creation=action==='new', reading=action==='read';
    const path=creation?'':'/'+encodeURIComponent(id)+(reading?'':'/'+encodeURIComponent(action));
    const opts={method:reading?'GET':'POST',credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(6000)};
    if(!reading){opts.headers={'Content-Type':'application/json'};opts.body=JSON.stringify(body||{});}
    const res=await fetch(apiBase+path,opts); const data=await res.json();
    if(!res.ok)throw new Error(data.error||'无法读取团单。');
    if(!data.id||!Array.isArray(data.events)||!Array.isArray(data.orders))throw new Error('没有收到有效的团单回执。');
    return data;
  }
  async function write(action,body={}) {
    if(busy)return;
    busy=true; generation++; render();
    byId('detail-body').querySelectorAll('button').forEach(b=>b.disabled=true);
    try {
      const data=await api(action,body);
      if(action==='new')role='leader';
      adopt(data); close();
    } catch(e) {
      error=e.name==='TypeError'||e.name==='TimeoutError'?'连接暂时中断，操作结果待核实，请重新读取。':e.message;
      open('error');
    } finally { busy=false;render(); }
  }
  async function poll() {
    if(busy||polling||!id||document.hidden)return;
    polling=true;const token=generation;
    try {
      const data=await api('read');
      if(token===generation&&(error||JSON.stringify(data)!==JSON.stringify(team))){
        adopt(data);render();
        if(['money','records','delivery-doc','production-doc','quote-doc','close-pay','refund','reship'].includes(sheet))fillModal();
      }
    } catch { if(token===generation&&!error){error='暂时无法读取最新团单，正在重新连接。';render();} }
    finally { polling=false; }
  }
  function copy() {
    const url=shareUrl(); const fallback=()=>{const input=el('input');input.value=url;input.readOnly=true;input.setAttribute('aria-label','拼友报名链接');byId('detail-body').append(input);input.select();};
    if(!navigator.clipboard){fallback();return;}
    navigator.clipboard.writeText(url).then(()=>byId('detail-body').append(note('链接已复制。')),fallback);
  }
  function handle(node) {
    if(busy)return;
    const a=node.dataset.action;
    if(a==='close'||a==='dismiss'){close();return;}
    if(a==='retry'){void write(id?'read':'new');return;}
    if(!team)return;
    if(a.startsWith('tab-')){setRole(a.slice(4),true);return;}
    if(['terms','money','share','new','records','quote-doc','production-doc','delivery-doc'].includes(a)){open(a);return;}
    if(a==='download'){exportCopy();return;} if(a==='copy'){copy();return;}
    if(error){open('error');return;}
    if(a==='confirm-new'&&sheet==='new'){void write('new',{seedCount:Number(byId('seed').value)});return;}
    const o=team.mine;
    if(role==='buyer'){
      if(a==='respond'&&!o&&team.phase==='open')void write('respond');
      if(a==='pay'&&o?.accepted&&!o.paid&&paymentOpen())open('pay');
      if(a==='confirm-pay'&&sheet==='pay'&&o?.accepted&&!o.paid&&paymentOpen())void write('pay');
      const canReceive=o?.paid&&o.distributed&&['paid','reshipping'].includes(o.status);
      if(canReceive&&a==='receive')void write('receive');
      if(canReceive&&a==='dispute'){claimRound=(o.disputeRound||0)+1;open('dispute');}
      if(canReceive&&a==='confirm-dispute'&&sheet==='dispute')void write('dispute',{reason:byId('claim-reason').value,round:claimRound});
      const canFile=o?.status==='received'&&(!o.manualClaim||o.manualClaim.status==='closed');
      if(canFile&&a==='manual-claim')open(a);
      if(canFile&&a==='confirm-manual'&&sheet==='manual-claim'){
        void write('manual-claim',{reason:byId('claim-reason').value,note:byId('manual-note').value.trim()});
      }
      return;
    }
    if(!team.canManage)return;
    const expected={propose:['leader','draft'],quote:['factory','proposed'],publish:['leader','quoted'],'submit-production':['leader','open'],accept:['factory','submitted'],start:['factory','pay_closed'],ship:['factory','started'],'receive-batch':['leader','shipped'],distribute:['leader','batch_received']};
    if(expected[a]?.[0]===role&&expected[a][1]===team.phase){
      if(['propose','accept','distribute'].includes(a))open(a);else void write(a);
      return;
    }
    if(role==='leader'&&a==='confirm-propose'&&sheet==='propose'){
      const input=byId('target-quantity'); if(input.reportValidity()&&Number(input.value)>0)void write('propose',{targetCount:Number(input.value)});return;
    }
    if(role==='factory'&&a==='confirm-accept'&&sheet==='accept'){
      const ids=[...byId('detail-body').querySelectorAll('input[name="accept-order"]:checked')].map(n=>n.value);
      if(ids.some(chosen=>!team.acceptedOrderIds.includes(chosen)))void write('accept',{orderIds:ids});
      else byId('detail-body').append(note('请勾选至少一个尚未接下的报名。'));
      return;
    }
    if(role==='leader'&&a==='confirm-distribute'&&sheet==='distribute'){
      const ids=[...byId('detail-body').querySelectorAll('input[name="distribute-order"]:checked:not(:disabled)')].map(n=>n.value);
      if(ids.length)void write('distribute',{orderIds:ids});else byId('detail-body').append(note('请选择本次分发的订单。'));
      return;
    }
    if(role==='leader'&&paymentOpen()&&a==='close-pay')open('close-pay');
    if(role==='leader'&&paymentOpen()&&a==='confirm-close-pay'&&sheet==='close-pay')void write('close-pay');
    if(['refund','reship'].includes(a)){
      const target=team.orders.find(o=>o.id===node.dataset.order&&o.responsibleRole===names[role]&&o.status==='disputed');
      if(target){claimId=target.id;claimRound=target.disputeRound;open(a);}return;
    }
    if(['reply-claim','close-claim'].includes(a)){
      const target=team.orders.find(o=>o.id===node.dataset.order&&o.manualClaim?.responsibleRole===names[role]&&o.manualClaim.status!=='closed');
      if(target){claimId=target.id;manualNumber=target.manualClaim.claimId;open(a);}return;
    }
    if(['confirm-reply-claim','confirm-close-claim'].includes(a)&&sheet===a.slice(8)){
      const payload={orderId:claimId,claimId:manualNumber,role:names[role]};
      if(sheet==='reply-claim'){const input=byId('manual-reply');payload.reply=input.value.trim();if(!payload.reply){input.focus();return;}}
      void write(sheet,payload);return;
    }
    if(['confirm-refund','confirm-reship'].includes(a)&&sheet===a.slice(8)){
      const target=team.orders.find(o=>o.id===claimId&&o.responsibleRole===names[role]&&o.disputeRound===claimRound&&o.status==='disputed');
      if(target)void write(sheet,{orderId:claimId,role:names[role],round:claimRound});
    }
  }
  function init() {
    const loc=new URL(location.href), explicit=loc.searchParams.get('journey');
    let last=''; try {last=localStorage.getItem(lastKey)||'';}catch{/* Explicit link still works. */}
    id=explicit||last; role=tabIds.includes(loc.hash.slice(1))?loc.hash.slice(1):explicit?'buyer':'leader';
    document.addEventListener('click',e=>{
      const tab=e.target.closest('#journey-tabs [data-role]');if(tab){setRole(tab.dataset.role);return;}
      const b=e.target.closest('[data-action]');if(b&&!b.disabled)handle(b);
    });
    byId('journey-tabs').addEventListener('keydown',e=>{
      const tab=e.target.closest('[data-role]');if(!tab)return;
      const i=tabIds.indexOf(tab.dataset.role), n={ArrowLeft:(i+2)%3,ArrowRight:(i+1)%3,Home:0,End:2}[e.key];
      if(n!==undefined){e.preventDefault();setRole(tabIds[n],true);}
    });
    byId('detail').addEventListener('close',()=>{if(!byId('detail').open)sheet='';});
    window.addEventListener('hashchange',()=>setRole(location.hash.slice(1)));
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poll();});
    render();void write(id?'read':'new');setInterval(poll,1800);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
