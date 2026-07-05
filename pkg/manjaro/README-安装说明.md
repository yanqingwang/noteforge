# NoteForge — Manjaro/Arch Linux 安装指南

## 快速安装

```bash
cd /path/to/noteforge/pkg/manjaro
makepkg -si
```

## 安装内容

| 命令 | 类型 | 说明 |
|------|------|------|
| `noteforge` | 桌面 GUI | Slint 应用（文件树/编辑器/预览/搜索/反链） |
| `nf-app` | CLI | 命令行 vault 浏览（open/show/render/info） |
| `nf-vaultgen` | CLI | 测试 vault 生成器（11 profiles） |

## 手动编译

```bash
cd /path/to/noteforge
cargo build --release
sudo install -Dm755 target/release/nf-vaultgen /usr/local/bin/
sudo install -Dm755 target/release/nf-app /usr/local/bin/
sudo install -Dm755 target/release/nf-ui /usr/local/bin/noteforge
```

## 快速使用

```bash
# 生成测试库
nf-vaultgen generate --profile smoke --seed 42 --out ./my-vault

# CLI 浏览
nf-app info ./my-vault/vault
nf-app open ./my-vault/vault

# 启动桌面应用
noteforge
```

## 卸载

```bash
sudo pacman -R noteforge
```
