#!/usr/bin/env bash
# Run once after creating the bucket: R2 deletes daily backups after 30 days and monthly ones after 365 days.
# (The same two rules can be added by hand in the Cloudflare dashboard: R2 › bucket › Settings › Object lifecycle rules.)
. "$(dirname "$0")/lib.sh"
need R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
s3 s3api put-bucket-lifecycle-configuration --bucket "$R2_BUCKET" --lifecycle-configuration '{"Rules":[
  {"ID":"medlink-daily-30d","Status":"Enabled","Filter":{"Prefix":"postgres/daily/"},"Expiration":{"Days":30}},
  {"ID":"medlink-monthly-365d","Status":"Enabled","Filter":{"Prefix":"postgres/monthly/"},"Expiration":{"Days":365}}]}'
s3 s3api get-bucket-lifecycle-configuration --bucket "$R2_BUCKET" --output json
