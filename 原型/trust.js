(() => {
  const container = document.getElementById('trust-summary');
  let previous = '';
  const formatter = new Intl.NumberFormat('zh-CN');
  const yuan = x => '¥' + formatter.format(x);
  function element(tag, text, cls) {
    const result = document.createElement(tag);
    if(text != null)result.textContent = text;
    if(cls)result.className = cls;
    return result;
  }
  function link(text, action, eventId, view) {
    const b = element('button', text, 'quiet-link');
    b.type='button'; b.dataset.action=action;
    if(eventId)b.dataset.eventId=eventId;
    if(view)b.dataset.ledgerView=view;
    return b;
  }
  function render() {
    const s = window.tuanbuShopSnapshot?.();
    if(!container || !s)return;
    const t=s.totals, quote=s.events.find(r=>r.action==='quote');
    const confirmed=s.events.filter(e=>e.chainStatus==='confirmed').length;
    const version=[s.id,t.prepaid,t.held,t.factoryPaid,t.leaderPaid,t.refunded,quote?.id,confirmed,s.events.length].join('/');
    if(version===previous)return;
    previous=version;
    const header=element('h2','全团资金去向','trust-title');
    const balance=element('div',null,'trust-balance');
    balance.append(element('span','工厂微信商户 · 冻结余额'),element('strong',yuan(t.held)));
    const lines=element('dl',null,'trust-lines');
    for(const [title,value] of [['拼友累计支付',t.prepaid],['已原路退给拼友',t.refunded],['已结给工厂的商品款',t.factoryPaid],['已结给团长的服务费',t.leaderPaid]]){
      const item=element('div');item.append(element('dt',title),element('dd',yuan(value)));lines.append(item);
    }
    const links=element('div',null,'trust-links');
    if(quote)links.append(link('工厂原报价','ledger',quote.id));
    else links.append(element('span','工厂待报价','trust-note'));
    links.append(link('逐笔资金流水','ledger',null,'flows'),link('全部存证 '+confirmed+'/'+s.events.length,'ledger'));
    const account=element('p','货款直付工厂商户，团长只收服务费。金额为测试支付回执。','trust-note');
    container.replaceChildren(header,balance,lines,account,links);
  }
  document.addEventListener('shop:update',render);
  render();
})();
