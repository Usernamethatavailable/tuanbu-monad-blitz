# 团簿

团簿服务于棉花娃娃等实物定制拼团。团长发起需求，工厂确认阶梯报价，拼友按款报名并向工厂商户预付。付款截止按全团实付件数计价。达到低价档的订单按原渠道退差，拼友签收后按订单结算工厂货款和团长服务费。

工厂报价、接单、退款和分账等产生可分享的单据。应用把公开单据的 SHA-256 摘要登记到 Monad 测试网合约。浏览器可以通过公开 RPC 重新核对摘要和链上事件。人民币支付、退款和物流为演示数据。

## 运行

```shell
python -m pip install -r requirements-chain.txt
python 原型/preview_server.py --port 8425
```

打开 `http://127.0.0.1:8425/shop.html`。在建团浏览器里切换团长和工厂，也可用另一个浏览器以拼友身份报名。使用本地存证时，启动监听 `127.0.0.1:18545`、链 ID 为 `31337` 的 Anvil。Monad 测试网配置见 [合约部署说明](contracts/README.md)。完整应用、公网 HTTPS 和持久化配置见 [工程说明](ENGINEERING.md)。

## 测试

```shell
python -B -m unittest discover -s 原型 -p 'test_*.py'
node --test 原型/test_ledger.cjs
forge test --contracts contracts --match-path 'contracts/ReceiptRegistry.t.sol' --use 0.8.30 --evm-version cancun
```
