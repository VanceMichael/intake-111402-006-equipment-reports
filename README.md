# 产线事件与动态报告定义的联合采集

设备事件收存服务。已有状态轮询和类型值保留模块；本地网关用 JSON 表达 SECS 列表。

## 运行

Node.js 22.23.4，依赖仅为标准库，package-lock.json 不含网络依赖。无需安装数据库或访问外站。

```sh
npm test
npm run demo
npm start
```

demo 从空临时目录启动来源与查询服务，实际领取并打印收件结果后退出，通常不到 5 秒。持续运行时来源监听 4010，查询服务监听 4020；GET /records 返回已收原件，GET /health 检查服务。

```sh
docker build --network=none -t equipment-reports .
docker run --rm --network=none equipment-reports npm test
docker run --rm --network=none equipment-reports npm run demo
```

Dockerfile 固定 Node 镜像摘要。首次使用需预载该镜像，运行和测试不下载任何内容。现场演示可执行 npm run demo，在90秒内完成启动、实际收件与查询。

## 工程结构

- src/reader.mjs 是来源适配器：把网关的通信、报告定义、事件关联、事件与确认读成类型保真的观察值；不修改来源来迎合适配结果。
- src/intake.mjs 负责一次采集：建立通信 epoch → 读取报告/关联定义 → 拉取事件 → 逐条按事件自带的 bindingVersion 解释，无法确定的留待核对。
- src/source.mjs 与 src/behavior.mjs 实现本地来源网关，契约见 contracts.md。
- src/archive.mjs 保存来源与内容摘要；同内容重收不新增，内容变化保留版本。
- src/state.mjs 保存采集游标与已见绑定摘要；游标表示“已本地归档到此处”，与设备确认无关。
- src/api.mjs 提供收件查询与事件追踪；.state 为运行状态，停止后可删除恢复空收件箱。
- fixtures/source.json 是虚构来源资料和状态变化，不含真实账号、交易或个人数据。

环境变量 DATA_DIR、PORT、SOURCE_PORT、POLL_MS 控制目录、端口与轮询间隔；SCENARIO 选择本地来源资料版本。测试和演示自己创建空目录，不依赖上次执行遗留状态。

## 查询接口

- GET /records：全部归档原件（row/provenance/digest）。
- GET /records/find?kind=event&status=pending-review：按类别、状态或 id 过滤。
- GET /collector：当前采集游标、通信 epoch、绑定版本及上次尝试结果。
- GET /trace/:key：按 deliveryId、DATAID 或记录 id 追踪一次事件，返回原始事件、当时所用绑定及其来源（active/history）、绑定依据、确认结果与 reasons。
  - state=interpreted：已按当时绑定解释。
  - state=awaiting-review：设备已发送，但接入端无法确定定义或值，需人工核对。
  - state=not-delivered：事件页读取成功，但其中没有该标识。
  - state=delivery-unknown：事件页读取失败，不能据此断定设备未发送。
