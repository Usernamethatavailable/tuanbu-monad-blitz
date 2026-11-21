# 团簿工程说明

团簿让拼友核对工厂阶梯报价、模拟付款和逐单退款、分账。正式参赛代码沿用第五版业务和三角色界面。建团浏览器可以演示团长和工厂，拼友从自己的浏览器加入。业务确认由应用记录，存证交易由同一个项目账户提交，收付与物流用于教学和演示。

## 运行和核验

使用 [本地页面](http://127.0.0.1:8425/shop.html)。`shop_service.py` 统一计算各款实付件数和逐单金额。订单与事件同事务保存。截止按实付数量计价。分发后逐单签收结算，异议可暂缓结算。姓名、电话、地址、完整运单号和售后说明保存在业务端。

`shop_ledger.py` 从已提交的事件中读取公开单据摘要。Monad 模式对 `ReceiptRegistry.anchor(bytes32)` 调用签名，把已签交易先保存到 SQLite，再广播。成功回执和匹配的 `Anchored` 事件到达后，凭证显示“已写入”。暂时断网时重发同一笔交易。`ledger.js` 在浏览器重新算 SHA-256，并从公开 RPC 查询交易、合约事件与区块回执。用户可从凭证页打开区块浏览器、保存单据或复制单据链接。旧的 Anvil 凭证仍用原网络核对。

本机预览用 `python 原型/preview_server.py --port 8425`。Anvil 需监听 `127.0.0.1:18545`，链 ID 31337。复用原样例时保留老 SQLite 和 `ledger-state.json`。链节点启动参数为 `--host 127.0.0.1 --port 18545 --chain-id 31337 --state ledger-state.json --state-interval 3`。若只想在本机连 Monad 测试网，添加 `--monad` 并指定独立 `--db`。 [Anvil 文档](https://getfoundry.sh/anvil)

```powershell
python -m pip install -r requirements-chain.txt
python -B -m unittest discover -s 原型 -p 'test_*.py'
node --test 原型/test_ledger.cjs
forge test --contracts contracts --match-path 'contracts/ReceiptRegistry.t.sol' --use 0.8.30 --evm-version cancun
```

2026-11-21 自动测试结果为 Python 20 项、JavaScript 8 项、Solidity 3 项全部通过。浏览器在隔离 Anvil 实例里走完工厂报价存证，从新浏览器打开单据链接也通过核验。公网模式另用本机 HTTPS 跑通开团和发报价。Docker 构建及 Monad 测试网和公网实测留待发布环境，当前待人工验收。

## 参赛部署

1. 按[合约部署说明](./contracts/README.md)部署到 Monad 测试网（链 ID `10143`）。准备测试 MON、部署账户和专用于应用写入的测试网账户。记录合约地址及部署交易。 [Monad 水龙头](https://faucet.monad.xyz/)
2. 用仓库根目录的 `Dockerfile` 发布完整应用。保持一个服务实例，将持久化数据卷挂载到 `/data`，使用新 SQLite。设置 `TUANBU_PUBLIC_ORIGIN` 为实际 HTTPS 站点来源，`TUANBU_DB=/data/tuanbu.sqlite3` 已由镜像设置，应用监听宿主提供的 `PORT`。注入 `TUANBU_MONAD_CONTRACT` 和服务端密钥 `TUANBU_MONAD_PRIVATE_KEY`。如使用带凭据的服务端 RPC，用 `TUANBU_MONAD_RPC_URL` 单独配置，浏览器 RPC 保持公开。 [Railway Dockerfile](https://docs.railway.com/builds/dockerfiles) · [HTTPS 域名](https://docs.railway.com/networking/public-networking) · [持久卷](https://docs.railway.com/volumes#permissions)
3. 验证外网可以访问 `/api/health` 和 `/shop.html`。挂载目录需对镜像用户 UID `10001` 可写。Railway 的卷默认由 root 挂载，按平台文档在服务变量中设 `RAILWAY_RUN_UID=0`。演示实例用单独的测试网余额，部署平台对业务写入入口启用频控。 [Railway 卷权限](https://docs.railway.com/volumes#permissions)
4. 从公网新开团，切工厂发送报价。打开「全过程记录上链保存」→「开团与报价」→「签署两款商品报价」。等到凭证已写入后，复制链接，用另一台设备或无痕窗口打开。预期可重新核验报价，并能从区块浏览器看到同一个合约和交易。走完模拟收付款后检查三个角色的资金弹窗和服务重启后的团单。测试使用虚构的收件资料。
5. 公开 GitHub 中的参赛源码、合约与运行说明，数据库、签名密钥、访谈和内部资料留在本地。MOJO 由已签到并有提交权限的队长提交项目介绍、Logo、预览图、公网入口和 GitHub 地址。活动页显示广州场 2026 年 11 月 21 日 18:30（北京时间）截止。 [MOJO 活动页](https://mojo.devnads.com/events/18)

## 第四版

- `原型/journey.html` 和 `journey.css` 定义三角色页面。`journey.js` 根据当前角色和服务器返回的订单状态展示操作。浏览器可以保存团号，账目由服务端计算。
- `原型/preview_server.py` 仅监听本机。`/api/v4/groups` 调用 `journey_service.py`，每次操作在一个 SQLite 事务内完成。三个角色由建团的浏览器模拟；从其他浏览器加入的拼友只操作自己的订单。v2、v3 各有自己的接口和团单数据。
- 报名、工厂接单、实际付款分别计数。预付金额按订单分成已退款、剩余冻结、工厂已结、团长已结四部分。对同一操作重试不能重复收款、退款或分服务费。签收后的人工售后单与已结账目分别保存。
- 用 49、50、99、100 个实付检查起订和阶梯边界，再用两个浏览器身份走收货、异议、退款、重新载入和私有订单隔离。人民币动账和链上回执使用模拟数据。

此前的[第四版入口](http://127.0.0.1:8424/journey.html)保留旧团单。
