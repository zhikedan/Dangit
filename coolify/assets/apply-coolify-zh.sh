#!/bin/bash
set -e
SRC="/mnt/e/pc/桌面/wsl2/coolify-zh.js"
echo "===== COPY SCRIPT INTO CONTAINER ====="
docker cp "$SRC" coolify:/var/www/html/public/coolify-zh.js
docker exec -u root coolify chown www-data:www-data /var/www/html/public/coolify-zh.js
docker exec -u root coolify chmod 644 /var/www/html/public/coolify-zh.js

echo "===== PATCH BASE LAYOUT ====="
docker exec -u root coolify sh -c "grep -q 'coolify-zh.js' /var/www/html/resources/views/layouts/base.blade.php || sed -i 's|</body>|<script src=\"/coolify-zh.js\" defer></script></body>|' /var/www/html/resources/views/layouts/base.blade.php"

echo "===== CLEAR BLADE CACHE ====="
docker exec coolify php artisan view:clear

echo "===== VERIFY ====="
docker exec coolify grep -n "coolify-zh" /var/www/html/resources/views/layouts/base.blade.php
docker exec coolify ls -l /var/www/html/public/coolify-zh.js
curl -sS http://127.0.0.1:8080/login | grep -o "coolify-zh.js" | head -n 1
echo "===== DONE ====="
