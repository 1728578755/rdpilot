# 数据格式与版本策略

> 对应条目：R5 #427（交换 JSON 版本化）、R5 #428（JSON Schema 公开）。
> 事实来源：`src/main/import/exportService.ts`（`EXCHANGE_VERSION`）、
> `src/main/services/systemIntegrationService.ts`（设置导出）、
> `src/main/services/dataService.ts`（旧备份导出）、`src/shared/defaults.ts`（`SCHEMA_VERSION`）。
> 最后核对：2026-10-28。

## 0. 四种文件名，三个用途（先看这张表）

导出入口不止一处，文件名也因此有四种。**按用途分只有三种**，混用会让人以为文件可以互换。

| 用途 | 文件名 | 产生位置 | 能被 RDPilot 导入 | 状态 |
|---|---|---|---|---|
| **设置备份**（只有设置，没有连接） | `rdpilot-settings-<yyyymmdd>.json` | 设置 → 导出设置（`systemIntegrationService.exportSettings`） | 能（`kind: "settings"`） | 当前 |
| **连接完整备份** | `RDPilot-export-<yyyymmdd-hhmm>.json`（`kind: "backup"`） | `ExportConnectionsDialog`（`import/exportService.ts`） | 能（设置/模板/视图一并恢复） | **主路径** |
| 同上（历史命名） | `rdpilot-backup-<yyyymmdd>-v<schema>.json` | 设置页 / 右键菜单的 `data.exportConfig` | 能（同形状，恢复不看文件名） | **旧入口**，Batch 5 收敛到 `ExportConnectionsDialog` 后消失 |
| **连接交换**（交接文档） | `RDPilot-exchange-<yyyymmdd-hhmm>.json` / `.csv` / `.md` | 同对话框选"交换"（`kind: "exchange"`） | **不能**（单向导出） | 当前 |

两条约定：

1. **恢复不靠文件名模式匹配**——用户选文件，读里面的 `kind`/`schemaVersion` 判断，所以旧命名的备份随时能恢复。
2. 旧入口不是"另一个格式"，只是**换了文件名**的同形状文件；写文档/写脚本时以"用途"为准，不要以文件名判断能不能导入。

## 1. 两种 JSON 载体，两个用途

RDPilot 的 JSON **载体**有两种（设置备份是第三种、但字段与备份不同构，见上表）：

| | **备份 JSON**（`kind: "backup"`） | **交换 JSON**（`kind: "exchange"`） |
|---|---|---|
| 用途 | 机对机完整恢复 | 交接文档 / 第三方消费 |
| 内容 | 连接 + 分组 + 模板 + 保存视图 + **设置** | 连接 + 分组 |
| 密码 | 从不包含（`verify-import`、`verify-data` 断言） | 从不包含 |
| 字段集 | 与内部结构同构（displayMode、advanced、gateway…） | 只保留"换个人接手也需要"的最小集 |
| 版本键 | `schemaVersion` = `SCHEMA_VERSION`（数据版本） | `exchangeVersion` = `EXCHANGE_VERSION`（格式版本） |
| 能被 RDPilot 导入 | 能（设置、模板、视图一并恢复） | **不能**（导出是单向的） |
| 文件名 | `RDPilot-export-<yyyymmdd-hhmm>.json` | `RDPilot-exchange-<yyyymmdd-hhmm>.json`（CSV/Markdown 同前缀） |
| 其他视图 | 只有 JSON | 另有 CSV / Markdown（人读，不进本 schema） |

两个文件用 `kind` 判别；缺 `kind` 的老文件按设置/备份处理（向后兼容）。

## 2. 版本策略

### 2.1 两套版本号，互不影响

- `SCHEMA_VERSION`（当前 **1**）：`data.json` 与备份 JSON 的**内部数据版本**，键名 `schemaVersion`。
  它一变，意味着内部结构变了；旧版应用读到更高的 `schemaVersion` 会**另存备份后进只读模式**，
  绝不把高版本数据静默改写成低版本结构。
- `EXCHANGE_VERSION`（当前 **1**）：**对外交换格式**的版本，键名 `exchangeVersion`。
  它只承诺"文件里的字段含义"，与内部结构解耦——内部加字段不会自动让交换格式升版。

为什么必须用两个不同的键：内部结构为性能/迁移随时会动，而第三方一旦依赖了交换格式，
每次内部重构都改对外版本号，等于让所有消费方跟着改。分开之后：
**内部随便动，对外只在"字段增删或语义变化"时升版。**
用不同**键名**而不是同名不同义，是为了让消费方一眼看出自己读的是哪套版本。

### 2.2 什么时候升 `EXCHANGE_VERSION`

| 变更 | 是否升版 | 说明 |
|---|---|---|
| 新增**可选**字段 | 否（当前版本仍可解析） | 消费方必须忽略未知字段（`additionalProperties: true`） |
| 新增**必填**字段 / 删除字段 / 改字段类型 / 改枚举取值 | **是** | 老消费方会解析失败或读错 |
| 改字段语义（例如 `port` 从"可为空"变成"必填"） | **是** | 语义变化比结构变化更隐蔽 |

### 2.3 消费方（第三方）应该怎么做

1. 先看 `kind`：不是 `"exchange"` 就当**另一种文件**处理，不要按本 schema 解析；
2. 再看 `exchangeVersion`：
   - **等于**你支持的版本 → 正常解析；
   - **高于**你支持的版本 → **拒绝并提示升级**，不要"尽力解析"（缺字段会让你写进脏数据）；
   - **低于** → 按你手里的历史规则兼容；
3. 忽略所有未知字段（本 schema 显式 `additionalProperties: true`）；
4. 不要把 `groupName` 当唯一键：它只在同一份文件内有意义；
5. 不要假设 `counts` 与数组长度一定一致（它是摘要，用于快速预览）；以数组为准。

## 3. 用 JSON Schema 校验

[`connections.schema.json`](connections.schema.json) 是 Draft-07，覆盖 **交换 JSON**。

```bash
# ajv-cli 5 默认就是 draft-07
npx ajv-cli@5 validate -s docs/schema/connections.schema.json -d RDPilot-exchange-20261028-2030.json
```

```js
// 编程方式（ajv 8）
import { readFileSync } from 'node:fs'
import Ajv from 'ajv'

const schema = JSON.parse(readFileSync('docs/schema/connections.schema.json', 'utf8'))
const doc = JSON.parse(readFileSync('RDPilot-exchange-20261028-2030.json', 'utf8'))
const ajv = new Ajv({ allErrors: true, strict: false })
if (!ajv.validate(schema, doc)) console.error(ajv.errors)
```

仓库内不额外引入 `ajv` 依赖：`scripts/verify-docs.mjs` 只用 Node 自带能力做**结构级**比对
（必填键、类型、枚举、版本号与代码常量一致），不追求完整 draft-07 语义。

## 4. 明确没做的事

- **交换 JSON 不能导入**。目前只有备份 JSON / `.rdp` / `.rdg` / CSV 可导入，
  交换格式是"给人接手"的出口。想做"导入交换格式"要先定义冲突策略（同名/同地址怎么办），
  这是产品决策，不是格式问题。
- **没有 schema 的向后兼容测试集**（fixtures）。目前只有 `verify-import` 对备份 JSON 的保真度断言，
  `verify-docs` 只比对"schema 字段集合 = 代码接口字段集合"。
