(() => {
  'use strict';
  const dialog = document.getElementById('proof-panel');
  const title = document.getElementById('proof-title');
  const body = document.getElementById('proof-body');
  const get = () => window.tuanbuShopSnapshot?.();
  const date = n => new Date(n * 1000).toLocaleString('zh-CN', {hour12:false});
  let selected = null, view = 'all', lastView = '', attempt = 0;
  let sharedProof = new URL(location.href).searchParams.get('proof');
  const amount = n => '¥' + new Intl.NumberFormat('zh-CN').format(n);
  function movement(r) {
    const a = r.amounts || {};
    if (!r.role.includes('支付'))return null;
    if(a.prepaid>0)return {label:'拼友 → 工厂商户冻结余额', sum:a.prepaid, prepaid:a.prepaid};
    if(a.refunded>0)return {label:'冻结余额 → 拼友原支付账户', sum:a.refunded, refunded:a.refunded};
    if(a.factoryPaid>0 || a.leaderPaid>0)return {label:'冻结余额 → 工厂及团长', sum:(a.factoryPaid||0)+(a.leaderPaid||0),factoryPaid:a.factoryPaid||0,leaderPaid:a.leaderPaid||0};
    return null;
  }
  function breakdown(r){
    const flow=movement(r), output=[];
    if(flow){
      output.push(pair('款项流向',flow.label),pair('本次金额',amount(flow.sum)));
      if(flow.factoryPaid!==undefined)output.push(pair('其中工厂货款',amount(flow.factoryPaid)),pair('其中团长服务费',amount(flow.leaderPaid)));
    }
    if(r.orderId)output.push(pair('关联订单',r.orderId));
    if(r.action==='quote'){
      const q=r.data;
      output.push(pair('工厂报价',q.minimum+'–'+(q.discountThreshold-1)+' 个，每个 '+amount(q.goodsPrepay)),
        pair('满 '+q.discountThreshold+' 个',amount(q.discountPrice)+' / 个'),
        pair('团长服务费',amount(q.leaderFeePerItem)+' / 个'),pair('发货约定','付款截止后 '+q.shipWithinDays+' 天内'));
    }
    const orders=r.data?.orders;
    if(flow && orders?.length){
      const details=node('details');details.append(node('summary','涉及 '+orders.length+' 笔订单'));
      for(const o of orders){
        const a=o.amounts || {};
        const cash=a.prepaid??a.refunded??((a.factoryPaid!=null||a.leaderPaid!=null)?(a.factoryPaid||0)+(a.leaderPaid||0):null);
        details.append(pair(o.orderId, o.quantity+' 个'+(cash!=null?' · '+amount(cash):'')));
      }
      output.push(details);
    }
    return output;
  }

  function node(tag, text, cls) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  }
  function button(label, cb) {
    const b = node('button', label, 'quiet-link');
    b.type = 'button'; b.addEventListener('click', cb); return b;
  }
  function pair(label, value) {
    const row = node('p', undefined, 'sheet-row');
    row.append(node('span',label),node('strong',String(value))); return row;
  }
  function canonical(o) {
    if (Array.isArray(o)) return '[' + o.map(canonical).join(',') + ']';
    if (o !== null && typeof o === 'object') return '{' + Object.keys(o).sort()
      .map(k => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
    return JSON.stringify(o);
  }
  async function rpc(url, method, params) {
    const res = await fetch(url, {method:'POST', credentials:'omit', referrerPolicy:'no-referrer',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({jsonrpc:'2.0', id:1, method, params}), signal:AbortSignal.timeout(5000)});
    if (!res.ok) throw Error();
    const data = await res.json();
    if (data.error) throw Error();
    return data.result;
  }
  function save(record, network) {
    const {name, chainId, rpc, address, marker, topic, publisher, explorer} = network;
    const blob = new Blob([JSON.stringify({record:record.public, sha256:record.digest,
      network:{name, chainId, rpc, address, marker, topic, publisher, explorer},
      transaction:record.tx, block:record.block, blockHash:record.blockHash,
      submittedBy:record.submittedBy, chainStatus:record.chainStatus},null,2)], {type:'application/json'});
    const url = URL.createObjectURL(blob), a = node('a');
    a.href=url; a.download=record.id+'.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),2000);
  }
  const sameHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  const contractProof = network => network.chainId === 10143 || 'topic' in network || 'publisher' in network;
  function matchesContract(network, receipt, record, digest) {
    return sameHex(record.submittedBy, network.publisher) && Array.isArray(receipt.logs) &&
      receipt.logs.some(log => !log.removed && sameHex(log.address, network.address) && log.data === '0x' &&
        Array.isArray(log.topics) && log.topics.length === 2 && sameHex(log.topics[0], network.topic) &&
        sameHex(log.topics[1], '0x' + digest));
  }
  async function verify(record, network, output) {
    const token = ++attempt;
    output.textContent='正在从链节点读取原始交易…';
    try {
      const bytes = new TextEncoder().encode(canonical(record.public));
      const hashed = await crypto.subtle.digest('SHA-256',bytes);
      const digest = [...new Uint8Array(hashed)].map(x=>x.toString(16).padStart(2,'0')).join('');
      const [chain, tx, receipt] = await Promise.all([
        rpc(network.rpc,'eth_chainId',[]), rpc(network.rpc,'eth_getTransactionByHash',[record.tx]),
        rpc(network.rpc,'eth_getTransactionReceipt',[record.tx])]);
      const isContract = contractProof(network);
      const ok = Number(chain) === network.chainId && digest === record.digest && receipt?.status === '0x1' &&
        sameHex(tx?.input, network.marker + digest) && sameHex(tx?.to, network.address) &&
        sameHex(tx?.from, record.submittedBy) && sameHex(tx?.hash, record.tx) &&
        sameHex(receipt.transactionHash, tx.hash) && sameHex(tx.blockHash, receipt.blockHash) &&
        sameHex(receipt.blockHash, record.blockHash) && Number(receipt.blockNumber) === record.block &&
        Number(tx.blockNumber) === record.block && (!isContract || matchesContract(network, receipt, record, digest));
      if(token===attempt) output.textContent=ok ? '核对通过。单据摘要与链上交易一致。' : '核对未通过。单据或交易与记录不一致。';
    } catch {
      if(token===attempt) output.textContent='暂时无法连接链节点，请稍后重试。';
    }
  }
  function explorerLink(network, hash) {
    if (!/^0x[0-9a-f]{64}$/i.test(hash || '') || !network.explorer) return null;
    let url;
    try { url = new URL(network.explorer); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.pathname = url.pathname.replace(/\/$/, '') + '/tx/' + hash;
    url.search = '';
    url.hash = '';
    const link = node('a','在区块浏览器查看交易','quiet-link');
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }
  async function copyProof(record, groupId, output) {
    const url = new URL('/shop.html', location.href);
    url.searchParams.set('shop', groupId);
    url.searchParams.set('proof', record.id);
    url.hash = 'buyer';
    try {
      await navigator.clipboard.writeText(url.href);
      output.textContent = '单据链接已复制。';
    } catch {
      const input = node('input');
      input.readOnly = true;
      input.setAttribute('aria-label','单据链接');
      input.value = url.href;
      output.replaceChildren(input);
      input.focus();
      input.select();
    }
  }
  const stages = [
    ['开团与报价', ['propose','quote','publish'], ['quote','publish']],
    ['报名与接单', ['respond','respond-seed','submit-production','accept'], ['accept','submit-production','respond']],
    ['付款与定价', ['pay','pay-seed','close-pay','discount-refund','failed-refund'], ['close-pay','discount-refund','failed-refund','pay']],
    ['生产与交付', ['start','ship','batch-arrived','receive-batch','distribute'], ['ship','receive-batch','distribute']],
    ['签收、售后与结算', [], ['dispute-refund','batch-refund-paid','settle','receive','settle-seed']]
  ];
  function stageDescription(index, state, records) {
    if(!records.length)return '尚无记录';
    if(index===0){
      const quote=records.find(r=>r.action==='quote')?.data;
      return quote ? quote.minimum+' 个起，每个 '+amount(quote.goodsPrepay)+'；满 '+quote.discountThreshold+' 个，每个 '+amount(quote.discountPrice) : '预计定制 '+state.targetCount+' 个';
    }
    if(index===1)return '报名 '+state.signupCount+' 个 · 工厂已接 '+state.acceptedCount+' 个';
    if(index===2){
      if(state.phase==='failed')return '未达到起做数量 · 已退 '+amount(state.totals.failureRefund);
      return '实付 '+state.paidCount+' 个'+(state.closedAt?' · 成交单价 '+amount(state.unit):' · 尚未截止');
    }
    if(index===3)return records[records.length-1].title+' · 已分发 '+state.distributedOrderCount+' 单';
    if(state.batchIssue?.status==='open')return '整箱异议处理中';
    return '已签收 '+state.receivedOrderCount+' 单 · 工厂已结 '+amount(state.totals.factoryPaid);
  }
  function renderStages(state, rows, expanded) {
    const network=state.ledger?.name || '本地 EVM 测试链';
    body.append(node('p','单据保存在团单中，摘要写入'+network+'。','sheet-note'));
    const groups=stages.map(()=>[]);
    for(const r of rows){
      const index=stages.findIndex(([,actions])=>actions.includes(r.action));
      groups[index<0?groups.length-1:index].push(r);
    }
    stages.forEach(([name,,preferred],index)=>{
      const records=groups[index], confirmed=records.filter(r=>r.chainStatus==='confirmed').length;
      const failed=records.filter(r=>r.chainStatus==='failed').length;
      const status=!records.length?'待发生':failed===records.length?'写入失败':failed?'部分写入失败':
        !confirmed?'待上链':confirmed===records.length?'已上链':'部分已上链';
      const group=node(records.length?'details':'div',undefined,'proof-stage');
      const header=node(records.length?'summary':'div',undefined,'proof-heading');
      header.append(node('strong',name),node('span',status,'proof-status'));
      if(records.length)header.append(node('span',stageDescription(index,state,records),'proof-caption'));
      group.append(header);
      if(records.length){
        group.dataset.stage=String(index);
        group.open=expanded.has(String(index));
        const links=node('div',undefined,'proof-receipts');
        const latest=[...records].reverse();
        const representative=preferred.map(action=>latest.find(r=>r.action===action)).filter(Boolean);
        if(!representative.includes(latest[0]))representative.push(latest[0]);
        const mine=state.mine?.id && latest.find(r=>r.orderId===state.mine.id);
        const visible=[...new Set([...(mine?[mine]:[]),...representative])].slice(0,3);
        for(const r of visible)links.append(button(r.title.replace('预置拼友模拟','拼友'),()=>{selected=r.id;show();}));
        group.append(links);
      }
      body.append(group);
    });
    const terms=node('button','查看团单明细','quiet-link');
    terms.type='button';terms.dataset.action='terms';
    terms.addEventListener('click',()=>dialog.close());
    body.append(terms);
  }
  function renderFunds(state, rows) {
    const t=state.totals;
    body.append(pair('工厂商户账户 · 冻结中', amount(t.held)),pair('拼友累计支付', amount(t.prepaid)),
      pair('已退回拼友原账户',amount(t.refunded)),pair('工厂已收货款',amount(t.factoryPaid)),
      pair('团长已收服务费',amount(t.leaderPaid)));
    const totals={prepaid:0,refunded:0,factoryPaid:0,leaderPaid:0};
    for(const r of rows){
      const flow=movement(r);
      if(flow)for(const key of Object.keys(totals))totals[key]+=flow[key]||0;
    }
    const held=totals.prepaid-totals.refunded-totals.factoryPaid-totals.leaderPaid;
    const match=held===t.held && Object.keys(totals).every(key=>totals[key]===t[key]);
    const note=!t.prepaid?'尚无收付款。':match?'收付回执与上述金额一致。':'收付回执与上述金额有差异。';
    body.append(node('p',note+'金额来自模拟支付渠道。','sheet-note'));
  }
  function show(state = get()) {
    if(!state) return;
    const rows=state.events || [], record=rows.find(r=>r.id===selected), network=state.ledger;
    const signature=state.id+'|'+view+'|'+(selected||'')+'|'+(record?record.chainStatus+record.tx:rows.map(e=>e.id+e.chainStatus).join(','));
    if(lastView===signature && dialog.open)return;
    const expanded=new Set([...body.querySelectorAll('details[data-stage][open]')].map(el=>el.dataset.stage));
    lastView=signature; attempt++; body.replaceChildren(); title.textContent=record?'单据凭证':view==='flows'?'当前资金情况':'全过程记录';
    if(record){
      const isContract = contractProof(network), confirmed = record.chainStatus === 'confirmed';
      const status = confirmed ? '已写入' : record.chainStatus === 'failed' ? '写入失败' : '待写入';
      const saveButton = button('保存单据',()=>save(record,network));
      body.append(button('返回记录',()=>{selected=null;show();}),node('h3',record.title),pair('确认方',record.role),
        pair('时间',date(record.at)),pair('网络',network.name),pair('状态',status));
      if (isContract) body.append(pair('链上提交方','团簿应用账户'));
      body.append(...breakdown(record));
      const fields=node('details'), summary=node('summary','单据原文与摘要');
      fields.append(summary,node('pre',JSON.stringify(record.public,null,2)),node('code','SHA-256  '+record.digest)); body.append(fields);
      if(confirmed){
        const tx=node('p');tx.append(node('small','交易哈希'),node('br'),node('code',record.tx));
        const result=node('p',undefined,'sheet-note');result.setAttribute('role','status');
        body.append(pair('区块',record.block),tx,button('独立核验',()=>void verify(record,network,result)),result);
        if (isContract) {
          const actions = node('div',undefined,'role-toolbar');
          const link = explorerLink(network, record.tx);
          const shareStatus = node('p',undefined,'sheet-note');
          shareStatus.setAttribute('role','status');
          if (link) actions.append(link);
          actions.append(button('复制单据链接',()=>copyProof(record,state.id,shareStatus)),saveButton);
          body.append(actions,shareStatus);
        }
      }
      if (!isContract || !confirmed) body.append(saveButton);
    } else if(view==='flows')renderFunds(state,rows);
    else renderStages(state,rows,expanded);
    if(!dialog.open)dialog.showModal();
  }
  document.addEventListener('click',e=>{
    const source=e.target.closest('[data-action="ledger"]');
    if(source){selected=source.dataset.eventId || null;view=source.dataset.ledgerView||'all';lastView='';show();}
  });
  document.getElementById('proof-close').addEventListener('click',()=>dialog.close());
  document.addEventListener('shop:update',()=>{
    if (!sharedProof && !dialog.open) return;
    const state = get();
    if (sharedProof && state?.events.some(record => record.id === sharedProof)) {
      selected = sharedProof;
      sharedProof = null;
      view = 'all';
      show(state);
    } else if(dialog.open)show(state);
  });
  dialog.addEventListener('close',()=>{selected=null;lastView='';attempt++;});
})();
