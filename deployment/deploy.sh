#!/usr/bin/env bash
# Macからsshのstdin経由で渡されるLightsail用deploy script。remoteに旧scriptが無い初回でも動く。
# 秘密値は受け取らず、/etc/yori/yori.envをdocker compose --env-fileで参照するだけにする。
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "deploy: usage: bash -s -- <40-hex-sha>" >&2
  exit 2
fi
TARGET="$1"
if [[ ! "$TARGET" =~ ^[0-9a-f]{40}$ ]]; then
  echo "deploy: targetは40桁hexのGit SHAで指定する" >&2
  exit 2
fi

REPO=/srv/yori
LOCK="$REPO/.git/yori-deploy.lock"

# flockで同時deployを拒否する。lock下の本体はこのscript自身のstdinではなく、渡したSHAを$1に持つbashで実行する。
flock -n "$LOCK" bash -s -- "$TARGET" <<'DEPLOY_BODY'
set -euo pipefail

REPO=/srv/yori
ENV_FILE=/etc/yori/yori.env
TARGET="$1"

cd "$REPO"

# remoteに未commitのtracked/staged/untracked変更があれば、そのsourceを配布しない。
REMOTE_DIRTY="$(git status --porcelain=v1 --untracked-files=all)"
if [ -n "$REMOTE_DIRTY" ]; then
  echo "deploy: remote worktreeがdirty。deployを中止する" >&2
  exit 1
fi

OLD_SHA="$(git rev-parse --verify HEAD^{commit})"

git fetch origin main

# targetが実在し、origin/mainに含まれ、現在HEADからfast-forwardできる時だけ進む。
git cat-file -e "${TARGET}^{commit}"
git merge-base --is-ancestor "$TARGET" origin/main
git merge-base --is-ancestor "$OLD_SHA" "$TARGET"

git merge --ff-only "$TARGET"
NEW_SHA="$(git rev-parse --verify HEAD^{commit})"
if [ "$NEW_SHA" != "$TARGET" ]; then
  echo "deploy: merge後のHEADがtargetと一致しない" >&2
  exit 1
fi

# /etc/yori/yori.envはroot:root 0600だけを許可する。値は読まずに所有とmodeだけを見る。
ENV_PERMS="$(sudo stat -c '%U:%G %a' "$ENV_FILE" 2>/dev/null || true)"
if [ "$ENV_PERMS" != 'root:root 600' ]; then
  echo "deploy: $ENV_FILE はroot:root 0600でない" >&2
  exit 1
fi

# 配布対象SHAをCompose interpolationへ渡し、api・workerの実行環境へ固定する。
export YORI_RELEASE_SHA="$TARGET"

# 設定検査が失敗したらpull以降へ進まない。migration/config/pull/db失敗時は再作成しない。
sudo docker compose --env-file "$ENV_FILE" -p yori -f deployment/compose.yaml config --quiet
sudo docker compose --env-file "$ENV_FILE" -p yori -f deployment/compose.yaml pull
sudo docker compose --env-file "$ENV_FILE" -p yori -f deployment/compose.yaml up -d --wait db
sudo docker compose --env-file "$ENV_FILE" -p yori -f deployment/compose.yaml --profile tools run --rm migrate

# migration成功後だけ旧api・workerを明示削除する。--force-recreateの判定に依存せず旧Node processを停止する。
OLD_API_ID="$(sudo docker compose --env-file "$ENV_FILE" -p yori -f deployment/compose.yaml ps -q api)"
OLD_WORKER_ID="$(sudo docker compose --env-file "$ENV_FILE" -p yori -f deployment/compose.yaml ps -q worker)"
sudo docker compose --env-file "$ENV_FILE" -p yori -f deployment/compose.yaml rm -sf worker api
sudo docker compose --env-file "$ENV_FILE" -p yori -f deployment/compose.yaml up -d --wait --no-deps api
sudo docker compose --env-file "$ENV_FILE" -p yori -f deployment/compose.yaml up -d --wait --no-deps worker
sudo docker compose --env-file "$ENV_FILE" -p yori -f deployment/compose.yaml --profile production up -d --wait --force-recreate --no-deps caddy

NEW_API_ID="$(sudo docker compose --env-file "$ENV_FILE" -p yori -f deployment/compose.yaml ps -q api)"
NEW_WORKER_ID="$(sudo docker compose --env-file "$ENV_FILE" -p yori -f deployment/compose.yaml ps -q worker)"
if [ -z "$NEW_API_ID" ] || [ -z "$NEW_WORKER_ID" ]; then
  echo "deploy: apiまたはworkerの新container IDを取得できない" >&2
  exit 1
fi
if { [ -n "$OLD_API_ID" ] && [ "$OLD_API_ID" = "$NEW_API_ID" ]; } || \
   { [ -n "$OLD_WORKER_ID" ] && [ "$OLD_WORKER_ID" = "$NEW_WORKER_ID" ]; }; then
  echo "deploy: apiまたはworkerのcontainer IDが更新されていない" >&2
  exit 1
fi
sudo docker compose --env-file "$ENV_FILE" -p yori -f deployment/compose.yaml exec -T api \
  sh -c 'test "$YORI_RELEASE_SHA" = "$1"' sh "$TARGET"
sudo docker compose --env-file "$ENV_FILE" -p yori -f deployment/compose.yaml exec -T worker \
  sh -c 'test "$YORI_RELEASE_SHA" = "$1"' sh "$TARGET"

# composeが公開するloopback addressへhealth/readyを確認する。
PORT_BINDING="$(sudo docker compose --env-file "$ENV_FILE" -p yori -f deployment/compose.yaml port api 3210 | head -n 1)"
PORT_ADDR="${PORT_BINDING%:*}"
PORT_NUM="${PORT_BINDING##*:}"
case "$PORT_ADDR" in
  127.0.0.1|'[::1]'|::1) ;;
  *)
    echo "deploy: apiの公開portがloopbackでない" >&2
    exit 1
    ;;
esac
HEALTH_BODY="$(curl -fsS "http://${PORT_ADDR}:${PORT_NUM}/health/ready")"
EXPECTED_HEALTH="{\"status\":\"ready\",\"release_sha\":\"${TARGET}\",\"api_contract_version\":1}"
if [ "$HEALTH_BODY" != "$EXPECTED_HEALTH" ]; then
  echo "deploy: healthのrelease SHAまたはAPI契約versionが一致しない" >&2
  exit 1
fi

# 認証前にrouteが存在することを、正規の401応答で確認する。Fastifyのroute-not-foundは成功扱いしない。
SMOKE_BODY="$(mktemp)"
trap 'rm -f "$SMOKE_BODY"' EXIT
SMOKE_STATUS="$(curl -sS -o "$SMOKE_BODY" -w '%{http_code}' -X POST -H 'content-type: application/json' \
  --data '{"repository":"github.com/yori/deployment-smoke"}' \
  "http://${PORT_ADDR}:${PORT_NUM}/v1/collector/setup")"
if [ "$SMOKE_STATUS" != '401' ] || [ "$(<"$SMOKE_BODY")" != '{"error":{"code":"unauthorized"}}' ]; then
  echo "deploy: collector setup smokeが正規401を返さない" >&2
  exit 1
fi

echo "deploy: old=$OLD_SHA new=$NEW_SHA"
sudo docker compose --env-file "$ENV_FILE" -p yori -f deployment/compose.yaml ps
DEPLOY_BODY
