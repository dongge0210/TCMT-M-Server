# tcmt-server — TCMT-M 中转后端（前后端分离）

接收 TCMT-M 客户端推送的硬件快照，SQLite 落盘，通过 REST + WebSocket 提供给独立的
展示端（TCMT-M-viewer）。本仓库**只含后端**，不托管任何前端页面。

## 角色划分

| 角色 | 说明 |
| --- | --- |
| client (TCMT-M) | 采集硬件信息，`--http` 模式下每 2s 推送快照 |
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
./build/src/TCMT-M --http --server http://<server-ip>:8080
```

需要 Node.js >= 22.5（使用内置 `node:sqlite`，零 npm 依赖）。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 服务信息（endpoints 列表） |
| GET | `/ping` | 健康检查 |
| POST | `/api/register` | 注册设备 `{clientKey?,name,os,model}` → `{id,token,name}` |
| POST | `/api/ingest` | 推送快照 `{token, ...fields}` |
| GET | `/api/devices` | 设备列表（含 online 状态） |
| GET | `/api/devices/:id` | 设备信息 |
| GET | `/api/devices/:id/latest` | 最近一次快照 |
| GET | `/api/devices/:id/summary` | 整理后的摘要（cpu/memory/gpu/motion/temperatures） |
| GET | `/api/devices/:id/fields` | 字段索引（min/max/last/count） |
| GET | `/api/devices/:id/history?field=x&from=-1h&to=&limit=1000&bucket=30` | 时间序列（`bucket` 秒级即时降采样，返回 `{ts,avg,min,max}`） |
| GET | `/api/devices/:id/temperatures` | 温度数组 |
| GET | `/ws` | WebSocket：`devices` 列表每 0.5s 广播，`snapshot` 实时推送 |

## 数据

- SQLite 库默认 `~/.tcmt/server.db`（WAL 模式），三张表：`devices`（幂等注册）、
  `snapshots`（整包快照）、`timeseries`（扁平化数值字段，按 `device_id+field+ts` 索引）。
- 保留期由 `--retention-days` 控制（默认 30 天），启动时与每 500 次 ingest 后自动清理。
- 历史/字段查询全部走 SQLite，重启后数据仍在；最新快照保留在内存供 `/latest` 与 WS 实时推送。
- 首次启动若发现旧的 `data/devices.json`（或 `~/.tcmt/devices.json`），注册信息自动迁移入库。
- `/api/ingest` 需要设备 token；快照中的 `token` 字段不会外泄（存储前剥离）。

## 测试

```bash
npm test    # node --test（store 单测 + API 集成测试，全部用临时库）
```

## 结构

```
TCMT-M-server/
├── server.js          # 入口：HTTP + WebSocket + 广播
├── lib/store.js       # SQLite 设备注册 + 快照 + 时序 + 字段索引 + 摘要
├── lib/api.js         # REST 路由（纯 API，无静态文件）
├── lib/ws.js          # RFC-6455 握手/帧/心跳（零依赖）
└── test/              # node --test 单测 + 集成测试
```
