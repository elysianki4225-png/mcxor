#!/usr/bin/env bash
# ==============================================================================
# MCXOR · 网易我的世界存档加解密 PWA 网站 — 自建服务器一键部署脚本
# 仓库地址: https://github.com/elysianki4225-png/mcxor
#
# 功能特性:
#   1. 支持自定义域名自动签发 HTTPS 证书 (Let's Encrypt + ZeroSSL 双重自动备援)
#   2. 支持【无域名】场景：自动识别公网 IPv4 并绑定 <IP>.nip.io 自动签发免费 HTTPS 证书
#   3. 支持 Docker Compose 容器化部署 与 原生 Caddy Systemd 裸机部署双模式
#   4. 局域网私有 IP 自动降级为 Caddy 本地自签名证书 (tls internal) 以确保 PWA 可安装
#
# 用法示例:
#   交互式向导:   sudo ./deploy.sh
#   无域名 nip.io: sudo ./deploy.sh --nip
#   指定公网 IP:   sudo ./deploy.sh --nip --ip 203.0.113.10
#   自定义域名:    sudo ./deploy.sh --domain mc.example.com --email admin@example.com
#   Docker 模式:   sudo ./deploy.sh --mode docker --nip
#   卸载服务:      sudo ./deploy.sh --uninstall
# ==============================================================================

set -euo pipefail

REPO_GIT_URL="https://github.com/elysianki4225-png/mcxor.git"
INSTALL_DIR="/opt/mcxor"
WEB_ROOT="/var/www/mcxor"

DOMAIN=""
USE_NIP=0
CUSTOM_IP=""
ACME_EMAIL=""
DEPLOY_MODE="" # auto | docker | systemd
UNINSTALL=0

# Colors
C_GREEN='\033[0;32m'
C_CYAN='\033[0;36m'
C_YELLOW='\033[1;33m'
C_RED='\033[0;31m'
C_RESET='\033[0m'

info()  { echo -e "${C_CYAN}[INFO]${C_RESET} $*"; }
ok()    { echo -e "${C_GREEN}[OK]${C_RESET} $*"; }
warn()  { echo -e "${C_YELLOW}[WARN]${C_RESET} $*"; }
err()   { echo -e "${C_RED}[ERROR]${C_RESET} $*" >&2; }

usage() {
  cat <<'EOF'
MCXOR 一键部署脚本

参数选项:
  -d, --domain <域名>     使用自定义域名自动签发 HTTPS 证书 (如: mc.example.com)
      --nip               无域名模式：自动检测公网 IP 并使用 <IP>.nip.io 申请 HTTPS 证书
      --ip <IPv4>         配合 --nip 手动指定服务器公网 IPv4 地址
  -e, --email <邮箱>      可选 ACME 证书通知邮箱
  -m, --mode <模式>       部署方式: docker 或 systemd (默认自动优先检测)
      --uninstall         停止并卸载已部署的 MCXOR 服务
  -h, --help              查看帮助信息
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--domain)
      DOMAIN="${2:-}"
      shift 2
      ;;
    --nip)
      USE_NIP=1
      shift
      ;;
    --ip)
      CUSTOM_IP="${2:-}"
      USE_NIP=1
      shift 2
      ;;
    -e|--email)
      ACME_EMAIL="${2:-}"
      shift 2
      ;;
    -m|--mode)
      DEPLOY_MODE="${2:-}"
      shift 2
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "未知参数: $1"
      usage
      exit 1
      ;;
  esac
done

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    err "请使用 root 权限或 sudo 运行此脚本（例如: sudo bash deploy.sh）"
    exit 1
  fi
}

read_prompt() {
  local prompt_text="$1"
  local default_val="${2:-}"
  local reply=""
  if [[ -r /dev/tty ]]; then
    read -r -p "$prompt_text" reply </dev/tty || true
  fi
  if [[ -z "$reply" ]]; then
    echo "$default_val"
  else
    echo "$reply"
  fi
}

