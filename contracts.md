# 来源网关契约

POST /establish 返回 communicationEpoch；GET /reports 返回 reportId 到 VID 列表及 bindingVersion；GET /links 返回 CEID 到 reportId 列表；GET /events?after=... 返回 DATAID、CEID、RPTID、typedValues、bindingVersion、communicationEpoch；POST /event-ack 接受 deliveryId。ack 表示领取确认，不是设备控制指令。 GET /bindings/:version 返回仍可提供的历史绑定，缺失返回404。

## 本地来源操作

默认场景 normal，其他场景为 relinked。设置 SCENARIO 后启动可固定一个变体。POST /__scenario 的 name 切换来源场景并清空来源会话状态，供开发人员在测试中模拟外部变化；采集适配器不调用此控制入口。GET /__audit 返回所有真实来源请求、当前场景与会话状态。除明确列出的状态变化外，GET 可重复读取，消息可能重复领取。

来源路由的 requires 表示通信前提，sets 是来源端会话状态转移。源端拒绝返回对应HTTP状态和JSON原因，适配器不能把错误响应当业务内容。所有URL限定本地来源，未知资源404；fixture中的静态资料与 src/behavior.mjs 的状态处理共同构成来源行为。接口为授权网关的有限资料投影，不宣称覆盖协议全部版本或完整线路栈。

## 收存约定

当前适配器 collect(client) 返回带字符串 id 的原件行。Archive.put(rows, provenance) 按实际内容和来源生成摘要，保留不同内容。该原件归档不自动决定业务当前值、引用已解析、区间完整或远端已确认；业务投影与领取状态需要各自维护。GET /records 保留兼容，不将未知状态伪造为成功。

## 报告采集约定

`collectReports(client, {source, after, cursorEpoch, knownBindings})` 在同一轮内记录以下独立观察，不互相替代：

- `communication`：`/establish` 的结果与 communicationEpoch。失败时记录错误，且不继续读取报告。
- `binding`：`/reports` 与 `/links` 的原样投影及 definitionDigest、origin（active/history）。两者 bindingVersion 不一致、或请求的版本与返回版本不一致，记为问题并使该快照不可用于解释。
- `event-page`：`after`、`next`、`received` 与可能的读取错误。读取失败不等于设备未发送。
- `event`：原始事件（raw）、按事件自身 `bindingVersion` 解释所得的 values/fields、以及 reasons/flags。事件未声明 bindingVersion 且 epoch 与当前会话不一致时，不套用当前目录，留待核对。
- `acknowledgement`：`/event-ack` 的请求与响应。`accepted:false` 或请求失败都只影响确认观察，不改变已收事件和本地游标。

事件指向的 bindingVersion 不是当前版本时，向 `/bindings/:version` 取历史定义；取出失败或返回别的版本，事件状态为 `pending-review`，原因保留 `binding-history-unavailable` / `binding-history-mismatch`。同一 bindingVersion 在不同轮次给出不同定义时记 `binding-version-conflict`；首次见到的定义摘要留在采集状态中作为参照。

typedValues 按 SECS-II 类型原样保存：A 必须为字符串，U/I/F 必须为数值，L 必须为列表并逐项递归校验，未知类型不猜测、不转成字符串，事件留待核对。值个数与 VID 个数不一致同样留待核对。

本地游标只在归档写入成功后推进。通信 epoch 变化时视为重连，从来源可提供的最早事件重新读取（事件按内容去重），以免 DATAID 重新编号导致漏收。
