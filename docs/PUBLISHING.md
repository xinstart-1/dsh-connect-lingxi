# 发布前检查

打包发布之前跑这一条，它检查的是「发出去会不会立刻坏」的那几件事：

```bash
node scripts/prepublish-check.mjs
```

## 检查项与理由

| 检查 | 为什么 |
| --- | --- |
| `package.json` 的 `version` 是三位且与 `src/constants.ts` 的 `VERSION` 一致 | 卡片上显示的版本就是 `VERSION`；两处不一致时用户报的版本号是错的，排查会从第一步就跑偏 |
| `lib/index.js`、`lib/client.js` 都存在且非空 | `exports['./client']` 指向 `lib/client.js`。它缺失时宿主只表现为「插件没有界面」，没有任何报错 |
| `lib/client.js` 里有 `__ModuleLoader__.load` 与 `id` | 这是浏览器半侧的入口契约；少了它文件存在也不会被加载 |
| `lib/client.js` 里**没有** `import ` / `export ` 语句 | 它必须是经典脚本；一旦被当成 ESM 处理就会静默失效 |
| `lib/index.js` 里出现两条路由路径 | 卡片与胶囊的数据都来自这两条路由，缺一条就是半张空白页 |
| `files` 白名单包含 `lib` 与 `cordis.patch.yml` | npm 只发白名单里的东西；漏了 `lib` 会发出一个只有 README 的包 |
| `cordis.patch.yml` 里的 row `name` 等于包名 | client-modules 的 node 半侧用 `require.resolve('<row-name>/package.json')` 找包，不等就找不到 |
| README 与 LICENSE 存在 | npm 页面与许可声明 |

## 为什么不用 `prepublishOnly` 跑全部测试

单测跑的是 `src/`（Node 直接 strip types），不是 `lib/`。把它挂在 publish 前会给人
「已经验证过产物」的错觉——真正需要钉住的是**产物形状**，也就是上面这些项。
