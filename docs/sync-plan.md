# NoteForge Joplin-Compatible Sync Plan

> 调研日期：2026-07-06

## 一、Joplin 同步机制总结

### 1.1 架构分层

```
┌─────────────────────────────────────────────┐
│              Synchronizer                    │
│  (同步流程编排：上传/下载/删除/冲突处理)         │
├─────────────────────────────────────────────┤
│              SyncTarget                     │
│  (同步目标适配器：元数据、配置校验)              │
├─────────────────────────────────────────────┤
│              FileApi                        │
│  (文件操作抽象：create/update/delete/list/get) │
├─────────────────────────────────────────────┤
│   file-api-driver-local  │  file-api-...     │
│   file-api-driver-webdav │  JoplinServerApi  │
└─────────────────────────────────────────────┘
```

### 1.2 数据模型

每个同步项（Item）都有以下通用属性：
- `id` — UUID
- `parent_id` — 父级 ID（文件夹/笔记的层级关系）
- `title` — 标题
- `body` — 内容（仅 note 有，Markdown 格式）
- `created_time` / `updated_time` — Unix 时间戳（毫秒）
- `is_deleted` — 软删除标记
- `user_created_time` / `user_updated_time` — 用户设置的时间

Item 类型：
| 类型 | 说明 | 存储格式 |
|------|------|---------|
| note | 笔记 | Markdown (`.md`) + JSON 元数据 |
| folder | 笔记本/文件夹 | JSON |
| tag | 标签 | JSON |
| resource | 附件（图片等） | 二进制文件 + JSON 元数据 |
| note_tag | 笔记-标签关联 | JSON |
| revision | 笔记历史版本 | JSON |

### 1.3 WebDAV 同步（文件系统模式）

存储结构（扁平目录）：
```
<sync_root>/
├── info.json              # 同步目标配置（版本、E2EE 等）
├── locks/                 # 同步锁
├── temp/                  # 临时文件
├── notes/
│   ├── {note_id}.md       # 笔记内容
│   └── {note_id}.json     # 笔记元数据
├── folders/
│   └── {folder_id}.json
├── tags/
│   └── {tag_id}.json
├── note_tags/
│   └── {note_tag_id}.json
├── resources/
│   └── {resource_id}.json
└── .resource/
    └── {resource_id}      # 附件文件
```

Delta 同步算法：`basicDelta()` — 遍历所有文件，比较 `updated_time`，只同步变更的。

### 1.4 Joplin Server 同步（REST API）

端点：
- `GET /api/files/delta` — 获取增量变更（返回 cursor + events）
- `GET /api/files/delta?cursor=CURSOR` — 基于游标继续获取
- `PUT /api/files/{id}` — 上传/更新文件
- `DELETE /api/files/{id}` — 删除文件
- `POST /api/session/login` — 登录获取 token

Change Events：
- `create`: 创建
- `update`: 更新
- `delete`: 删除
- 事件压缩：连续 update→update 压缩为一条，create→delete 消除

### 1.5 E2EE 加密

- 使用 AES-256 加密
- 主密钥（Master Key）由用户密码派生
- 公私钥对（PPK）用于密钥交换
- 每个 Item 单独加密，加密后存储为 `encryption_cipher_text`

## 二、NoteForge 同步实现计划

### Phase 1: 核心同步引擎（Rust crate: `nf-sync`）

```
crates/nf-sync/
├── Cargo.toml
├── src/
│   ├── lib.rs              # 公开接口
│   ├── sync_engine.rs      # Synchronizer 核心流程
│   ├── file_api.rs         # FileApi trait（抽象文件操作）
│   ├── item.rs             # Item 数据模型
│   ├── delta.rs            # Delta 同步算法
│   └── error.rs            # 错误类型
```

#### FileApi Trait

