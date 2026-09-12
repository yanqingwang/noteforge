# NoteForge — Manjaro/Arch Linux 安装指南

## 快速安装

```bash
cd /path/to/noteforge/pkg/manjaro
makepkg -si        # 需要 cmake、cargo-tauri（cargo install tauri-cli）
# 依赖不齐时：
makepkg -d -f
```

已构建好的包可直接安装：

```bash
sudo pacman -U noteforge-0.1.0-3-x86_64.pkg.tar.zst
```

## 安装内容

| 命令 | 类型 | 说明 |
|------|------|------|
| `noteforge` | 桌面 GUI | Tauri 应用（文件树 / CM6 即输即显编辑器 / 预览 / 搜索 / 反链 / 图谱 / Nextcloud 同步） |
| `nf-vaultgen` | CLI | 测试 vault 生成器（11 profiles） |

## 手动编译

```bash
cd /path/to/noteforge
cd frontend && npm install && npm run build && cd ..
cargo build --release -p noteforge
sudo install -Dm755 target/release/nf-vaultgen /usr/local/bin/
sudo install -Dm755 target/release/noteforge /usr/local/bin/
```

## 快速使用

```bash
# 生成测试库
nf-vaultgen generate --profile smoke --seed 42 --out ./my-vault

# 启动桌面应用
noteforge
```

## Nextcloud 同步配置

1. 启动应用，打开 vault 目录
2. 设置 → ☁ Nextcloud 同步：填服务器地址、用户名、应用密码（Nextcloud「设置 → 安全 → 设备与活动」生成）
3. 远程目录默认 `NoteForge`；加密同步默认开启，设置同步密码（其他设备需输入同一密码）
4. 「测试连接」→「立即同步」；首次同步会引导选择方向并自动备份

## 卸载

```bash
sudo pacman -R noteforge
```
