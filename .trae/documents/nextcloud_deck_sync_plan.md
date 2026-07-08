# Obsidian Nextcloud Deck 插件 —— 可行性评估 & 实施计划 (v2)

> 目标：将当前 [task-deck](file:///Users/victorsmith/Documents/trae_projects/task-deck) fork 为一款 Obsidian 插件，在本地以 Kanban 视图 + Markdown 卡片编辑管理 Deck；同时通过 **Nextcloud Deck REST API** 双向同步，实现 Obsidian（桌面 / 移动）↔ Nextcloud Web / Nextcloud Deck 官方 App 之间的数据一致。
>
> **v2 更新**：
> - 附件同步移入二期，并附独立技术方案章节。
> - 完全剔除 Sync Deck 相关代码/文案（当前仓库有大量残留）。
> - 认证首选 Login Flow v2，App Password 作为可靠性兜底。
> - 补充 "prompt" 冲突策略细节及推荐方案。
> - MVP 明确为**单账号 / 单 Nextcloud 实例**。

---

## 1. 可行性评估

### 1.1 参考
- **[nextcloud/deck](https://github.com/nextcloud/deck)**：官方后端 + Vue 前端，定义 REST/OCS API 与数据模型（Board / Stack / Card / Label / Attachment / ACL）。
- **[Task Deck](file:///Users/victorsmith/Documents/trae_projects/task-deck)**（当前仓库）：Obsidian 端 Kanban，数据存 `data.json`，卡片映射为 Vault 内 Markdown。
- **[Nextcloud Deck API](https://deck.readthedocs.io/en/latest/API/)**：JSON REST，鉴权 HTTP Basic（用户名 + App Password），响应带 `ETag` / `Last-Modified`。

### 1.2 结论
可行。Task Deck 的 board/list/card/label 语义与 Deck 完全对齐，Markdown description 天然契合；HTTP 走 [obsidian.requestUrl](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/plugin.js)（跨端、免 CORS）。零新依赖，沿用 [build.js](file:///Users/victorsmith/Documents/trae_projects/task-deck/build.js) 打包器。

---

## 2. 仓库现状调研

### 2.1 关键文件
- [manifest.json](file:///Users/victorsmith/Documents/trae_projects/task-deck/manifest.json)：id=`task-deck`，`isDesktopOnly: false`，minAppVersion 1.5.0。
- [src/plugin.js](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/plugin.js)：生命周期、数据加载、Vault reconcile、30s 周期轮询。
- [src/helpers.js](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/helpers.js)：[DEFAULT_DATA](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/helpers.js#L40-L51)、frontmatter/序列化纯函数。
- [src/board-view.js](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/board-view.js)：Kanban 视图。
- [src/modals.js](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/modals.js)：模态框。
- [src/settings-tab.js](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/settings-tab.js)：设置页。
- [build.js](file:///Users/victorsmith/Documents/trae_projects/task-deck/build.js)：极简 CJS 打包器。

### 2.2 现存 Sync Deck 残留（必须清除）
> 用户明确要求剔除 Sync Deck（其为商业化 + Google Drive 同步的独立项目，与目标冲突）。以下位点需要处理：

- **代码**：
  - [src/plugin.js#L421-L595](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/plugin.js#L421-L595)：`getSyncDeckPlugin` / `openSyncDeck` / `boardGate` / `boardLimitReached` / `getSyncDeckBridge` / `getVaultMembers` / `getMemberPicture` / `sendBoardPresence` / `fetchBoardPresence` / `postCardLock` / `acquireCardLock` / `releaseCardLock` / `setCardLocks` / `getCardLockHolder` 等一整块。
  - [src/plugin.js#L50](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/plugin.js#L50)：`cardLocks` / `editingCardId` 注释与初始化。
  - [src/plugin.js#L72](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/plugin.js#L72)、[L1370](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/plugin.js#L1370) 等注释提到 Sync Deck。
  - [src/board-view.js#L21-L108](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/board-view.js#L21-L108)、[L430-L451](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/board-view.js#L430-L451)：presence 层、`Sync Boards` 跨售按钮、`Sync your boards & vaults` 欢迎按钮。
  - [src/modals.js#L724](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/modals.js#L724)、[L851](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/modals.js#L851)、[L884](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/modals.js#L884)：卡片锁 / assignee UI 依赖。
  - [src/helpers.js#L489](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/helpers.js#L489)：avatar 注释。
- **文案 / 品牌**：
  - [README.md](file:///Users/victorsmith/Documents/trae_projects/task-deck/README.md) 中所有 Sync Deck 段落与徽章。
  - [src/settings-tab.js](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/settings-tab.js) 里 Relay/协作相关的 Setting。
- **产物**：
  - [main.js](file:///Users/victorsmith/Documents/trae_projects/task-deck/main.js) 是 build 产物；改完源码 `node build.js` 重新生成即可，不手改。

> **决策**：assignee/presence 相关能力在 MVP 中改由 **Deck API 的 board 成员 (`acl` + `users`)** 提供；实时光标/卡片锁在 Deck API 中没有对应，MVP 直接砍掉，未来若做协作可再评估。

### 2.3 数据模型对照
| Task Deck 字段 | Nextcloud Deck 字段 | 备注 |
| --- | --- | --- |
| `board.id` | `board.id` (int) | 建立 `remoteIds` 映射 |
| `board.name` | `board.title` | |
| `board.lists[]` | `stacks[]` | Deck 有 `order` 字段 |
| `list.id` / `list.name` | `stack.id` / `stack.title` | |
| `card.id` / `title` / `details` | `card.id` / `title` / `description` | |
| `card.labels[]` | `card.labels[]` | 需先 `POST /boards/{id}/labels` |
| `card.dueDate` | `card.duedate` | ISO 8601 |
| `card.startDate` | ❌ Deck 无 | 保留仅本地 |
| `card.checklist` | 写入 `description` Markdown | Deck 无独立 checklist |
| `card.assignees` | `assignedUsers` | 依赖 board ACL |
| （新增）`remoteId` / `etag` / `lastModifiedAt` / `localDirty` | `ETag` / `lastModified` header | 用于增量 |

---

## 3. 架构设计

```
┌───────────────────────────────────────────────────────────────┐
│                Obsidian Plugin (task-deck fork)               │
│                                                               │
│  ┌────────────┐   ┌──────────────┐   ┌────────────────────┐   │
│  │ BoardView  │◄─►│  Plugin Core │◄─►│  Vault (Markdown)  │   │
│  └────────────┘   │ (data.json)  │   └────────────────────┘   │
│                   └──────┬───────┘                            │
│                          │                                    │
│                   ┌──────▼───────┐   ┌────────────────┐       │
│                   │ SyncManager  │◄─►│ Conflict Modal │       │
│                   └──────┬───────┘   └────────────────┘       │
│                          │                                    │
│                   ┌──────▼───────┐   ┌────────────────┐       │
│                   │  DeckClient  │◄─►│ NextcloudAuth  │       │
│                   └──────┬───────┘   └────────────────┘       │
└──────────────────────────┼────────────────────────────────────┘
                           │ HTTPS
                           ▼
                   Nextcloud (Deck + Files)
```

新增 `src/` 模块（无第三方依赖）：
- `deck-client.js`：REST 封装（board / stack / card / label / assignee / attachment）。
- `sync-manager.js`：dirty 队列 + 增量拉取 + 冲突分派。
- `sync-mapper.js`：本地 ↔ Deck 模型双向映射。
- `nextcloud-auth.js`：Login Flow v2 + App Password 兜底 + 凭证加密。
- `conflict-modal.js`（附加到 `modals.js`）：冲突手动解决 UI。

---

## 4. 认证方案（问题 3）

推荐方案：**Login Flow v2 为主，App Password 手填为兜底**。用户在设置页可以任选。

### 4.1 Login Flow v2（推荐）
Nextcloud 官方推荐给第三方客户端使用，Deck 官方 Android App 也是此流程：
1. 用户输入服务器 URL，点击 "使用浏览器登录"。
2. `POST {server}/index.php/login/v2` → 获得 `{token, poll: {token, endpoint}, login}`。
3. 插件 `window.open(login)` 打开浏览器 → 用户登录 + 授权。
4. 插件后台以 `poll.token` 每 3–5s POST 一次 `poll.endpoint`，直到返回 `{server, loginName, appPassword}` 或超时（默认 20 分钟）。
5. 将得到的 `appPassword` 加密存储，之后所有 API 走 HTTP Basic (`loginName:appPassword`)。

- 优点：无需用户手动去 Nextcloud 设置里创建密码，Nextcloud 会自动生成一个 App Password 与本插件绑定，可在服务端一键吊销。
- 移动端：`window.open` 会调用系统浏览器；轮询回到 Obsidian 后完成握手，实测在 iOS/Android 上可用。

### 4.2 App Password 兜底
用户在浏览器打开 `Settings → Security → Devices & sessions → Create new app password`，把用户名 + App Password 手工粘贴到设置页。适用于：
- 企业代理下 Login Flow 回调失败。
- 用户偏好离线配置。

### 4.3 凭证存储
- 明文永不落盘。使用 Web Crypto（`crypto.subtle`）+ 基于 vault-id + 用户设备指纹派生密钥，加密后写入 `data.json` 的 `nextcloud.appPasswordCipher`。
- 加载时解密到内存；换设备时若解密失败则提示重新登录（正是我们想要的行为）。

---

## 5. 冲突策略（问题 4）"prompt" 到底是什么？

### 5.1 三种候选
| 策略 | 行为 | 优点 | 缺点 |
| --- | --- | --- | --- |
| `local`（本地胜） | 本地未推的字段直接覆盖远端 | 简单、无打扰 | 多设备切换会覆盖远端最新改动 |
| `remote`（远端胜） | 远端字段直接覆盖本地 | 与"Nextcloud 是真理"心智一致 | 用户在飞行模式改的本地内容可能被静默丢弃 |
| `prompt`（弹窗） | 检测到"双端都改过同一字段"时弹 `ConflictModal`，用户逐字段选取 | 零数据丢失 | 有打扰；需要 UI 支持 |

### 5.2 `ConflictModal` 是什么样子？
纯 Obsidian Modal，形如：
```
┌ Conflict on card "Prepare release notes" ────────────────────┐
│ Detected at 2026-07-08 10:15                                 │
│                                                              │
│ Field      | Local                | Remote (Nextcloud)       │
│ ───────────┼──────────────────────┼───────────────────────── │
│ Title      | Prepare release ...  | Prepare release notes    │
│            | [Keep local ●]       | [Keep remote ○]          │
│ Description| (diff 视图, 可展开)  | (diff 视图, 可展开)      │
│            | [Keep local ○] [Keep remote ●] [Merge manually] │
│ Due date   | 2026-07-15           | 2026-07-14               │
│            | [Keep local ●]       | [Keep remote ○]          │
│                                                              │
│ [Apply] [Skip once] [Always keep local] [Always keep remote] │
└──────────────────────────────────────────────────────────────┘
```
细则：
- **字段级**：只对真正双侧都改的字段发问；其余字段自动 merge（谁改就用谁的）。
- **Description**：展开后展示 3-way diff（远端 / 本地 / 上次同步 baseline）。
- **Merge manually**：打开一个 Markdown 输入框，预填合并模板：
  ```
  <<<<<<< local
  ...
  =======
  ...
  >>>>>>> nextcloud
  ```
  用户编辑后保存作为新描述。
- **Skip once**：本次跳过，卡片保持双侧当前状态，下次轮询若冲突仍在会再问。
- **Always keep local / remote**：把 `nextcloud.conflictPolicy` 改为 `local` / `remote`，此后不再弹窗（仍会记入同步日志）。

### 5.3 我的建议
默认 `prompt`，但**加一个降噪层**：
1. **字段级自动合并**：只有当同一字段两侧都改动才算冲突；这已大幅降低弹窗频率。
2. **短窗抖动过滤**：若本地推送后 5s 内收到远端回执（就是我们自己刚推的那条），跳过。
3. **描述 hash 对比**：description 相同（whitespace-normalized）不视为冲突。
4. 冲突默认策略允许改：`prompt`（默认）/ `local` / `remote` / `newer-wins`（按 `lastModified` 取新的，作为进阶选项）。

**推荐默认值：`prompt`**。理由：用户 A 手动改标题、用户 B 在移动端改 due date，两者不冲突→自动合并；只有真正无法确定的场景才打扰用户，且这些场景往往就是用户想知道的。

---

## 6. 附件同步方案（问题 1，二期）

### 6.1 结论：**不需要接第三方 S3，完全依赖 Nextcloud 自身存储**
Nextcloud Deck API 原生支持附件，底层存储由 Nextcloud 管理。

### 6.2 Deck Attachment API 概览
- `GET  /boards/{boardId}/stacks/{stackId}/cards/{cardId}/attachments`
- `POST /boards/{boardId}/stacks/{stackId}/cards/{cardId}/attachments`（multipart/form-data, 字段 `type`, `file`）
- `GET  .../attachments/{attachmentId}`（下载）
- `PUT  .../attachments/{attachmentId}/restore`（回收站还原）
- `DELETE .../attachments/{attachmentId}`（软删除）

**attachment.type 两种**：
| type | 存储位置 | 适用场景 |
| --- | --- | --- |
| `deck_file` | Deck 自己的存储（`data/appdata_*/deck`），底层复用 Nextcloud 用户存储后端 | 卡片专属附件，独立生命周期 |
| `file`（Deck ≥ 1.9） | 直接引用 Nextcloud Files 中的路径 | 与 Nextcloud Files 的既有资料库共享 |

> 无论哪种 type，**存储都由 Nextcloud 管理**。Nextcloud 底层可配置为本地磁盘、S3、Swift、SFTP 等，但那对客户端透明——插件永远只跟 Deck API 对话。

### 6.3 二期实现方案（预告）
1. **Vault → Deck 上传**：
   - 卡片 Markdown 里的图片/文件链接（例如 `![[attachments/foo.png]]` 或 `attachments/foo.png`）解析后：
     - 若尚未在远端出现（无匹配 `remoteAttachmentId`）→ multipart `POST` 上传为 `deck_file`。
     - 收到 `attachmentId` 后，替换 description 内的相对链接为 Deck 提供的下载 URL（保留 wikilink 双写）。
2. **Deck → Vault 下载**：
   - 每次拉取 card 时，如果 `attachments[]` 有新条目：
     - `GET .../attachments/{id}` 取二进制 → 写入 `<board>/attachments/{cardId}/{filename}`。
     - description 中若已有远端 URL，改写成本地 wikilink，保持"Vault 内可离线看"的体验。
3. **重命名 / 删除**：Vault 侧删除文件 → 调 `DELETE`；远端删除 → 本地保留但打 `⚠︎ removed remotely` 标记（避免误删），下一轮问询用户是否也删本地。
4. **配额 & 大文件**：单文件默认限 20 MB（Nextcloud 默认上传上限，可读服务端 `/ocs/v1.php/cloud/capabilities` 获取真实值）；超限走 chunked upload（Nextcloud Files WebDAV 的 chunked，Deck 内部就是这样处理的）。
5. **失败降级**：附件上传失败不阻塞主同步；重试队列独立。
6. **兼容旧数据**：`file` type 附件仅显示 Nextcloud Files 路径，MVP 二期先只读，不下载（若真要下载，走 WebDAV `/remote.php/dav/files/{user}/...`）。

### 6.4 存储与安全
- 无需 S3/OSS 凭证：附件二进制流全部通过 Deck API 走同一个 App Password 会话，遵循 Nextcloud 的分享 / 加密 / 版本策略。
- 附件下载后写入 Vault，配合 Obsidian Sync/仓库 Git 自动被现有工作流覆盖，不会造成"孤儿文件"。

---

## 7. 实施步骤

### Phase 0 — 品牌 & 基础设施（**清除 Sync Deck**）
1. **删除代码**：把 [§2.2](file:///Users/victorsmith/Documents/trae_projects/task-deck/.trae/documents/nextcloud_deck_sync_plan.md) 列出的 Sync Deck 相关函数、UI 按钮、presence 层、cardLocks / editingCardId、Relay 设置项，全部移除；相关注释同步清理。
2. **UI 清理**：`BoardView` 顶栏 `Sync Boards` 按钮改成 `Sync Nextcloud`（禁用/启用视账号状态）；欢迎页移除 `Sync your boards & vaults` CTA。
3. **文案 & 品牌**：更新 [README.md](file:///Users/victorsmith/Documents/trae_projects/task-deck/README.md)（移除 Sync Deck / Relay 段落）、[manifest.json](file:///Users/victorsmith/Documents/trae_projects/task-deck/manifest.json) description 改为 "Kanban boards for Obsidian with optional Nextcloud Deck sync"；插件 id 视需要另议（保留 `task-deck` 以兼容既有安装，或改新 id + 重命名迁移，见 §10）。
4. **扩展数据结构**：在 [DEFAULT_DATA](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/helpers.js#L40-L51) 追加：
   ```js
   nextcloud: {
     enabled: false,
     serverUrl: "",
     username: "",
     appPasswordCipher: "",
     boardBindings: {},          // localBoardId -> remoteBoardId
     lastSyncAt: 0,
     syncIntervalMs: 60_000,
     conflictPolicy: "prompt",   // prompt | local | remote | newer-wins
     attachmentsEnabled: false,  // 二期开启
   }
   ```
   规范化写入 [loadPluginData](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/plugin.js#L112-L139)。
5. **卡片/列表/board 上追加同步元数据**：`remoteId`、`etag`、`remoteUpdatedAt`、`baselineHash`（用于三方合并 diff）、`localDirty`。存于 `data.json`，不写入 Markdown frontmatter 以免污染用户笔记（除非用户明确要）。

### Phase 1 — 认证 & 连接
6. `src/nextcloud-auth.js`：
   - `startLoginFlowV2(serverUrl)` + 轮询回调 UI。
   - `saveAppPassword(username, appPassword)` / `loadAppPassword()`（Web Crypto AES-GCM）。
   - `logout()`：调 `DELETE /ocs/v2.php/core/apppassword` 主动吊销 App Password 并清本地凭证。
7. `src/deck-client.js`：
   - HTTP: `obsidian.requestUrl`，统一注入 `OCS-APIRequest: true`、Basic Auth；解析 `ETag`。
   - 端点封装（boards / stacks / cards / labels / assignees / acl）。
   - 错误处理：401 → 触发重新登录；429/5xx → 指数退避（1→2→4→…最大 60s）；日志入环形缓冲。
8. 扩展 [TaskDeckSettingTab](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/settings-tab.js#L9)：
   - "Nextcloud sync" 分区：Server URL、Login with browser、App Password 手填备选、Logout、Test connection、Sync interval、Conflict policy 下拉、Sync log。

### Phase 2 — 只读拉取
9. `src/sync-mapper.js`：`remoteBoardToLocal(board, stacks, cards)` + 反向。处理 label/user/date/description。
10. `src/sync-manager.js`：
    - `pullAll()` / `pullBoard(binding)`：基于 `ETag` + `If-None-Match`（Deck 支持）或 fallback 到 `Last-Modified`。
    - 首次绑定弹 `BoardBindingModal`：远端 board 列表 ↔ 本地 board 列表配对/新建。
    - 挂钩到现有 [reconcileVaultFiles](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/plugin.js#L147-L180) 之后触发一次 pull。
    - 30s 周期轮询改为「本地 reconcile + Nextcloud pull」组合，间隔可配。
11. `BoardView` 顶栏加同步状态点（绿/黄/红/离线）+ 最近同步时间 tooltip。

### Phase 3 — 双向写回
12. 在所有 mutation 出口打 `localDirty = true`；`sync-manager` 消费队列时按依赖顺序推送（board → stack → card → label → assignee）。
13. 冲突处理（§5）：
    - 三方 diff（local / remote / baseline=上次同步时的字段快照）。
    - 无双改字段 → 静默合并。
    - 有双改字段 → 按 `conflictPolicy` 处理；`prompt` 时打开 `ConflictModal`。
    - 冲突事件写 sync log。
14. 离线体验：`requestUrl` 失败 → 队列保留 + 状态点转黄 + 下一次 tick 重试。

### Phase 4 — 附件同步（二期，见 §6）
15. 附件上传/下载 / rename / delete / 冲突。
16. 大文件 chunked upload。
17. `attachmentsEnabled` 设置开关，默认关闭直到用户开启。

### Phase 5 — 打磨
18. 移动端手测：iOS/Android 完整跑一遍 Login Flow v2 + 拉取 + 编辑 + 冲突。
19. `Sync log` 面板（近 200 条事件）。
20. 单元测试脚本（Node 原生 assert）：`sync-mapper` 双向映射、冲突判定纯函数。
21. 更新 [README.md](file:///Users/victorsmith/Documents/trae_projects/task-deck/README.md)：新的 feature 列表、Nextcloud 使用指南、隐私说明。

---

## 8. 依赖与外部约束
- **无新增 npm 依赖**（HTTP → `obsidian.requestUrl`；加密 → Web Crypto）。
- Nextcloud 建议 ≥ 25，Deck 建议 ≥ 1.9（`file` 类型附件需要）。
- Deck app 需在 Nextcloud 端启用。
- 私有部署 HTTPS 必须走可信证书；桌面端提供 "允许不安全证书" 开关（`isDesktopOnly` 分支），移动端不提供。

---

## 9. 风险与对策
| 风险 | 影响 | 对策 |
| --- | --- | --- |
| Sync Deck 残留代码遗漏 | 编译报错 / UI 错乱 | Phase 0 单独提交，`grep -ri "syncdeck\|sync-deck\|SyncDeck"` 双检 |
| Deck API 分页限流 | 大 board 拉取失败 | 分页 + 退避 + 单批容错 |
| Markdown ↔ description 漂移 | 无谓冲突 | baseline hash + normalize 后再 diff |
| Assignee/Label 依赖 board 成员 | 推送 400 | 提前 `GET acl/labels` 缓存 + 缺失自动 `POST label` + assignee 缺失只 warn |
| Vault 内文件重命名冲突 | 卡片重复 | 优先按 `remoteId` 匹配；同 id 沿用 [dedupeCardFilesById](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/plugin.js#L152-L160) |
| 加密密钥换设备失效 | 需要重新登录 | 明确文档说明；本身也是安全边界 |
| iOS/Android 自签证书拒绝 | 私有部署失败 | 文档提示；桌面端可选开关 |
| 附件大文件 timeout | 上传失败 | chunked + 断点续传（二期） |
| 冲突频发 | 打扰 | 字段级 diff + baseline + normalize + 可切换策略 |

---

## 10. 交付、命名与验收

### 10.1 交付里程碑
- **M1**（Phase 0–1）：Sync Deck 清理完毕 + Login Flow v2 可登录 + 设置页可测连接。
- **M2**（Phase 2）：只读拉取，能把远端 board 显示到 Obsidian。
- **M3**（Phase 3）：双向增量 + 冲突弹窗；MVP 发布 candidate。
- **M4**（Phase 4）：附件同步。
- **M5**（Phase 5）：移动端 + 诊断 + 文档。

### 10.2 插件命名（待定）
两个方案，请选：
- **方案 A**：保留 `id=task-deck`（升级路径最平滑），仅改 name/description 为 `Task Deck for Nextcloud`。
- **方案 B**：新 id（如 `obsidian-nextcloud-deck`），彻底与上游 fork 解耦；作者品牌重塑更干净，但既有安装需要迁移脚本。

### 10.3 验收用例
1. 空 vault + 空 Nextcloud → 本地新建 board → 远端出现。
2. 远端新建 → Obsidian 拉取 → Markdown 卡片生成。
3. 同字段双改 → 触发 `ConflictModal`。
4. 关网离线编辑 → 恢复后自动补推 + 状态点回绿。
5. 换设备重新登录 → 数据保持一致。

---

## 11. 用户已确认的选择（v3）
1. **附件同步**：二期（§6 独立方案，不需要 S3/第三方存储，Deck API 原生支持）。
2. **彻底剔除 Sync Deck**（§2.2 已列全部残留位点）。
3. **认证**：Login Flow v2 首选，App Password 手填兜底（§4）。
4. **冲突策略**：默认 `prompt` + 字段级自动合并 + 降噪层（§5.3）；**必要冲突仍需用户解决**；可切换 `local`/`remote`/`newer-wins`。
5. **MVP 单账号单实例**。
6. **命名方案 B**：新 plugin id `obsidian-nextcloud-deck`，name `Obsidian Nextcloud Deck`；上游 `task-deck` 品牌/CTA/依赖全部剥离；[manifest.json](file:///Users/victorsmith/Documents/trae_projects/task-deck/manifest.json)、[helpers.js VIEW_TYPE](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/helpers.js) 等 id/命名同步更新；旧 vault 的 `data.json` 提供一次性数据迁移（读老路径 → 写新插件目录）。
7. **移动端**：优先级降低，统一到 **M5** 集中验证；M1–M3 只做桌面回归。

## 12. Assignee 抉择（已确认 B1）
- **B1（已选）**：单人使用 → MVP 砍掉 assignee UI，只保留数据兼容位。
  - 具体动作：
    - 移除 [src/modals.js#L851-L884](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/modals.js#L851-L884) 附近的 "assign menu"、"No members — sign in to Sync Deck" 等 UI 分支。
    - 移除 [plugin.js getVaultMembers / getMemberPicture](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/plugin.js#L479-L495)。
    - `card.assignees` 数据结构保留（`helpers.js normalizeCardLabels/normalizeAssignees` 相关处），仅不再显示、不再编辑；旧数据不会丢，二期加回 UI 时可继续用。
    - `assigneesToFrontmatter` 序列化保留但只输出非空数组（避免污染 vault）。
  - 二期若开团队协作，再接 Deck ACL 复活 UI。

---

## 13. 最终计划总结（待用户批准后执行）
所有开放问题已闭合：
1. 附件同步 → 二期，靠 Deck API + Nextcloud 存储，无第三方依赖。
2. Sync Deck → Phase 0 一次性彻底剔除。
3. 认证 → Login Flow v2 首选 + App Password 兜底 + Web Crypto 本地加密。
4. 冲突 → 默认 `prompt`，降噪层过滤伪冲突；必要冲突弹 `ConflictModal`。
5. MVP → 单账号单 Nextcloud 实例。
6. 命名 → 方案 B（新 id `obsidian-nextcloud-deck`），提供 `data.json` 一次性迁移。
7. 移动端 → M5 统一验证。
8. Assignee → B1，MVP 砍 UI 保数据。

**请回复 "同意" 或 "approved" 我即刻进入 Phase 0 执行**（Phase 0 会：清 Sync Deck 代码/文案、改插件 id/name/VIEW_TYPE、扩展 `DEFAULT_DATA` 加 `nextcloud` 分区与同步元数据、跑 `node build.js` 验证）。
