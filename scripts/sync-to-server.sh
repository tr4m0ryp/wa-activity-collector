#!/usr/bin/env bash
# Sync locally-paired auth state and DB up to the GCP VM.
# Run after pairing an account in the local UI (http://localhost:3000).
# This makes the server's Baileys session inherit the linked-device entry
# that was established from your residential IP.

set -euo pipefail

VM_NAME="${VM_NAME:-wa-collector}"
ZONE="${ZONE:-europe-west4-a}"
REMOTE_DIR="${REMOTE_DIR:-/opt/wa-collector}"

if [ ! -d ./data ]; then
  echo "no local ./data directory — pair an account locally first (npm start, http://localhost:3000)" >&2
  exit 1
fi

echo "stopping remote service..."
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --quiet -- sudo systemctl stop wa-collector

echo "copying data/ up..."
gcloud compute scp --recurse --zone="$ZONE" --quiet ./data "$VM_NAME:$REMOTE_DIR/"

echo "fixing perms and starting..."
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --quiet -- \
  "sudo chown -R \$(whoami):\$(whoami) $REMOTE_DIR/data && sudo systemctl start wa-collector && sleep 3 && sudo systemctl is-active wa-collector"

echo "done. tunnel and check:"
echo "  gcloud compute ssh $VM_NAME --zone=$ZONE -- -L 3000:localhost:3000 -N"
echo "  then open http://localhost:3000"
