FROM caddy:2-alpine

WORKDIR /srv/mcxor

# Copy static PWA application files
COPY index.html manifest.webmanifest sw.js .nojekyll LICENSE ./
COPY icons ./icons
COPY styles ./styles
COPY src ./src

# Copy Caddy configuration supporting custom DOMAIN or <IP>.nip.io auto-TLS
COPY deploy/Caddyfile /etc/caddy/Caddyfile

EXPOSE 80 443 443/udp