is_valid_ipv4() {
  local ip="$1"
  if [[ ! "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    return 1
  fi
  local IFS='.'
  read -r o1 o2 o3 o4 <<<"$ip"
  for octet in "$o1" "$o2" "$o3" "$o4"; do
    if (( octet < 0 || octet > 255 )); then
      return 1
    fi
  done
  return 0
}

is_private_ipv4() {
  local ip="$1"
  local IFS='.'
  read -r o1 o2 _ _ <<<"$ip"
  if (( o1 == 10 )) || (( o1 == 127 )) || (( o1 == 192 && o2 == 168 )) || (( o1 == 172 && o2 >= 16 && o2 <= 31 )) || (( o1 == 100 && o2 >= 64 && o2 <= 127 )); then
    return 0
  fi
  return 1
}

detect_public_ip() {
  if [[ -n "$CUSTOM_IP" ]]; then
    if is_valid_ipv4 "$CUSTOM_IP"; then
      echo "$CUSTOM_IP"
      return 0
    else
      err "手动指定的 IPv4 地址格式无效: $CUSTOM_IP"
      exit 1
    fi
  fi

  local endpoints=(
    "https://api.ipify.org"
    "https://ip.sb"
    "https://icanhazip.com"
    "https://ifconfig.me/ip"
  )

  for url in "${endpoints[@]}"; do
    local candidate=""
    if command -v curl >/dev/null 2>&1; then
      candidate="$(curl -4 -fsSL --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
    elif command -v wget >/dev/null 2>&1; then
      candidate="$(wget -4 -qO- --timeout=5 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
    fi
    if [[ -n "$candidate" ]] && is_valid_ipv4 "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done

  # Fallback to primary network interface IP
  local lan_ip=""
  lan_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -n1 || true)"
  if [[ -n "$lan_ip" ]] && is_valid_ipv4 "$lan_ip"; then
    echo "$lan_ip"
    return 0
  fi

  return 1
}

uninstall_mcxor() {
  require_root
  info "正在停止并清理 MCXOR 部署服务..."
  if [[ -d "$INSTALL_DIR" ]] && command -v docker >/dev/null 2>&1; then
    (cd "$INSTALL_DIR" && docker compose down 2>/dev/null) || true
  fi
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet caddy 2>/dev/null; then
    if [[ -f /etc/caddy/Caddyfile ]] && grep -q "mcxor" /etc/caddy/Caddyfile 2>/dev/null; then
      systemctl stop caddy || true
    fi
  fi
  rm -rf "$WEB_ROOT"
  ok "MCXOR 静态站点文件与容器已清理完成。"
  exit 0
}

if [[ "$UNINSTALL" -eq 1 ]]; then
  uninstall_mcxor
fi

require_root

echo -e "${C_GREEN}==============================================================${C_RESET}"
echo -e "${C_GREEN}   MCXOR · 网易我的世界存档加解密 PWA 一键部署向导           ${C_RESET}"
echo -e "${C_GREEN}==============================================================${C_RESET}"

# 1. Interactive selection if neither --domain nor --nip was specified
if [[ -z "$DOMAIN" && "$USE_NIP" -eq 0 ]]; then
  echo ""
  echo "请选择证书与访问方式:"
  echo "  1) 我有自己的域名 (自动申请 Let's Encrypt / ZeroSSL 免费 HTTPS 证书)"
  echo "  2) 我没有域名，使用 <公网IP>.nip.io 自动申请免费 HTTPS 证书 [默认推荐]"
  choice="$(read_prompt "请输入选项 [1/2, 默认 2]: " "2")"
  if [[ "$choice" == "1" ]]; then
    DOMAIN="$(read_prompt "请输入已解析到本机的域名 (例如 mc.example.com): " "")"
    if [[ -z "$DOMAIN" ]]; then
      err "域名不能为空！"
      exit 1
    fi
  else
    USE_NIP=1
  fi
fi

TLS_DIRECTIVE=""
IS_PRIVATE_NIP=0

if [[ "$USE_NIP" -eq 1 ]]; then
  info "正在检测服务器 IPv4 地址以生成 nip.io 域名..."
  DETECTED_IP="$(detect_public_ip || true)"
  if [[ -z "$DETECTED_IP" ]]; then
    err "无法自动获取服务器 IPv4 地址，请通过 --ip <公网IP> 手动指定。"
    exit 1
  fi
  DOMAIN="${DETECTED_IP}.nip.io"
  if is_private_ipv4 "$DETECTED_IP"; then
    IS_PRIVATE_NIP=1
    TLS_DIRECTIVE="tls internal"
    warn "检测到当前 IP (${DETECTED_IP}) 为内网私有地址，公网 CA 无法直接验证 80/443，将自动启用 Caddy 内置本地证书 (tls internal)。"
  else
    # Caddy v2 automatically uses Let's Encrypt + ZeroSSL fallback (solves nip.io rate limits automatically!)
    TLS_DIRECTIVE=""
    ok "已绑定免域名地址: https://${DOMAIN} (将由 Caddy 自动签发公网受信任 TLS 证书)"
  fi
else
  ok "已绑定自定义域名: https://${DOMAIN}"
fi

ACME_EMAIL_DIRECTIVE=""
if [[ -n "$ACME_EMAIL" ]]; then
  ACME_EMAIL_DIRECTIVE="email ${ACME_EMAIL}"
fi

# 2. Prepare project source directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"
if [[ -f "${SCRIPT_DIR}/index.html" && -f "${SCRIPT_DIR}/manifest.webmanifest" ]]; then
  SRC_DIR="$SCRIPT_DIR"
  info "检测到当前已在项目目录内: ${SRC_DIR}"
else
  info "正在准备仓库代码至 ${INSTALL_DIR}..."
  if ! command -v git >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -y && apt-get install -y git curl ca-certificates
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y git curl ca-certificates
    elif command -v yum >/dev/null 2>&1; then
      yum install -y git curl ca-certificates
    elif command -v apk >/dev/null 2>&1; then
      apk add --no-cache git curl ca-certificates
    fi
  fi
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    git -C "$INSTALL_DIR" fetch --depth 1 origin main && git -C "$INSTALL_DIR" reset --hard origin/main
  else
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 "$REPO_GIT_URL" "$INSTALL_DIR"
  fi
  SRC_DIR="$INSTALL_DIR"
fi

# 3. Determine runtime mode (docker vs systemd)
if [[ -z "$DEPLOY_MODE" ]]; then
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    DEPLOY_MODE="docker"
  else
    DEPLOY_MODE="systemd"
  fi
fi

# Open firewall ports 80/443 if ufw or firewalld is active
open_firewall_ports() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    info "检测到 UFW 防火墙开启，正在放行 80 / 443 端口..."
    ufw allow 80/tcp >/dev/null || true
    ufw allow 443/tcp >/dev/null || true
    ufw allow 443/udp >/dev/null || true
  elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
    info "检测到 firewalld 开启，正在放行 http / https 服务..."
    firewall-cmd --permanent --add-service=http >/dev/null || true
    firewall-cmd --permanent --add-service=https >/dev/null || true
    firewall-cmd --reload >/dev/null || true
  fi
}

