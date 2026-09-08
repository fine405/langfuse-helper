#!/bin/sh
cd -- "$(dirname -- "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  printf '请先安装 Node.js 24 或更新版本：https://nodejs.org/\n安装后重新打开本文件。\n'
  read -r answer
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  printf '需要 Node.js 24 或更新版本，请更新后重试：https://nodejs.org/\n'
  read -r answer
  exit 1
fi
node scripts/install.mjs
result=$?
printf '\n按回车关闭窗口…'
read -r answer
exit "$result"
