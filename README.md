# tcmt-server — TCMT-M 中转后端（前后端分离）

接收 TCMT-M 客户端推送的硬件快照，SQLite 落盘，通过 REST + WebSocket 提供给独立的
展示端（TCMT-M-viewer）。内置一个 **server 看板**（`/dashboard/`，运维视角）；用户侧
的展示端仍是独立 app（TCMT-M-viewer），本仓库不托管它。

## 角色划分

| 角色 | 说明 |
| --- | --- |
| client (TCMT-M) | 采集硬件信息，每 2s 推送快照（server 地址在客户端 TUI 设置） |
| **server**（本仓库） | 中转 + 落盘：注册设备、SQLite 快照/时序存储、历史/字段/摘要接口，REST + WS |
| viewer (TCMT-M-viewer) | 展示端：独立纯前端，通过 CORS 读本 server 的 API |

## 运行

```bash
node server.js                        # 默认 0.0.0.0:8080
node server.js --port 9000            # 换端口
node server.js --db ~/.tcmt/server.db # 指定数据库（默认即此路径）
node server.js --retention-days 7     # 快照/时序保留天数（默认 30）
node server.js --cors-origin http://localhost:5173  # 收紧 CORS（默认 *）
node server.js --auth-token <secret>  # 读接口 + /ws 需要 Bearer token
node server.js --tls-cert fullchain.pem --tls-key privkey.pem --auth-token <secret>
```

启动客户端（同一局域网任意机器）：

```bash
./build/src/TCMT-M
```

server 地址在客户端 TUI 设置里配置（`http://<server-ip>:8080`）。

需要 Node.js >= 22.5（使用内置 `node:sqlite`，零 npm 依赖）。

### 长历史归档（可选，InfluxDB）

SQLite 只保留最近 `--retention-days` 天的热数据；更早的行可以自动搬进 InfluxDB
（单向归档，零 npm 依赖，直接走 line protocol）：

```bash
docker run -d --name tcmt-influx -p 8086:8086 influxdb:2
# 初始化一次（网页 http://localhost:8086 或 CLI）：建 org "tcmt"、bucket "tcmt"、拿 token

node server.js \
  --influx-url http://127.0.0.1:8086 \
  --influx-token <token> \
  --influx-org tcmt \
  --influx-bucket tcmt
```

启动时立即归档一轮，之后每小时一次；每次分批发（每批 5000 行、每轮最多 20 批），
不影响在线 ingest。数据写入 measurement `tcmt_metric`，tag 为 `device_id` + `field`，
字段 `value`，时间戳毫秒精度。不配置 `--influx-url` 则归档完全禁用（旧数据照旧由
保留期直接清理）。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 服务信息（endpoints 列表） |
| GET | `/ping` | 健康检查 |
| POST | `/api/register` | 注册设备 `{clientKey?,name,os,model}` → `{id,token,name}` |
| POST | `/api/ingest` | 推送快照 `{token, ...fields}` |
| POST | `/api/ws-ticket` | 用 Bearer token 换一次性 WS 票据（30s 有效、单次使用，浏览器连 WS 用） |
| GET | `/api/aggregate` | 全设备聚合：总数/在线数、CPU/内存/GPU 均值与峰值（含 maxDevice）、温度均值与最高传感器 |
| GET | `/api/stats` | server 状态：版本/uptime/WS 连接数/设备数/DB 路径/保留天数 |
| GET | `/api/devices` | 设备列表（含 online 状态） |
| GET | `/api/devices/:id` | 设备信息 |
| GET | `/api/devices/:id/latest` | 最近一次快照 |
| GET | `/api/devices/:id/summary` | 整理后的摘要（cpu/memory/gpu/motion/temperatures） |
| GET | `/api/devices/:id/fields` | 字段索引（min/max/last/count） |
| GET | `/api/devices/:id/history?field=x&from=-1h&to=&limit=1000&bucket=30` | 时间序列（`bucket` 秒级即时降采样，返回 `{ts,avg,min,max}`） |
| GET | `/api/devices/:id/temperatures` | 温度数组 |
| GET | `/ws` | WebSocket：`devices` 列表与 `aggregate` 聚合每 0.5s 广播，`snapshot` 实时推送；认证优先用 `?ticket=`（一次性），旧客户端兼容 `?access_token=` |
| GET | `/dashboard/` | 内置 server 看板（纯静态页，同源托管；零依赖） |

## 数据

- SQLite 库默认 `~/.tcmt/server.db`（WAL 模式），三张表：`devices`（幂等注册）、
  `snapshots`（整包快照）、`timeseries`（扁平化数值字段，按 `device_id+field+ts` 索引）。
- 保留期由 `--retention-days` 控制（默认 30 天），启动时与每 500 次 ingest 后自动清理。
- 历史/字段查询全部走 SQLite，重启后数据仍在；最新快照保留在内存供 `/latest` 与 WS 实时推送。
- `/api/aggregate` 与 WS `aggregate` 消息只统计**在线**设备的当前快照（离线设备仅计入 total/offline），避免陈旧数据拉偏全设备均值。
- 首次启动若发现旧的 `data/devices.json`（或 `~/.tcmt/devices.json`），注册信息自动迁移入库。
- `/api/ingest` 需要设备 token；快照中的 `token` 字段不会外泄（存储前剥离）。

## 测试

```bash
npm test    # node --test（store 单测 + API 集成测试，全部用临时库）
```

## 内置 dashboard

启动后打开 `http://<server>:8080/dashboard/`：

- 全设备概览（来自 `/api/aggregate` + WS 实时推送）：总数/在线/离线、CPU/内存/GPU 均值与峰值、最高温度
- 实时趋势 sparkline（全设备均值，最近 1 分钟）
- 设备表：在线状态、CPU/内存/GPU/温度/最后在线
- server 信息（来自 `/api/stats`）：WS 连接数、DB 路径、保留天数、uptime、快照速率

看板为纯静态页（`dashboard/` 目录），由 server 直接托管，无构建步骤；受
`--auth-token` 保护（读接口 401 时页面会提示输入令牌）。

## 结构

```
TCMT-M-server/
├── server.js          # 入口：HTTP + WebSocket + 广播
├── lib/store.js       # SQLite 设备注册 + 快照 + 时序 + 字段索引 + 摘要
├── lib/api.js         # REST 路由（纯 API）
├── lib/static.js      # dashboard 静态文件服务（路径穿越防护）
├── lib/archive.js     # InfluxDB 长历史归档（line protocol，零依赖）
├── lib/ws.js          # RFC-6455 握手/帧/心跳（零依赖）
├── dashboard/         # 内置 server 看板（index.html + styles.css + app.js）
└── test/              # node --test 单测 + 集成测试
```
