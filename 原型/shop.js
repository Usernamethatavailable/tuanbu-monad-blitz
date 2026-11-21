(() => {
  'use strict';

  const apiBase = '/api/v5/groups';
  const lastKey = 'tuanbu:shop:v5:last';
  const names = { leader: '团长', buyer: '拼友', factory: '工厂' };
  const tabIds = Object.keys(names);
  const phases = {
    draft: '草稿', proposed: '等待工厂报价', quoted: '工厂已报价', open: '接受报名', submitted: '工厂核对生产单',
    accepted: '已接单，等待付款截止', pay_closed: '已锁价', failed: '未成团', started: '生产中', shipped: '整批已发货', batch_received: '团长已收货', distributed: '已分发', batch_refunded: '整批已退款'
  };
  const factory = '山涧布偶工坊';
  const product = '棉花娃娃定制团';
  const filming = '开箱前开始连续录像，拍清包装面单、拆封过程、数量、娃娃正反面及瑕疵。';
  const fmt = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const byId = id => document.getElementById(id);
  const money = n => '¥' + n;
  const fallbackReasons = ['生产质量问题', '与确认样不符', '分装漏发', '分装错发'];
  let team = null, id = '', role = 'leader', sheet = '', error = '';
  let lastGroup = '';
  let busy = false, polling = false, generation = 0, loadedRole = '';
  let claimId = '', claimRound = 0, manualNumber = 0, payRequestId = '', reviewedBatch = null;

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
  const billed = () => !['draft', 'proposed', 'quoted', 'open', 'submitted', 'accepted'].includes(team.phase);
  const paymentOpen = () => ['submitted', 'accepted'].includes(team.phase);
  const stageCounts = () => facts([['已报名',team.signupOrderCount+' 人 / '+team.signupCount+' 个'],['工厂可供',team.acceptedCount+' 个'],['实付锁单',team.paidOrderCount+' 人 / '+team.paidCount+' 个']]);
  function livePrice() {
    const n=team.paidCount;
    const text=n<50?'实付未满 50 个，目前未成团':n<100?'当前商品价 ¥88 / 个，距 ¥66 档还差 '+(100-n)+' 个':'当前商品价 ¥66 / 个';
    return el('p','price-change',text+'。截止按实付数量定价。');
  }
  function paymentProgress(){
    const t=team.totals;
    return facts([['全团已预付',money(t.prepaid)],['按当前实付量预计商品款',team.paidCount<50?'未成团':money(team.paidCount*team.unit)]]);
  }
  function stockText(s) {
    if(s.decision==='reject')return '未接 · '+s.reason;
    if(s.decision==='pending')return '等待工厂确认';
    return s.limit!=null?'限供 '+s.limit+' 个，'+(s.remaining>0?'剩 '+s.remaining+' 个':'已抢完'):'全部接单';
  }
  function stockNotice() {
    const wrap=el('div','sku-stock');
    wrap.append(el('strong','','工厂接单通知'));
    for(const s of team.skuSummary.filter(s=>s.signupQty>0))wrap.append(el('p','',s.name+' · '+stockText(s)));
    wrap.append(el('small','','付款成功后锁定名额。'));
    return wrap;
  }
  function proofButton(e,text) {
    const b=btn('ledger',text);b.dataset.eventId=e.id;return b;
  }
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
  const catalog = () => team.catalogs || team.catalog;
  const skuCounts = sku => team.skuSummary.find(entry => entry.sku === sku) || {};
  function productCards(context = 'signup') {
    const list = el('div', 'sku-list');
    for (const sku of catalog()) {
      const count = skuCounts(sku.sku);
      const card = el('div', 'sku-card');
      if (sku.sku === 'bear') {
        const img = el('img','sku-photo'); img.src = '/assets/plush.webp'; img.alt = '栗栗熊棉花娃娃'; img.width = 54; img.height = 54;
        card.append(img);
      }
      const text = el('div','sku-info');
      text.append(el('strong','',sku.name),el('small','',[sku.size,sku.color].filter(Boolean).join(' · ')));
      card.append(text);
      const quantity = context === 'paid' ? count.paidQty : context === 'accepted' ? count.acceptedQty : count.signupQty;
      if (quantity !== undefined && !['draft','proposed','quoted'].includes(team.phase)) card.append(el('span','sku-quantity',quantity+' 个'+(context==='paid'?'已付':context==='accepted'?'已接':'报名')));
      list.append(card);
    }
    return list;
  }
  function orderItems(o) {
    const list = el('div','order-goods');
    for (const line of o.items || []) {
      const label = line.decision === 'reject' ? '未接 · '+(line.reason||'工厂未接单') :
        line.paidQty ? '已付 '+line.paidQty+' 个' : line.acceptedQty ? '工厂已接' : '待工厂接单';
      list.append(row(line.name+' × '+line.qty,label));
      if(billed()&&line.paidQty&&line.prepaid!==undefined)list.append(note('该款已付 '+money(line.prepaid)+'，已退 '+money(line.refundTotal)+'，净支付 '+money(line.prepaid-line.refundTotal)+'。'));
    }
    return list;
  }
  function buyerAmounts(o) {
    const refunded=o.refundTotal||0, net=o.prepaid-refunded;
    const final=['received','refunded'].includes(o.status)||['failed','batch_refunded'].includes(team.phase);
    const rows=[['我已付',money(o.prepaid)],['已退差价',money(o.discountRefund||0)]];
    if(billed()&&team.phase!=='failed')rows.push(['截止商品款',money(o.goods)],['截止计价服务费',money(o.fee)]);
    if(o.batchRefund)rows.push(['整批退回（含服务费）',money(o.batchRefund)]);
    if(o.disputeRefund)rows.push(['售后退回（含服务费）',money(o.disputeRefund)]);
    rows.push(['累计已退',money(refunded)],[final?'最终净支付':'当前净支付',money(net)],['当前冻结',money(o.held)]);
    if(final)rows.push(['工厂实际收款',money(o.factoryPaid)],['团长实际收取服务费',money(o.leaderPaid)]);
    return facts(rows);
  }
  function leaderAmounts() {
    const t=team.totals;
    return facts([['拼友已付',money(t.prepaid)],['已原路退回',money(t.refunded)],['拼友合计净支付',money(t.prepaid-t.refunded)],
      ['工厂货款已结算',money(t.factoryPaid)],['团长服务费待结算',money(t.leaderPending)],['团长服务费已收入',money(t.leaderPaid)]]);
  }
  const tiers = () => facts([['商品款 · 50–99 个','¥88 / 个'],['商品款 · 100 个起','¥66 / 个'],['团长服务费','¥3 / 个']]);
  function leaderPanel() {
    const p=team.phase;
    if (p==='draft') return [heading('发起棉花娃娃定制'), productCards(), managerAction('propose','向工厂发送定制需求')];
    if (p==='proposed') return [heading('等待工厂报价'),facts([['预计数量',team.targetCount+' 个'],['接收工厂',factory]]),productCards()];
    if (p==='quoted') return [heading('核对报价并开团'),productCards(),tiers(),facts([['预计数量',team.targetCount+' 个'],['生产交期','付款截止后 15 天内发货']]),managerAction('publish','确认报价并发布团单')];
    if (p==='open') return [heading('收集报名'),productCards(),facts([['报名总数',team.signupCount+' 个'],['已报名订单',team.signupOrderCount+' 笔']]),
      managerAction('submit-production','提交生产清单'),btn('share','分享报名链接')];
    if (paymentOpen()) return [heading('核对实际付款'),stageCounts(),livePrice(),paymentProgress(),productCards('accepted'),...(team.acceptedCount||p==='accepted'||!team.signupCount?[managerAction('close-pay','截止付款并计价')]:[]),btn('production-doc','查看采购明细')];
    if (p==='failed') return [heading('未达到起订量，已退款'),facts([['实付',team.paidCount+' 个'],['已退款',money(team.totals.refunded)],['团长服务费收入',money(team.totals.leaderPaid)]])];
    if(p==='batch_refunded'||team.batchIssue?.status==='open')return batchPanel();
    if(p==='shipped')return [heading('整箱到货核对'),shippingFacts(),hint('请先录制开箱视频，拍清面单、拆封和整箱数量。'),...batchDeadline(),actions(managerAction('receive-batch','确认整箱收货'),...(team.canManage&&batchWindowOpen()?[btn('batch-dispute','提交整箱问题','btn-secondary')]:[]))];
    if (p==='batch_received') return [...(afterSales('团长')||[]),heading('待分发'),facts([['已分发 / 应分发',team.distributedCount+' / '+team.paidCount+' 个'],['团长服务费已收入',money(team.totals.leaderPaid)]]),managerAction('distribute','打开分发清单'),...(canOpenBatch()?[btn('batch-dispute','提交整箱问题')]:[])];
    if (p==='distributed') return afterSales('团长')||[heading('整批已分发'),leaderAmounts(),hint('服务费随拼友逐单确认收货结算。')];
    return [heading(p==='pay_closed'?'截止交易明细':'工厂生产中'),facts([['截止实付',team.paidCount+' 个'],['成交商品单价',money(team.unit)+'/ 个']]),leaderAmounts()];
  }
  function shippingFacts() {
    const s=team.shipment;
    return facts([['物流公司',s?.carrier||'待登记'],['运单号',s?.trackingNumber||'待登记'],['实付件数',team.paidCount+' 个']]);
  }
  const showTime=t=>fmt.format(new Date(t*1000))+'（北京时间）';
  const batchWindowOpen=()=>!team.batchIssueDeadlineAt||Date.now()<=team.batchIssueDeadlineAt*1000;
  const canOpenBatch=()=>team.canManage&&['shipped','batch_received'].includes(team.phase)&&!team.distributedCount&&team.batchIssue?.status!=='open'&&batchWindowOpen();
  const batchDeadline=()=>[note(team.batchIssueDeadlineAt?'整箱问题受理至 '+showTime(team.batchIssueDeadlineAt):'整箱问题在物流送达后 48 小时内受理。')];
  function batchPanel(){
    const issue=team.batchIssue, refunded=team.phase==='batch_refunded';
    const result=[heading(refunded?'整批退款已完成':'整箱问题待协商'),el('p','issue-state',refunded?'本批订单余款已退回原支付方式。':'整批交付及结算已暂停。')];
    if(issue)result.push(facts([['问题',issue.reason],['涉及数量',issue.quantity+' 个']]));
    if(refunded)result.push(facts([['本次整批退款',money(team.totals.batchRefund||0)],['已结算服务费',money(team.totals.leaderPaid)]]));
    else if(issue?.proposal){
      const mode=issue.proposal==='refund'?'整批退款':'恢复交付',other=issue.proposedBy==='工厂'?'团长':'工厂';
      result.push(note(issue.proposedBy+'已提议'+mode+'，等待'+other+'确认。'));
      if(team.canManage&&names[role]===other){
        const alt=issue.proposal==='refund'?['batch-resolve','改提恢复交付']:['batch-refund','改提整批退款'];
        result.push(actions(primary('batch-'+issue.proposal,'确认'+mode+'方案'),btn(alt[0],alt[1],'btn-secondary')));
      }
    }else if(team.canManage&&role!=='buyer'){
      result.push(actions(primary('batch-resolve','提议恢复交付'),btn('batch-refund','提议整批退款','btn-secondary')));
    }
    return result;
  }
  function factoryPanel() {
    const p=team.phase;
    if(p==='batch_refunded'||team.batchIssue?.status==='open')return batchPanel();
    if(p==='draft')return [heading('暂无定制需求')];
    if(p==='proposed')return [heading('核对需求并报价'),hint('请先向团长确认数量、报价与生产交期，然后发送报价单。'),
      facts([['团长预计数量',team.targetCount+' 个'],['费用：（50–99 个 / 100 个起）','¥88 / ¥66'],['生产交期','付款截止后 15 天内发货']]),managerAction('quote','发送报价单')];
    if(p==='quoted')return [heading('报价单已发送'),facts([['团长预计数量',team.targetCount+' 个'],['费用：（50–99 个 / 100 个起）','¥88 / ¥66'],['生产交期','付款截止后 15 天内发货']])];
    if(p==='open')return [heading('待收到生产单'),productCards()];
    if(p==='submitted')return [heading('按款式确认生产单'),productCards(),stageCounts(),managerAction('accept','选择可接的款式')];
    if(p==='accepted')return [heading('生产单已确认'),productCards('accepted'),btn('production-doc','查看按款接单明细')];
    if(p==='pay_closed')return [heading('按实付清单开工'),productCards('paid'),facts([['商品成交单价',money(team.unit)+' / 个'],['总实付商品数',team.paidCount+' 个']]),managerAction('start','确认开始生产')];
    if(p==='started')return [heading('登记整箱物流'),productCards('paid'),...(team.shipDueAt?[facts([['最晚发货',fmt.format(new Date(team.shipDueAt*1000))]])]:[]),managerAction('ship','填写物流并发货')];
    if(p==='failed')return [heading('未成团，不安排生产')];
    return afterSales('工厂')||[heading('已整箱发货'),shippingFacts(),facts([['工厂货款已结算',money(team.totals.factoryPaid)],['拼友已签收',team.receivedOrderCount+' 笔']])];
  }
  function buyerPanel() {
    const p=team.phase,o=team.mine;
    if(!o){
      if(p==='open')return [heading('报名棉花娃娃'),productCards(),tiers(),primary('respond','选择款式并报名')];
      return [heading(['draft','proposed','quoted'].includes(p)?'报名尚未开放':'本团报名已截止'),btn('quote-doc','查看报价')];
    }
    if(p==='batch_refunded'||team.batchIssue?.status==='open')return [...batchPanel(),buyerAmounts(o)];
    if(paymentOpen()&&(o.items||[]).some(i=>i.decision==='accept'&&i.qty>i.paidQty)){
      const available=o.items.reduce((n,i)=>n+availableQty(i),0);
      return [heading(available?'核对待付订单':'已接款式名额已满'),orderItems(o),facts([['本单累计已付',money(o.prepaid)],['当前可付',available+' 个'],['每个预付','¥88 商品款 + ¥3 服务费']]),...(available?[primary('pay','选择本次付款商品')]:[]),btn('production-doc','工厂接单明细')];
    }
    if(!o.paid){
      const text=billed()?'本单未付款':o.acceptanceStatus==='rejected'?'所选款式未接单':paymentOpen()?'等待工厂确认款式':'报名已登记';
      return [heading(text),orderItems(o),facts([['报名数量',o.quantity+' 个'],['已付金额','¥0']]),btn('production-doc','查看生产清单')];
    }
    const receipt=buyerAmounts(o);
    if(p==='failed')return [heading('未成团，已原路退款'),orderItems(o),receipt];
    if(o.status==='received'){
      const c=o.manualClaim;
      const claims=c?[facts([['人工售后',({open:'等待答复',answered:'已答复',closed:'已关闭'})[c.status]],['处理方',c.responsibleRole],['问题',c.reason],...(c.note?[['我的说明',c.note]]:[]),...(c.reply?[['答复',c.reply]]:[])])]:[];
      if(!c||c.status==='closed')claims.push(btn('manual-claim','申请售后'));
      return [heading('订单已签收'),orderItems(o),receipt,...claims];
    }
    if(o.status==='refunded')return[heading('本单售后退款已退回'),receipt];
    if(o.status==='disputed')return[heading('售后处理中'),facts([['原因',o.reason],['处理方',o.responsibleRole]]),receipt];
    if(o.distributed)return[heading(o.status==='reshipping'?'补发已登记':'待确认收货'),hint(filming),orderItems(o),receipt,primary('receive','确认收到我的娃娃'),btn('dispute',o.status==='reshipping'?'补发仍有问题':'申请售后')];
    const text=paymentOpen()?'已付款，等待截止计价':({pay_closed:'截止交易明细',started:'工厂生产中',shipped:'整箱已发出',batch_received:'待团长分发',distributed:'待分发'})[p];
    return [heading(text),orderItems(o),...(billed()?[facts([['最终商品单价',money(team.unit)+' / 个']])]:[]),receipt];
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
      const item = el('li'); item.append(el('strong','',e.title), el('p','',e.detail), el('small','',fmt.format(new Date(e.at * 1000)) + ' · ' + e.role)); if(e.id!=null){const proof=btn('ledger','查看存证');proof.dataset.eventId=String(e.id);item.append(proof);} wrap.append(item);
    }
    return wrap;
  }
  function render() {
    const panel = byId('journey-content');
    document.querySelectorAll('#journey-tabs [data-role]').forEach(b => {
      const on = b.dataset.role === role; b.tabIndex = on ? 0 : -1; b.setAttribute('aria-selected', String(on)); b.classList.toggle('active', on);
      if (on && b.id) panel.setAttribute('aria-labelledby', b.id);
    });
    const ready=Boolean(team&&loadedRole===role);
    const newGroup=document.querySelector('.new-group'),footer=byId('group-footer');
    if(newGroup){newGroup.hidden=!ready;newGroup.disabled=!ready||busy;}
    if(footer){footer.hidden=!ready;footer.querySelectorAll('button').forEach(b=>b.disabled=!ready);}
    if (!id && !team) {
      const contents = [heading(role==='leader'?'发起棉花娃娃定制':'尚未打开团单')];
      if(role==='leader'){
        const start=primary('begin','发起开团'); start.disabled=busy; contents.push(start);
      }
      if(/^[0-9a-f]{12}$/.test(lastGroup)){
        const previous=el('a','quiet-link','打开上次团单');
        previous.href='?shop='+lastGroup+'#'+role; contents.push(previous);
      }
      panel.replaceChildren(...contents);return;
    }
    if (!team || loadedRole!==role) { panel.replaceChildren(hint(error || '正在读取团单…'), ...(error ? [primary('retry','重新读取')] : [])); return; }
    const values = { groupId: id, phase: phases[team.phase], roleLabel: names[role], signupCount: team.signupCount, acceptedCount: team.acceptedCount, paidCount: team.paidCount };
    document.querySelectorAll('[data-field]').forEach(n => { if(Object.hasOwn(values,n.dataset.field)) n.textContent = values[n.dataset.field]; });
    const content = role === 'leader' ? leaderPanel() : role === 'factory' ? factoryPanel() : buyerPanel();
    panel.replaceChildren(...(error ? [note(error),btn('retry','重新读取')] : []), ...content);
    if(role==='buyer'&&paymentOpen()){panel.append(stageCounts(),livePrice(),paymentProgress());if(team.skuSummary.some(s=>s.decision!=='pending'))panel.append(stockNotice());}
    if (busy || error) panel.querySelectorAll('.role-action').forEach(b => b.disabled = true);
  }
  function agreement() {
    return [
      ['商品', catalog().map(p=>p.name+' '+p.size+' '+p.color).join('、')], ['制作及收款工厂', factory], ['起订与报价','50–99 个每个 ¥88；100 个起每个 ¥66。'],
      ['每个预付','商品款 ¥88 + 团长服务费 ¥3 = ¥91。只支付工厂已接下的款式和数量。'],
      ['付款与截止','向工厂在微信支付的二级商户付款，订单金额先记入冻结余额。截止按有效实付数量计价。100 个起每个原路退 ¥22；不足 50 个每个全退 ¥91。'],
      ['生产与交付','工厂确认生产清单、按实付数量开工，付款截止后 15 天内整批发货。团长清点、签收整批后分发，拼友分别确认收到自己的娃娃。'],
      ['逐单结算','拼友无异议签收后，该单商品款结给工厂，每个娃娃 ¥3 服务费结给团长。质量问题由工厂处理，分装错漏由团长处理。异议只冻结该单，可补发或原路退还余款及服务费。'],
      ['数据来源','支付与物流为测试数据。各环节分别生成存证，查单无需连接钱包。']
    ];
  }
  function shareUrl() {
    const url = new URL(location.href); url.pathname = '/shop.html'; url.search = ''; url.searchParams.set('shop', id); url.hash = 'buyer'; return url.href;
  }
  function publicCopy() {
    const orders = team.orders.map(o => ({ id:o.id, seed:o.seed, items:o.items, quantity:o.quantity, acceptedQty:o.acceptedQty,paidQty:o.paidQty, accepted:o.accepted, paid:o.paid, distributed:o.distributed, status:o.status, prepaid:o.prepaid,
      goods:o.goods, fee:o.fee, refundTotal:o.refundTotal, held:o.held, factoryPaid:o.factoryPaid, leaderPaid:o.leaderPaid }));
    return { 团号:id,款式:team.skuSummary,发货时间:team.shipment?.shippedAt, 报价版本:'V1', 模拟数据:true, 承诺条款:Object.fromEntries(agreement()), phase:team.phase, 报名:team.signupCount, 工厂接单:team.acceptedCount,
      实付:team.paidCount, 截止单价:billed()?team.unit:null, acceptedOrderIds:team.acceptedOrderIds, orders, 资金去向:team.totals, 确认记录:team.events };
  }
  function exportCopy() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(publicCopy(),null,2)],{type:'application/json;charset=utf-8'}));
    const a = el('a'); a.href=url; a.download='团簿-'+id+'.json'; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),2500);
  }
  let quantities = {}, recipientSelection = '', recipientDraft = {};
  function resetSignup() {
    quantities = Object.fromEntries(catalog().map((p,i)=>[p.sku,i===0?1:0]));
    const first=team.recipientOptions?.[0]||{};
    recipientSelection=first.id||'cloud';
    recipientDraft={name:first.name||'',phone:first.phone||'',address:first.address||''};
  }
  function captureRecipient() {
    byId('detail-body').querySelectorAll('[data-recipient]').forEach(input=>{recipientDraft[input.dataset.recipient]=input.value;});
  }
  function recipientFields() {
    const wrap=el('div','recipient-fields');
    for(const [key,title,limit,autocomplete] of [['name','收件人姓名',40,'shipping name'],['phone','联系电话',32,'shipping tel'],['address','收货地址',160,'shipping street-address']]){
      const block=el('div','sheet-form-field'),label=el('label','sheet-note',title),input=el(key==='address'?'textarea':'input');
      input.id='recipient-'+key;label.htmlFor=input.id;input.dataset.recipient=key;input.required=true;input.maxLength=limit;input.autocomplete=autocomplete;
      if(key==='phone')input.type='tel';
      if(key==='address'){input.rows=2;input.minLength=2;}
      input.value=recipientDraft[key];block.append(label,input);wrap.append(block);
    }
    wrap.append(note('收货资料供团长分发核对，公开存证不含姓名、电话或地址。'));
    return wrap;
  }
  function signupForm() {
    const list=el('div','sku-list');
    for(const p of catalog()){
      const n=quantities[p.sku]||0;
      const cell=el('div','sku-card');
      if(p.sku==='bear'){const image=el('img','sku-photo');image.src='/assets/plush.webp';image.alt='栗栗熊';cell.append(image);}
      const choose=el('div','sku-info'),label=el('label','sku-check'),check=el('input');
      check.type='checkbox';check.checked=n>0;check.dataset.skuToggle=p.sku;label.append(check,el('strong','',p.name));
      choose.append(label,el('small','',[p.size,p.color].filter(Boolean).join(' · ')));cell.append(choose);
      const step=el('div','quantity-stepper');
      const minus=btn('qty-minus','−','quantity-button'), plus=btn('qty-plus','+','quantity-button');minus.disabled=n<=1;plus.disabled=n===0||n>=999;
      for(const [b,op] of [[minus,'减少'],[plus,'增加']]){b.dataset.sku=p.sku;b.setAttribute('aria-label',op+p.name+'数量');}
      step.append(minus,el('span','',n+' 个'),plus);cell.append(step);list.append(cell);
    }
    const sum=Object.values(quantities).reduce((a,b)=>a+b,0);
    const confirm=primary('confirm-respond','确认报名 '+sum+' 个');confirm.disabled=!sum;
    return [list,row('报名合计',sum+' 个'),row('现在付款','¥0'),recipientFields(),actions(confirm,btn('dismiss','取消'))];
  }
  function decisionForm() {
    const wrap=el('div','sku-decision-list'),summary=el('p','decision-header','');summary.id='decision-quantity';wrap.append(summary);
    for(const s of team.skuSummary.filter(x=>x.signupQty>0)){
      const li=el('div','decision-card');li.dataset.decisionSku=s.sku;
      const label=el('label','sku-check'), check=el('input');check.type='checkbox';check.dataset.decision='1';check.checked=s.decision!=='reject';check.disabled=s.decision!=='pending';
      label.append(check,el('strong','',s.name+' · '+s.signupQty+' 个'));li.append(label);
      const field=el('div','sheet-form-field'), caption=el('label','sheet-note','可供数量（个）'), capacity=el('input');
      capacity.type='number';capacity.min='1';capacity.max=String(s.signupQty);capacity.step='1';capacity.required=true;capacity.value=String(s.limit??s.signupQty);
      capacity.dataset.capacity=s.sku;capacity.id='capacity-'+s.sku;caption.htmlFor=capacity.id;field.append(caption,capacity);li.append(field);
      const tag=el('p','sheet-note',s.decision==='reject'?'已拒接 · '+s.reason:s.decision==='accept'?'已确认接单':'');
      if(tag.textContent)li.append(tag);
      const why=el('select');for(const reason of team.rejectReasons||['缺料','面料缺货','配件缺货','产能不足','无法按期交货']){const option=el('option','',reason);option.value=reason;why.append(option);}why.value=s.reason||'缺料';why.dataset.reason='1';why.setAttribute('aria-label',s.name+'未接原因');why.hidden=check.checked||check.disabled;li.append(why);wrap.append(li);
    }
    return [wrap,actions(primary('confirm-accept','提交接单结果'),btn('dismiss','取消'))];
  }
  function decisionCount() {
    const count=byId('decision-quantity');if(!count)return;
    let total=0,styles=0;
    byId('detail-body').querySelectorAll('[data-decision-sku]').forEach(box=>{
      const s=skuCounts(box.dataset.decisionSku), check=box.querySelector('[data-decision]'), why=box.querySelector('[data-reason]');
      const capacity=box.querySelector('[data-capacity]');capacity.disabled=!check.checked||check.disabled;capacity.parentElement.hidden=!check.checked;
      if(check.checked){const n=capacity.valueAsNumber;total+=Number.isFinite(n)&&n>0&&n<=s.signupQty?n:0;styles++;}why.hidden=check.checked||check.disabled;
    });
    count.textContent='已选 '+total+' 个 / '+styles+' 款';
  }
  function availableQty(line){
    if(line.decision!=='accept')return 0;
    const remaining=line.remaining??skuCounts(line.sku).remaining??Infinity;
    return Math.max(0,Math.min(line.qty-line.paidQty,remaining));
  }
  function payForm() {
    const o=team.mine, list=el('div','sku-list');
    for(const line of o.items.filter(i=>i.decision==='accept'&&i.qty>i.paidQty)){
      const item=el('div','sheet-form-field'),label=el('label','sheet-note',line.name+' · 本次付款数量'),input=el('input');
      const due=line.qty-line.paidQty;input.type='number';input.min='0';input.max=String(due);input.step='1';input.required=true;
      input.value=String(availableQty(line)>0?due:0);input.dataset.paySku=line.sku;input.id='pay-'+line.sku;label.htmlFor=input.id;
      const stock=el('small','sku-stock');stock.dataset.payAvailable=line.sku;item.append(label,input,stock);list.append(item);
    }
    const summary=el('div');summary.id='payment-summary';
    return [list,summary,row('收款方',factory+' · 微信二级商户'),note('填写 0 可跳过本款。测试支付成功后，所选数量才会锁定。'),actions(primary('confirm-pay','确认支付'),btn('dismiss','取消'))];
  }
  function updatePaymentForm(){
    const summary=byId('payment-summary');if(!summary)return;
    let count=0,valid=paymentOpen();
    for(const input of byId('detail-body').querySelectorAll('[data-pay-sku]')){
      const line=team.mine?.items.find(i=>i.sku===input.dataset.paySku);
      const available=line?availableQty(line):0,unpaid=line?line.qty-line.paidQty:0;
      const n=input.valueAsNumber;
      const stock=input.parentElement.querySelector('[data-pay-available]');
      stock.textContent='本单还有 '+unpaid+' 个未付，当前可付 '+available+' 个。';
      if(!Number.isInteger(n)||n<0||n>available){valid=false;stock.textContent+=' 请调整数量。';}else count+=n;
    }
    const total=count*(team.prepay+team.fee),confirm=byId('detail-body').querySelector('[data-action="confirm-pay"]');
    summary.replaceChildren(row('本次商品预付',valid?money(team.prepay*count):'待核对'),row('本次服务费',valid?money(team.fee*count):'待核对'),row('待付合计',valid?money(total):'请核对数量'));
    confirm.textContent=valid&&count?'确认支付 '+money(total):'确认支付';confirm.disabled=!valid||!count||busy;
  }
  function batchForm(){
    const limit=el('div','sheet-form-field'),label=el('label','sheet-note','涉及数量（个）'),qty=el('input');qty.type='number';qty.required=true;qty.min='1';qty.max=String(team.paidCount);qty.id='batch-quantity';qty.value='1';label.htmlFor=qty.id;limit.append(label,qty);
    const reasons=team.batchReasonOptions||['整箱少件','批量质量问题','整箱破损','款式或数量不符'];
    return [selectInput('batch-reason','问题类型',reasons.map(r=>[r,r])),limit,...batchDeadline(),note('提交后暂停本批交付及结算，待工厂和团长协商。'),actions(primary('confirm-batch-dispute','提交整箱问题'),btn('dismiss','取消'))];
  }
  function shippingForm() {
    const nodes=[];
    for(const [key,label,value] of [['carrier','物流公司','顺丰速运'],['tracking','物流单号','SF-DEMO-20261121']]){
      const wrap=el('div','sheet-form-field'),l=el('label','sheet-note',label),n=el('input');n.id=key;n.required=true;n.value=value;n.maxLength=key==='carrier'?40:64;l.htmlFor=key;wrap.append(l,n);nodes.push(wrap);
    }
    return [...nodes,row('发出数量',team.paidCount+' 个'),actions(primary('confirm-ship','确认发货'),btn('dismiss','取消'))];
  }
  function distributionForm() {
    const wrap=el('div','dispatch-list'),search=el('input','dispatch-search');search.id='dispatch-search';search.placeholder='按订单号、姓名、电话或地址查找';search.setAttribute('aria-label','查找收件人');
    const summary=el('p','decision-header');summary.id='dispatch-summary';
    wrap.append(search,summary);
    const orders=team.orders.filter(o=>o.paid).sort((a,b)=>Number(a.seed)-Number(b.seed));
    for(const o of orders){
      const r=o.recipient||{}, item=el('div','dispatch-item');item.dataset.search=[o.id,r.name,r.phone,r.address].join(' ').toLowerCase();
      const line=el('label','acceptance-choice'),check=el('input');check.type='checkbox';check.name='distribute-order';check.value=o.id;check.checked=!o.distributed;check.disabled=Boolean(o.distributed);
      line.append(check,el('strong','',o.id+' · '+(r.name||'收件人')+' · '+o.paidQty+' 个'+(o.distributed?' · 已分发':'')));
      item.append(line,el('p','',[(r.phone||''),r.address].filter(Boolean).join(' · ')),el('small','',(o.items||[]).filter(i=>i.paidQty>0).map(i=>i.name+' × '+i.paidQty).join('，')));wrap.append(item);
    }
    return [wrap,actions(btn('dispatch-all','仅勾选搜索结果'),btn('dispatch-none','清空勾选'),primary('confirm-distribute','登记分发'),btn('dismiss','取消'))];
  }
  function updateDispatch() {
    const key=(byId('dispatch-search')?.value||'').trim().toLowerCase();let found=0,count=0,selected=0;
    document.querySelectorAll('.dispatch-item').forEach(n=>{n.hidden=!n.dataset.search.includes(key);if(!n.hidden)found++;const box=n.querySelector('input');if(box.checked&&!box.disabled){count++;selected+=team.orders.find(o=>o.id===box.value).paidQty;}});
    if(byId('dispatch-summary'))byId('dispatch-summary').textContent='找到 '+found+' 单 · 已选 '+count+' 单 / '+selected+' 个';
    const submit=byId('detail-body').querySelector('[data-action="confirm-distribute"]');if(submit){submit.disabled=!count;submit.textContent=count?'登记分发（'+count+' 单）':'登记分发';}
  }
  function modalContent(which) {
    switch(which) {
      case 'error': return ['暂时无法完成操作',[note(error || '本次操作结果待核实，请重新读取团单。'),actions(primary('retry','重新读取团单'),btn('dismiss','关闭'))]];
      case 'terms': return ['团单明细',[row('团号 / 版本',id+' / V1'),...agreement().map(([k,v])=>row(k,v)),actions(btn('quote-doc','工厂报价'),btn('production-doc','生产清单'),btn('money','收款明细'),btn('delivery-doc','交付记录'),btn('share','分享团单'),btn('download','保存完整副本'))]];
      case 'quote-doc': {
        const done = !['draft','proposed'].includes(team.phase);
        const signed = team.events.find(e=>e.role==='工厂' && e.title.includes('报价'));
        return ['工厂报价',[row('工厂',factory),row('报价状态',done?'已确认 · V1':'等待工厂确认'),row('商品',product),
          row('50–99 个 / 100 个起','¥88 / ¥66'),row('团长服务费','¥3 / 个'),productCards(),row('交期','付款截止后 15 天内发货'),
          ...(signed?[row('工厂确认时间',showTime(signed.at)),proofButton(signed,'核验工厂报价原件')]:[])]];
      }
      case 'production-doc': return ['本团生产清单',[row('团号',id),stageCounts(),...team.skuSummary.map(s=>row(s.name,(stockText(s))+' · 报名 '+s.signupQty+' 个 / 已接 '+s.acceptedQty+' 个 / 实付 '+s.paidQty+' 个'))]];
      case 'delivery-doc': {
        const list=team.events.filter(e=>/开工|发货|分发|分货|签收|补发/.test(e.title)&&(!e.orderId || role!=='buyer' || e.orderId===team.mine?.id));
        return ['交付记录',[row('工厂',factory),row('已付数量', team.paidCount+' 个'),...(list.length?[timeline(list)]:[note('还没有发货或签收记录。')])]];
      }
      case 'records': return [names[role]+'的记录',[row('团号',id),timeline(relevantEvents())]];
      case 'money': {
        const t=team.totals;
        const body=role==='buyer' && team.mine ? [row('我的订单',team.mine.id),row('我已付',money(team.mine.prepaid)),row('我已收到退款',money(team.mine.refundTotal)),row(['received','refunded'].includes(team.mine.status)||team.phase==='failed'?'最终净支付':'当前净支付',money(team.mine.prepaid-team.mine.refundTotal)),
          row('我的订单待结算',money(team.mine.held)),row('本单工厂实际收款',money(team.mine.factoryPaid)),row('本单团长实际服务费',money(team.mine.leaderPaid))] : [];
        return ['收款去向',[...body,row('测试账目 · 整团已实付',money(t.prepaid)),row('工厂商户冻结余额',money(t.factoryMerchantHeld??t.held)),
          row('工厂已结算货款',money(t.factoryPaid)),row('团长待结算服务费',money(t.leaderPending)),row('团长已结算服务费',money(t.leaderPaid)),row('整团已原路退款',money(t.refunded)),
          btn('ledger','查看存证记录')]];
      }
      case 'share': return ['分享团单',[row('团号',id),row('报名链接',shareUrl()),actions(primary('copy','复制团号和链接'))]];
      case 'new': return ['新开团',[note('将创建独立团号，原团单可通过原链接查看。'),actions(primary('confirm-new','创建新团'),btn('dismiss','取消'))]];
      case 'respond':return ['核对报名商品及收货信息',signupForm()];
      case 'propose': {
        const wrap=el('div','sheet-form-field'), label=el('label','sheet-note','预计定制数量（个）'), input=el('input'); input.type='number'; input.id='target-quantity'; input.min='1'; input.max='10000'; input.required=true; input.value='100'; label.htmlFor=input.id; wrap.append(label,input);
        return ['提交定制需求',[row('已定稿样品',product),row('接收工厂',factory),wrap,actions(primary('confirm-propose','提交给工厂'),btn('dismiss','取消'))]];
      }
      case 'accept': return ['确认可接款式',decisionForm()];
      case 'distribute': return ['分发清单',distributionForm()];
      case 'ship': return ['登记整箱发货',shippingForm()];
      case 'pay':return ['核对本次付款',payForm()];
      case 'batch-dispute':return ['整箱到货问题',batchForm()];
      case 'batch-resolve':
      case 'batch-refund':{
        const refund=which==='batch-refund', action=refund?'整批退款':'恢复交付',confirm=team.batchIssue?.proposal===which.slice(6);
        const details=refund?[row('拟原路退款',money(team.totals.held))]:[];
        const hint=confirm?(refund?'双方确认后，各笔订单余款原路退回。':'双方确认后，团长可核对并签收整箱。'):'对方确认方案后生效。';
        return [(confirm?'确认':'提议')+action,[...details,note(hint),actions(primary('confirm-'+which,confirm?'确认'+action:'提交方案'),btn('dismiss','取消'))]];
      }
      case 'close-pay': return ['截止付款？',[stageCounts(), note(team.paidCount<50?'不足 50 个，按每个实付 ¥91 全额原路退款。':
        '截止商品价每个 '+money(team.paidCount>=100?66:88)+'，每个娃娃退差价 '+money(team.paidCount>=100?22:0)+'。'),
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
          note(which==='refund'?'将 '+money(o.held)+' 原路退回，其中包含 '+money(o.paidQty*team.fee)+' 服务费。':'补发后继续冻结本单，等待拼友签收。'),
          actions(primary('confirm-'+which,which==='refund'?'确认退款':'确认已补发'),btn('dismiss','取消'))]];
      }
    }
  }
  function fillModal() {
    const result=modalContent(sheet); if(!result)return;
    byId('detail-title').textContent=result[0]; byId('detail-body').replaceChildren(...result[1]); if(sheet==='accept')decisionCount();if(sheet==='pay')updatePaymentForm();if(sheet==='distribute')updateDispatch();
  }
  function open(which) {
    sheet=which; fillModal();
    const dialog=byId('detail'); if(!dialog.open)dialog.showModal();
    const h=byId('detail-title'); h.tabIndex=-1; h.focus({preventScroll:true}); byId('detail-body').scrollTop=0;
  }
  function close() { sheet=''; if(byId('detail').open)byId('detail').close(); }
  async function setRole(next,focus=false) {
    if(!tabIds.includes(next)||busy||next===role)return;
    role=next;const token=++generation, url=new URL(location.href);url.hash=next;history.replaceState(null,'',url);
    if(!id){render();return;}
    busy=true;render();
    try{const data=await api('read');if(token===generation)adopt(data);}
    catch(e){error=e.message;open('error');}
    finally{busy=false;render(); if(focus)document.querySelector('#journey-tabs [data-role="'+role+'"]')?.focus();}
  }
  function adopt(data) {
    team=data; id=data.id; loadedRole=role; error=''; document.dispatchEvent(new Event('shop:update'));
    try { localStorage.setItem(lastKey,id); } catch { /* The URL also identifies this group. */ }
    const url=new URL(location.href); url.searchParams.set('shop',id); url.hash=role; history.replaceState(null,'',url);
  }
  async function api(action,body) {
    const creation=action==='new', reading=action==='read';
    const path=creation?'':'/'+encodeURIComponent(id)+(reading?'':'/'+encodeURIComponent(action));
    const opts={method:reading?'GET':'POST',credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(6000)};
    if(!reading){opts.headers={'Content-Type':'application/json'};opts.body=JSON.stringify(body||{});}
    const res=await fetch(apiBase+path+'?role='+encodeURIComponent(role),opts); const data=await res.json();
    if(!res.ok){const issue=new Error(data.error||'无法读取团单。');issue.status=res.status;throw issue;}
    if(!data.id||!Array.isArray(data.events)||!Array.isArray(data.orders))throw new Error('没有收到有效的团单回执。');
    return data;
  }
  async function write(action,body={},openProposal=false) {
    if(busy)return;
    busy=true; generation++; render();
    byId('detail-body').querySelectorAll('button').forEach(b=>b.disabled=true);
    try {
      const data=await api(action,body);
      if(action==='new')role='leader';
      adopt(data); close();
      if(openProposal)open('propose');
    } catch(e) {
      if(action==='pay'&&sheet==='pay'&&e.status===409){
        try{adopt(await api('read'));}catch{error='请重新读取库存。';open('error');return;}
        const message=byId('detail-body').querySelector('[data-pay-warning]')||el('p','issue-state');
        message.dataset.payWarning='1';message.textContent=e.message;byId('detail-body').prepend(message);return;
      }
      if(action==='respond'&&sheet==='respond'&&e.status===400){
        fillModal();byId('detail-body').prepend(note(e.message));return;
      }
      error=e.name==='TypeError'||e.name==='TimeoutError'?'连接暂时中断，操作结果待核实，请重新读取。':e.message;
      open('error');
    } finally { busy=false;render();if(sheet==='pay')updatePaymentForm(); }
  }
  async function poll() {
    if(busy||polling||!id||document.hidden)return;
    polling=true;const token=generation;
    try {
      const data=await api('read');
      if(token===generation&&(error||JSON.stringify(data)!==JSON.stringify(team))){
        adopt(data);render();if(sheet==='pay')updatePaymentForm();
        if(['money','records','delivery-doc','production-doc','quote-doc','close-pay','refund','reship'].includes(sheet))fillModal();
      }
    } catch { if(token===generation&&!error){error='暂时无法读取最新团单，正在重新连接。';render();} }
    finally { polling=false; }
  }
  function copy() {
    const url='团号 '+id+'\n'+shareUrl(); const fallback=()=>{const input=el('input');input.value=url;input.readOnly=true;input.setAttribute('aria-label','拼友报名链接');byId('detail-body').append(input);input.select();};
    if(!navigator.clipboard){fallback();return;}
    navigator.clipboard.writeText(url).then(()=>byId('detail-body').append(note('链接已复制。')),fallback);
  }
  function handle(node) {
    if(busy)return;
    const a=node.dataset.action;
    if(a==='begin'&&!id&&role==='leader'){void write('new',{},true);return;}
    if(a==='close'||a==='dismiss'){close();return;}
    if(a==='retry'){if(id)void write('read');else if(role==='leader')void write('new',{},true);return;}
    if(!team||loadedRole!==role)return;
    if(a==='ledger')return;
    if(['terms','money','share','new','records','quote-doc','production-doc','delivery-doc'].includes(a)){open(a);return;}
    if(a==='download'){exportCopy();return;} if(a==='copy'){copy();return;}
    if(error){open('error');return;}
    if(a==='confirm-new'&&sheet==='new'){void write('new',{},true);return;}
    const o=team.mine;
    if(role==='buyer'){
      if(a==='respond'&&!o&&team.phase==='open'){resetSignup();open('respond');}
      if(sheet==='respond'&&['qty-plus','qty-minus'].includes(a)){
        captureRecipient();const key=node.dataset.sku,n=quantities[key];if(n>0)quantities[key]=Math.max(1,Math.min(999,n+(a==='qty-plus'?1:-1)));fillModal();
      }
      if(sheet==='respond'&&a==='confirm-respond'&&!o&&team.phase==='open'){
        const items=Object.entries(quantities).filter(([,qty])=>qty>0).map(([sku,qty])=>({sku,qty}));
        captureRecipient();
        const fields=[...byId('detail-body').querySelectorAll('[data-recipient]')];
        if(fields.some(input=>!input.reportValidity()))return;
        const recipient=Object.fromEntries(Object.entries(recipientDraft).map(([key,value])=>[key,value.trim()]));
        if(items.length)void write('respond',{items,recipientId:recipientSelection,recipient});
      }
      if(a==='pay'&&paymentOpen()&&o?.items.some(i=>availableQty(i)>0)){payRequestId=crypto.randomUUID();open('pay');}
      if(a==='confirm-pay'&&sheet==='pay'&&paymentOpen()){
        updatePaymentForm();if(node.disabled)return;
        const items=[...byId('detail-body').querySelectorAll('[data-pay-sku]')].filter(n=>n.valueAsNumber>0).map(n=>({sku:n.dataset.paySku,qty:n.valueAsNumber}));
        if(items.length)void write('pay',{items,requestId:payRequestId});
      }
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
    if(a==='batch-dispute'&&role==='leader'&&canOpenBatch()){open(a);return;}
    if(a==='confirm-batch-dispute'&&sheet==='batch-dispute'&&role==='leader'){
      const qty=byId('batch-quantity');if(qty.reportValidity())void write('batch-dispute',{reason:byId('batch-reason').value,quantity:qty.valueAsNumber});return;
    }
    if(team.batchIssue?.status==='open'&&['leader','factory'].includes(role)){
      if(['batch-refund','batch-resolve'].includes(a)&&team.batchIssue.proposedBy!==names[role]){
        const issue=team.batchIssue;reviewedBatch={caseId:issue.caseId,expectedProposal:issue.proposal??null,expectedProposedBy:issue.proposedBy??null};open(a);return;
      }
      if(['confirm-batch-resolve','confirm-batch-refund'].includes(a)&&sheet===a.slice(8)&&reviewedBatch){
        const issue=team.batchIssue;
        if(reviewedBatch.caseId!==issue.caseId||reviewedBatch.expectedProposal!==(issue.proposal??null)||reviewedBatch.expectedProposedBy!==(issue.proposedBy??null)){close();render();return;}
        void write(sheet,{role:names[role],...reviewedBatch});return;
      }
    }
    const expected={propose:['leader','draft'],quote:['factory','proposed'],publish:['leader','quoted'],'submit-production':['leader','open'],accept:['factory','submitted'],start:['factory','pay_closed'],ship:['factory','started'],'receive-batch':['leader','shipped'],distribute:['leader','batch_received']};
    if(expected[a]?.[0]===role&&expected[a][1]===team.phase){
      if(['propose','accept','distribute','ship'].includes(a))open(a);else void write(a);
      return;
    }
    if(role==='leader'&&a==='confirm-propose'&&sheet==='propose'){
      const input=byId('target-quantity'); if(input.reportValidity()&&Number(input.value)>0)void write('propose',{targetCount:Number(input.value)});return;
    }
    if(role==='factory'&&a==='confirm-accept'&&sheet==='accept'){
      const decisions=[];
      for(const card of byId('detail-body').querySelectorAll('[data-decision-sku]')){
        const checkbox=card.querySelector('[data-decision]');if(checkbox.disabled)continue;
        const reason=card.querySelector('[data-reason]'),data={sku:card.dataset.decisionSku,decision:checkbox.checked?'accept':'reject'};
        if(!checkbox.checked){data.reason=reason.value.trim();if(!data.reason){reason.focus();reason.setCustomValidity('请填写未接原因');reason.reportValidity();reason.setCustomValidity('');return;}}
        if(checkbox.checked){
          const input=card.querySelector('[data-capacity]');if(!input.reportValidity())return;
          if(input.valueAsNumber<skuCounts(data.sku).signupQty)data.limit=input.valueAsNumber;
        }
        decisions.push(data);
      }
      if(decisions.length)void write('accept',{decisions});return;
    }
    if(role==='factory'&&sheet==='ship'&&a==='confirm-ship'){
      const carrier=byId('carrier'),tracking=byId('tracking');if(!carrier.reportValidity()||!tracking.reportValidity())return;
      void write('ship',{carrier:carrier.value.trim(),trackingNumber:tracking.value.trim()});return;
    }
    if(role==='leader'&&sheet==='distribute'&&['dispatch-all','dispatch-none'].includes(a)){
      document.querySelectorAll('.dispatch-item').forEach(row=>{const checkbox=row.querySelector('input');if(!checkbox.disabled)checkbox.checked=a==='dispatch-all'&&!row.hidden;});updateDispatch();return;
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
  window.tuanbuShopSnapshot=()=>team&&loadedRole===role?structuredClone(team):null;
  function init() {
    const loc=new URL(location.href), explicit=loc.searchParams.get('shop');
    try {lastGroup=localStorage.getItem(lastKey)||'';}catch{/* Opening a direct group link needs no local storage. */}
    id=explicit||''; role=explicit?(tabIds.includes(loc.hash.slice(1))?loc.hash.slice(1):'buyer'):'leader';
    document.addEventListener('click',e=>{
      const tab=e.target.closest('#journey-tabs [data-role]');if(tab){setRole(tab.dataset.role);return;}
      const b=e.target.closest('[data-action]');if(b&&!b.disabled)handle(b);
    });
    document.addEventListener('change',e=>{const n=e.target;if(sheet==='respond'&&n.dataset.skuToggle){captureRecipient();quantities[n.dataset.skuToggle]=n.checked?1:0;fillModal();}else if(sheet==='accept'&&n.dataset.decision)decisionCount();else if(sheet==='distribute'&&n.name==='distribute-order')updateDispatch();});
    document.addEventListener('input',e=>{if(sheet==='accept'&&e.target.dataset.capacity)decisionCount();if(sheet==='pay'&&e.target.dataset.paySku){payRequestId=crypto.randomUUID();updatePaymentForm();}if(sheet==='distribute'&&e.target.id==='dispatch-search')updateDispatch();});
    byId('journey-tabs').addEventListener('keydown',e=>{
      const tab=e.target.closest('[data-role]');if(!tab)return;
      const i=tabIds.indexOf(tab.dataset.role), n={ArrowLeft:(i+2)%3,ArrowRight:(i+1)%3,Home:0,End:2}[e.key];
      if(n!==undefined){e.preventDefault();setRole(tabIds[n],true);}
    });
    byId('detail').addEventListener('close',()=>{if(!byId('detail').open)sheet='';});
    window.addEventListener('hashchange',()=>setRole(location.hash.slice(1)));
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poll();});
    render();if(id)void write('read');setInterval(poll,1800);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
