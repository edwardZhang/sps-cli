#!/usr/bin/env bash
# batch_scheduler.sh — project-local sequential scheduler (Planning → Backlog)
set -euo pipefail

PROJECT_NAME="$(basename "$(cd "$(dirname "$0")" && pwd)")"
source ~/.jarvis.env
source "$HOME/.projects/$PROJECT_NAME/conf"

MPOST="bash $HOME/jarvis-skills/coding-work-flow/scripts/notify.sh"
LOG="$HOME/.projects/$PROJECT_NAME/logs/batch_scheduler.log"
mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

if [ "${PM_TOOL:-trello}" = "trello" ]; then
  TAPI="https://api.trello.com/1"
  TQ="key=$TRELLO_API_KEY&token=$TRELLO_TOKEN"
  : "${TRELLO_LIST_PLANNING:?Missing TRELLO_LIST_PLANNING}"
  : "${TRELLO_LIST_BACKLOG:?Missing TRELLO_LIST_BACKLOG}"
  : "${TRELLO_LIST_TODO:?Missing TRELLO_LIST_TODO}"
  : "${TRELLO_LIST_INPROGRESS:?Missing TRELLO_LIST_INPROGRESS}"
  : "${TRELLO_LIST_QA:?Missing TRELLO_LIST_QA}"

  active=$(python3 - <<PY
import urllib.request, json
lists=['$TRELLO_LIST_BACKLOG','$TRELLO_LIST_TODO','$TRELLO_LIST_INPROGRESS','$TRELLO_LIST_QA']
label='${PIPELINE_LABEL:-}'
total=0
for l in lists:
    url=f'$TAPI/lists/{l}/cards?$TQ&fields=id,name,labels'
    cards=json.loads(urllib.request.urlopen(url).read())
    if label:
        total += sum(1 for c in cards if any((lb.get('name') or '').strip()==label for lb in c.get('labels',[])))
    else:
        total += len(cards)
print(total)
PY
)
  log "Active pipeline tasks: $active"
  if [ "$active" -gt 0 ]; then
    log "Pipeline still busy, skip promotion"
    exit 0
  fi

  next=$(PIPELINE_LABEL="${PIPELINE_LABEL:-}" TRELLO_JSON="$(curl -s "$TAPI/lists/$TRELLO_LIST_PLANNING/cards?$TQ&fields=id,name,labels,pos")" python3 - <<'PY'
import json,os
label=os.environ.get('PIPELINE_LABEL','').strip()
obj=json.loads(os.environ.get('TRELLO_JSON','[]'))
items=[]
for c in obj:
    labels=[(lb.get('name') or '').strip() for lb in c.get('labels',[])]
    if label and label not in labels:
        continue
    items.append((c.get('pos', 10**18), c.get('id',''), c.get('name','')))
items.sort()
if items:
    _, cid, name = items[0]
    print(f"{cid}|{name}")
PY
)
  [ -z "$next" ] && { log "Planning empty, nothing to promote"; exit 0; }
  card_id="${next%%|*}"
  card_name="${next#*|}"
  curl -sf -X PUT "$TAPI/cards/$card_id?$TQ" -d "idList=$TRELLO_LIST_BACKLOG" > /dev/null
  log "Promoted: $card_name → Backlog"
  $MPOST "🚀 [$PROJECT_NAME] 推进任务：$card_name" >/dev/null 2>&1 || true
  exit 0
fi

HELPER="${PLANE_HELPER:-$HOME/.openclaw/workspace/skills/plane/scripts/plane_helper.py}"
: "${PLANE_PROJECT_ID:?Missing PLANE_PROJECT_ID}"
: "${PLANE_STATE_PLANNING:?Missing PLANE_STATE_PLANNING}"
: "${PLANE_STATE_BACKLOG:?Missing PLANE_STATE_BACKLOG}"
: "${PLANE_STATE_TODO:?Missing PLANE_STATE_TODO}"
: "${PLANE_STATE_INPROGRESS:?Missing PLANE_STATE_INPROGRESS}"
: "${PLANE_STATE_QA:?Missing PLANE_STATE_QA}"

