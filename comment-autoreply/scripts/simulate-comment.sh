#!/usr/bin/env bash
# Sends a correctly signed fake comment webhook to the local n8n, as Meta would.
# Usage: scripts/simulate-comment.sh construr3|vasconmaz facebook|instagram "comment text" ["Commenter Name"]
# Then check n8n-data/logs/autoreply-log.csv (after the 30-90 s delay).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
brand=${1:?brand}; platform=${2:?platform}; text=${3:?text}; name=${4:-Ana Pérez}
up=$(echo "$brand" | tr a-z A-Z)
page_var="${up}_PAGE_ID"; ig_var="${up}_IG_ID"
id="sim$(date +%s)$RANDOM"
if [ "$platform" = facebook ]; then
  acct=${!page_var}
  body=$(printf '{"object":"page","entry":[{"id":"%s","time":0,"changes":[{"field":"feed","value":{"item":"comment","verb":"add","comment_id":"%s_%s","post_id":"%s_1","parent_id":"%s_1","message":%s,"from":{"id":"999000","name":%s}}}]}]}' \
    "$acct" "$acct" "$id" "$acct" "$acct" "$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$text")" "$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$name")")
else
  acct=${!ig_var}
  body=$(printf '{"object":"instagram","entry":[{"id":"%s","time":0,"changes":[{"field":"comments","value":{"id":"%s","text":%s,"from":{"id":"999000","username":"cliente_prueba"},"media":{"id":"1"}}}]}]}' \
    "$acct" "$id" "$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$text")")
fi
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$META_APP_SECRET" | sed 's/^.* //')
curl -sS -X POST "http://localhost:5678/webhook/meta-comments" \
  -H 'Content-Type: application/json' -H "X-Hub-Signature-256: sha256=$sig" --data-binary "$body"
echo; echo "sent comment $id; result lands in n8n-data/logs/autoreply-log.csv in ~30-90 s"
