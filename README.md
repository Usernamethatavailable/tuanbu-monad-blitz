# 团簿 · 棉花娃娃拼团

团簿让拼友能自己查清三件事：工厂当初报了什么价、满额后自己该退多少钱、签收后工厂和团长各收了多少。团长负责组团和分货，货款直接记入工厂商户的冻结余额。项目参加 Monad Blitz 广州站，人民币收付和物流使用模拟数据，单据摘要实际写入 Monad 测试网。

**[打开公网演示 · 团长视角](https://syracuse-white-programmes-feedback.trycloudflare.com/shop.html?shop=6599d2a42320&proof=3ea27d853a03-00002#leader)　｜　[直接核验一笔已上链的工厂报价](https://syracuse-white-programmes-feedback.trycloudflare.com/shop.html?shop=3ea27d853a03&proof=3ea27d853a03-00002#leader)　｜　[从头发起一团](https://syracuse-white-programmes-feedback.trycloudflare.com/shop.html)**

## 一分钟看懂演示

1. 打开上面的**工厂报价凭证**，查看原始阶梯价和交期，点「独立核验」。浏览器会重新计算这张单据的摘要，再向公开节点读取交易和合约事件。也可直接看[这笔报价交易](https://testnet.monadscan.com/tx/0xb3462362caf901c923e0396679aaa037e64e1f36b757c43736de759ef29228e0)。
2. 关闭凭证，在同一团底部点**「资金流向可追溯」**。这团实付 104 个，最初共付 **¥9,464**，退差 **¥2,288**。全部签收后，工厂实收 **¥6,864**，团长实收 **¥312**，冻结余额 **¥0**。本团 16 条单据均已取得测试网回执。[退差交易](https://testnet.monadscan.com/tx/0x3f5d26e78700578a6ba5dc18725bc80df05e3dc56a2afd2b278c593a4fa00b31) · [结算交易](https://testnet.monadscan.com/tx/0x85be7ea31985faf786a20765f0508731b8f9348ec790d9a4d55240a2e73595de)
3. 想亲自操作时，从首页点**「发起开团」**。在建团浏览器的顶部切换团长、工厂和拼友；也可把报名链接发到另一浏览器模拟新拼友。已有样例可直接查看，亲自走流程请使用新团。

## 一次拼团如何结算

| 环节 | 业务规则 |
| --- | --- |
| 报价、报名 | 团长发需求，工厂报价，团长接受后开放报名。50 个起做，50–99 个每个 ¥88，100 个起每个 ¥66；团长服务费另列 ¥3/个。约定付款截止后 15 天内发货。 |
| 工厂接单 | 工厂按款式决定能做多少。例如 7 个绒绒兔报名，只够做 4 个，按成功付款顺序锁定；余量不够时，拼友可调整数量再付款。 |
| 付款、退差 | 每个先付 ¥91。截止按**实际付款的娃娃个数**计价：不足 50 个全额退，50–99 个维持原价，满 100 个每个退 ¥22。 |
| 发货、异议 | 工厂发整箱，团长验货、分发。整箱到货后 48 小时内可提异议，暂停该批未结资金。团长与工厂双方确认后恢复交付或退款。 |
| 签收、分账 | 每位拼友确认收货，才结自己的订单。以满百价为例，剩下的 ¥69 中工厂收 ¥66，团长收 ¥3。个人订单有异议时暂缓该单结算。 |

## Monad 与支付各负责什么

- **存证。** 应用将工厂报价、接单、付款、退差、交付、签收等单据的公开字段生成 SHA-256 摘要，由项目账户调用 `ReceiptRegistry.anchor(bytes32)`。拼友无需钱包或代币，可以保存单据，在团簿之外核对合约的 `Anchored` 事件。链上回执可用来判断已登记的单据有无被改动；工厂是否实际交货仍需验收。姓名、电话、地址和完整运单号留在业务端。
- **资金。** 演示使用模拟人民币回执。真实支付方案依托微信支付「平台收付通」：工厂作为二级商户收款，标记分账的订单可冻结货款，平台再按订单发起退款、分账或解冻。实际接入需平台和工厂完成开通。[微信支付官方说明](https://pay.wechatpay.cn/doc/v3/partner/4012086891)
- **网络。** Monad Testnet，链 ID `10143`。合约地址为 `0x9a919f3F0767253618E4a969CeED5e98Ac73e296`。[区块浏览器中的合约](https://testnet.monadscan.com/address/0x9a919f3f0767253618e4a969ceed5e98ac73e296) · [部署交易](https://testnet.monadscan.com/tx/0xad2950990907e54d1d7ff0983cf105d9fa7558a2a13f2ef7ea3393d96484b512)

## 源码与运行

| 路径 | 内容 |
| --- | --- |
| [前端入口](原型/shop.html) · [角色交互](原型/shop.js) · [凭证核验](原型/ledger.js) | 原生 HTML、CSS 和 JavaScript，三个角色共用同一笔团单。 |
| [业务规则](原型/shop_service.py) · [HTTP 服务](原型/preview_server.py) | Python 与 SQLite，处理库存、计价、异议和逐单分账。 |
| [链上写入](原型/shop_ledger.py) · [Solidity 合约](contracts/ReceiptRegistry.sol) | 登记公开单据摘要、跟踪交易、校验事件。 |
| [部署配置](Dockerfile) · [工程说明](ENGINEERING.md) · [合约部署说明](contracts/README.md) | HTTPS 服务、持久化数据卷、测试网发布账户和 RPC 配置。 |

在仓库根目录，用 Python 3.12 运行本地应用：

```sh
python -m pip install -r requirements-chain.txt
python 原型/preview_server.py --port 8425
```

本机访问 `http://127.0.0.1:8425/shop.html`。要在本机生成可核验的存证，另开终端运行 `anvil --port 18545 --chain-id 31337`。要接入 Monad 测试网，按[合约说明](contracts/README.md)配置专用测试网签名账户，启动时加 `--monad` 并用 `--db` 指定独立数据库。公网演示使用临时 Cloudflare 隧道，隧道关闭后网页会离线，已登记的交易仍可通过上方区块浏览器链接查询。

## 测试

Python 测业务和写链服务，Node.js 测浏览器核验逻辑，Foundry 测存证合约。仓库已有测试记录为 **20 项 Python、8 项 JavaScript、3 项 Solidity** 通过。

```sh
python -B -m unittest discover -s 原型 -p 'test_*.py'
node --test 原型/test_ledger.cjs
forge test --contracts contracts --match-path 'contracts/ReceiptRegistry.t.sol' --use 0.8.30 --evm-version cancun
```
