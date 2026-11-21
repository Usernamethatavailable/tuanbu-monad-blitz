# 团簿单据存证合约

`ReceiptRegistry` 只接受部署时指定的发布账户调用 `anchor(bytes32)`，成功时产生 `Anchored` 事件。投给合约的是公开单据规范 JSON 的 SHA-256 摘要。用户可用保存的单据通过公开 RPC 或区块浏览器核对摘要、交易发送方与合约事件。人民币回执来自应用内的模拟支付服务。

## 部署到 Monad 测试网

准备两份测试网地址。部署地址可由 Foundry 加密签名库管理。发布地址由网站后台使用，保留测试 MON 并独占该地址的交易 nonce。发布地址的私钥只填入部署平台的服务端密钥。测试网登记每笔交易最多申请 50,000 gas，价格上限为 500 gwei，单笔费用上限为 0.025 测试 MON。网络实际价格以交易回执为准。

在仓库根目录执行。以下使用 PowerShell 和 Foundry。Solidity 编译器固定为 0.8.30。

```powershell
$chainRpc = 'https://testnet-rpc.monad.xyz'
cast chain-id --rpc-url $chainRpc
# 上一步应输出 10143。运行前通过环境变量设置发布账户的公开地址。
$publisherAddress = $env:TUANBU_PUBLISHER_ADDRESS
forge test --contracts contracts --match-path 'contracts/ReceiptRegistry.t.sol' --use 0.8.30 --evm-version cancun
forge build contracts/ReceiptRegistry.sol --use 0.8.30 --evm-version cancun
forge create contracts/ReceiptRegistry.sol:ReceiptRegistry --use 0.8.30 --evm-version cancun --rpc-url $chainRpc --account tuanbu-testnet --broadcast --constructor-args $publisherAddress
cast call $env:TUANBU_MONAD_CONTRACT 'publisher()(address)' --rpc-url $chainRpc
```

`tuanbu-testnet` 是本地的 Foundry 部署账户名称。执行最后一行前把部署所得地址存入 `TUANBU_MONAD_CONTRACT`。核对返回地址等于发布账户公开地址，再配置服务。服务器通过下列变量读取设置：

- `TUANBU_MONAD_CONTRACT` 已部署合约地址。
- `TUANBU_MONAD_PRIVATE_KEY` 专用于这个演示实例的测试网发布账户私钥。
- `TUANBU_MONAD_RPC_URL` 可选的服务端 HTTPS RPC，默认使用官方测试网 RPC。
- `TUANBU_MONAD_PUBLIC_RPC_URL` 可选的浏览器 HTTPS RPC，须支持跨域访问，默认使用官方测试网 RPC。

服务只签 Monad 测试网的交易，并把已签名交易和哈希持久化后再发往节点。网络中断时继续查询或重发相同交易。确认交易成功及存在匹配的合约事件后，凭证才标记为已写入。旧本地凭证与每个链及合约的记录分开保存。发布账户不可更换，替换发布账户需要部署新合约。

网络配置见 [Monad 测试网资料](https://github.com/monad-developers/workshop-clob)。部署命令见 [Foundry forge create](https://getfoundry.sh/forge/reference/create/)。