active=$(ACTIVE_STATE_IDS="$PLANE_STATE_BACKLOG,$PLANE_STATE_TODO,$PLANE_STATE_INPROGRESS,$PLANE_STATE_QA" PIPELINE_LABEL="${PIPELINE_LABEL:-}" PIPELINE_MIN_SEQ="${PIPELINE_MIN_SEQ:-}" LABELS_JSON="$(python3 "$HELPER" labels list "$PLANE_PROJECT_ID" 2>/dev/null)" PLANE_JSON="$(python3 "$HELPER" issues list "$PLANE_PROJECT_ID" 2>/dev/null)" python3 - <<'PY'
import json,os
obj=json.loads(os.environ['PLANE_JSON'])
active=set(filter(None, os.environ.get('ACTIVE_STATE_IDS','').split(',')))
want=os.environ.get('PIPELINE_LABEL','').strip()
min_seq=(os.environ.get('PIPELINE_MIN_SEQ') or '').strip()
count=0
label_map={x.get('id'): x.get('name','') for x in json.loads(os.environ.get('LABELS_JSON','{"results":[]}')).get('results',[])}
for it in obj.get('results',[]):
    if it.get('state') not in active:
        continue
    labels=[]
    for lb in it.get('labels',[]):
        if isinstance(lb, dict):
            name=(lb.get('name') or '').strip()
        else:
            name=(label_map.get(lb,'') or '').strip()
        if name:
            labels.append(name)
    if want and want not in labels:
        continue
    if min_seq:
        try:
            if int(it.get('sequence_id') or 0) < int(min_seq):
                continue
        except Exception:
            pass
    count += 1
print(count)
PY
)
log "Active pipeline tasks: $active"
if [ "$active" -gt 0 ]; then
  log "Pipeline still busy, skip promotion"
  exit 0
fi

next=$(PIPELINE_LABEL="${PIPELINE_LABEL:-}" PIPELINE_ORDER_FILE="${PIPELINE_ORDER_FILE:-}" LABELS_JSON="$(python3 "$HELPER" labels list "$PLANE_PROJECT_ID" 2>/dev/null)" PLANE_JSON="$(python3 "$HELPER" issues list "$PLANE_PROJECT_ID" "$PLANE_STATE_PLANNING" 2>/dev/null)" python3 - <<'PY'
import json,os
obj=json.loads(os.environ['PLANE_JSON'])
label_map={x.get('id'): x.get('name','') for x in json.loads(os.environ.get('LABELS_JSON','{"results":[]}')).get('results',[])}
want=os.environ.get('PIPELINE_LABEL','').strip()
order_file=(os.environ.get('PIPELINE_ORDER_FILE') or '').strip()
seq_order=[]
if order_file and os.path.exists(order_file):
    try:
        raw=json.load(open(order_file))
        if isinstance(raw, list):
            seq_order=[int(x) for x in raw]
        else:
            seq_order=[int(x) for x in raw.get('items',[])]
    except Exception:
        seq_order=[]
items_by_seq={}
for it in obj.get('results',[]):
    labels=[]
    for lb in it.get('labels',[]):
        if isinstance(lb, dict):
            name=(lb.get('name') or '').strip()
        else:
            name=(label_map.get(lb,'') or '').strip()
        if name:
            labels.append(name)
    if want and want not in labels:
        continue
    try:
        seq_num=int(it.get('sequence_id') or 0)
    except Exception:
        continue
    items_by_seq[seq_num]=(it.get('id',''), it.get('name',''))
if seq_order:
    for seq in seq_order:
        if seq in items_by_seq:
            iid,name=items_by_seq[seq]
            print(f"{iid}|{name}")
            raise SystemExit(0)
else:
    for seq in sorted(items_by_seq):
        iid,name=items_by_seq[seq]
        print(f"{iid}|{name}")
        raise SystemExit(0)
PY
)
[ -z "$next" ] && { log "Planning empty, nothing to promote"; exit 0; }
issue_id="${next%%|*}"
issue_name="${next#*|}"
python3 "$HELPER" issues move "$PLANE_PROJECT_ID" "$issue_id" "$PLANE_STATE_BACKLOG" >/dev/null
log "Promoted: $issue_name → Backlog"
$MPOST "🚀 [$PROJECT_NAME] 推进任务：$issue_name" >/dev/null 2>&1 || true