install_caddy_native() {
  if command -v caddy >/dev/null 2>&1; then
    ok "已安装 Caddy: $(caddy version)"
    return 0
  fi

  info "正在安装官方 Caddy Web 服务器（自动管理 HTTPS 与 nip.io 证书）..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    apt-get update -y
    apt-get install -y caddy
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y 'dnf-command(copr)'
    dnf copr enable -y @caddy/caddy
    dnf install -y caddy
  elif command -v yum >/dev/null 2>&1; then
    yum install -y yum-plugin-copr
    yum copr enable -y @caddy/caddy
    yum install -y caddy
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache caddy
  else
    # Static binary fallback for Linux amd64/arm64
    local arch
    arch="$(uname -m)"
    local caddy_arch="amd64"
    [[ "$arch" == "aarch64" || "$arch" == "arm64" ]] && caddy_arch="arm64"
    curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=${caddy_arch}" -o /usr/local/bin/caddy
    chmod +x /usr/local/bin/caddy
  fi
}

open_firewall_ports

if [[ "$DEPLOY_MODE" == "docker" ]]; then
  info "使用 Docker Compose 模式部署..."
  cat > "${SRC_DIR}/.env" <<EOF
SITE_ADDRESS=${DOMAIN}
TLS_DIRECTIVE=${TLS_DIRECTIVE}
ACME_EMAIL_DIRECTIVE=${ACME_EMAIL_DIRECTIVE}
HTTP_PORT=80
HTTPS_PORT=443
EOF
  (cd "$SRC_DIR" && docker compose up -d --build)
  ok "Docker 容器 mcxor-pwa 已启动！"