```rust
#[async_trait]
pub trait FileApi: Send + Sync {
    async fn create(&self, path: &str, data: &[u8]) -> Result<()>;
    async fn update(&self, path: &str, data: &[u8]) -> Result<()>;
    async fn delete(&self, path: &str) -> Result<()>;
    async fn get(&self, path: &str) -> Result<Vec<u8>>;
    async fn list(&self, prefix: &str) -> Result<Vec<FileEntry>>;
    async fn stats(&self) -> Result<Stats>;
}
```

#### Item 数据模型

```rust
pub struct SyncItem {
    pub id: String,              // UUID
    pub item_type: ItemType,     // Note, Folder, Tag, Resource, NoteTag
    pub title: String,
    pub body: Option<String>,    // Only for Note type
    pub parent_id: Option<String>,
    pub created_time: i64,
    pub updated_time: i64,
    pub is_deleted: bool,
    // Joplin 兼容的序列化/反序列化
}
```

### Phase 2: WebDAV 驱动

```
crates/nf-sync/src/
├── drivers/
│   ├── mod.rs
│   ├── webdav.rs          # WebDAV FileApi 实现
│   └── filesystem.rs      # 本地文件系统 FileApi 实现
```

WebDAV 驱动使用 `http` crate 发送 WebDAV 请求（PROPFIND、PUT、DELETE、GET）。

### Phase 3: Joplin Server 驱动

```
crates/nf-sync/src/
├── drivers/
│   └── joplin_server.rs   # Joplin Server REST API 实现
├── joplin_server_api.rs   # JoplinServerApi HTTP 客户端
```

Joplin Server API：
- 登录：`POST /api/session/login`
- Delta 同步：`GET /api/files/delta`
- 文件 CRUD：`PUT/DELETE/GET /api/files/{id}`

### Phase 4: Tauri 集成

- 同步配置 UI（设置对话框中添加同步设置）
- 同步状态显示
- 手动触发同步 + 自动同步（定时轮询）
- 冲突解决界面

### Phase 5: 测试验证

1. 使用本地文件系统作为同步目标（最快验证）
2. 使用本地 WebDAV 服务器（如 `wsgidav`）测试
3. 连接远程 Joplin Server 测试
4. 与官方 Joplin 客户端互操作测试

## 三、NoteForge 现有 vault 格式 vs Joplin 格式

| 特性 | NoteForge（当前） | Joplin |
|------|-----------------|--------|
| 笔记存储 | `.md` 文件，目录结构自由 | `.md` + `.json` 元数据，UUID 文件名 |
| 目录结构 | 用户自定义嵌套目录 | 扁平化，用 `parent_id` 关联 |
| 元数据 | `.noteforge/config.json` | 每个 item 独立 `.json` 文件 |
| 标签 | 无 | 独立 tag item + note_tag 关联 |
| 附件 | 用户放置在 vault 目录中 | resource item + 独立文件 |
| 同步 | 无 | 基于 FileApi |

### 适配策略

NoteForge 在同步时进行格式转换：
- **导出到 Joplin**：扫描 vault，为每个笔记生成 UUID + JSON 元数据，写入同步目录
- **从 Joplin 导入**：读取同步目录中的 `.md` + JSON，写入 vault（保持 NoteForge 的目录结构）

同步时维护一个 `sync_map`（UUID → vault_path 映射），存储在 `.noteforge/sync_map.json`。

## 四、当前测试计划

### 4.1 连接测试

```bash
# 测试 Joplin Server 连接（用户提供的实例）
curl -X POST https://joplin.8.130.118.200.sslip.io/api/session/login \
  -H "Content-Type: application/json" \
  -d '{"email":"289631530@qq.com","password":"gcJG.<|QU6\"`"}'
```

### 4.2 本地 WebDAV 测试

```bash
# 安装 wsgidav
pip install wsgidav
# 启动 WebDAV 服务器
wsgidav --root=/tmp/joplin-sync-test
# 在 Joplin 中配置 WebDAV 同步
```

### 4.3 与 Joplin 互操作测试

1. 在 Joplin 中创建一个笔记本和笔记
2. 触发同步到 WebDAV
3. NoteForge 读取 WebDAV 中的 Joplin 数据
4. 验证数据正确性