else
  info "使用原生 Caddy Systemd 服务模式部署..."
  install_caddy_native

  mkdir -p "$WEB_ROOT"
  rm -rf "${WEB_ROOT:?}"/*
  cp -r "${SRC_DIR}/index.html" "${SRC_DIR}/manifest.webmanifest" "${SRC_DIR}/sw.js" \
        "${SRC_DIR}/.nojekyll" "${SRC_DIR}/icons" "${SRC_DIR}/styles" "${SRC_DIR}/src" \
        "$WEB_ROOT/"
  chown -R caddy:caddy "$WEB_ROOT" 2>/dev/null || chmod -R 755 "$WEB_ROOT"

  mkdir -p /etc/caddy
  if [[ -f /etc/caddy/Caddyfile ]]; then
    cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)"
  fi

  cat > /etc/caddy/Caddyfile <<EOF
{
	${ACME_EMAIL_DIRECTIVE}
}

${DOMAIN} {
	${TLS_DIRECTIVE}
	root * ${WEB_ROOT}
	encode zstd gzip

	@sw_and_html {
		path / /index.html /sw.js /manifest.webmanifest
	}
	header @sw_and_html Cache-Control "no-cache, must-revalidate"

	@static_assets {
		path /src/* /styles/* /icons/*
	}
	header @static_assets Cache-Control "public, max-age=604800, stale-while-revalidate=86400"

	header {
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
	}

	file_server
}
EOF

  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable caddy >/dev/null 2>&1 || true
    systemctl restart caddy
  else
    caddy reload --config /etc/caddy/Caddyfile || caddy start --config /etc/caddy/Caddyfile
  fi
  ok "原生 Caddy 服务已启动并加载配置！"
fi

echo ""
echo -e "${C_GREEN}==============================================================${C_RESET}"
echo -e "${C_GREEN} 🎉 MCXOR 网易存档加解密 PWA 部署完成！${C_RESET}"
echo -e " 访问地址: ${C_CYAN}https://${DOMAIN}${C_RESET}"
if [[ "$USE_NIP" -eq 1 && "$IS_PRIVATE_NIP" -eq 0 ]]; then
  echo -e " 证书类型: ${C_GREEN}nip.io 免域名自动公网 TLS 证书 (Let's Encrypt / ZeroSSL)${C_RESET}"
  echo -e " 提示说明: 首次访问将自动完成 ACME 证书握手机制（请确保云服务器安全组已放行 TCP 80 与 443 端口）"
elif [[ "$IS_PRIVATE_NIP" -eq 1 ]]; then
  echo -e " 证书类型: ${C_YELLOW}局域网自签名 TLS 证书 (Caddy Local Authority)${C_RESET}"
else
  echo -e " 证书类型: ${C_GREEN}自定义域名自动 TLS 证书 (自动续期)${C_RESET}"
fi
echo -e "${C_GREEN}==============================================================${C_RESET}"
