#!/usr/bin/env bash
# End-to-end smoke test for the SummarAI app.
#
# Runs against http://localhost:3000 (the dev server) and exercises every
# public endpoint + auth flow. Exits non-zero on any failure.
#
# Usage: bash scripts/e2e-smoke.sh

set -uo pipefail

BASE="${BASE_URL:-http://localhost:3000}"
PASS=0
FAIL=0
COOKIE_JAR=$(mktemp)

# ---------- helpers ----------
hr() { printf '\n──────── %s ────────\n' "$1"; }
ok()  { PASS=$((PASS+1)); printf '  ✓ %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  ✗ %s\n    got: %s\n' "$1" "${2:-<no detail>}"; }

check_status() {
  local expected="$1" label="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then ok "$label (HTTP $actual)";
  else bad "$label — expected $expected" "got $actual"; fi
}

# ---------- 1. Health ----------
hr "1. Health check"
STATUS=$(curl -s -o /tmp/health.json -w '%{http_code}' "$BASE/api/health")
check_status 200 "GET /api/health" "$STATUS"
if grep -q '"status":"ok"' /tmp/health.json 2>/dev/null; then
  ok "health JSON contains status=ok"
else
  bad "health JSON missing status=ok" "$(cat /tmp/health.json)"
fi
if grep -q '"db":{"ok":true' /tmp/health.json 2>/dev/null; then
  ok "health JSON shows DB connected"
else
  bad "health JSON shows DB not ok" "$(cat /tmp/health.json)"
fi

# ---------- 2. Email/password signup ----------
hr "2. Email/password signup"
TIMESTAMP=$(date +%s)
EMAIL="e2e-${TIMESTAMP}@example.com"
PASSWORD="password123"
NAME="E2E Tester"
STATUS=$(curl -s -o /tmp/signup.json -w '%{http_code}' -c "$COOKIE_JAR" \
  -X POST "$BASE/api/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"$NAME\"}")
check_status 200 "POST /api/auth/signup (new user)" "$STATUS"
if grep -q '"user":' /tmp/signup.json && grep -q "\"email\":\"$EMAIL\"" /tmp/signup.json; then
  ok "signup returned user with correct email"
else
  bad "signup response missing user/email" "$(cat /tmp/signup.json)"
fi

# ---------- 3. Session cookie set + /api/auth/me ----------
hr "3. Session cookie + /api/auth/me"
STATUS=$(curl -s -o /tmp/me.json -w '%{http_code}' -b "$COOKIE_JAR" "$BASE/api/auth/me")
check_status 200 "GET /api/auth/me (with session cookie)" "$STATUS"
if grep -q "\"email\":\"$EMAIL\"" /tmp/me.json; then
  ok "/api/auth/me returned the correct user"
else
  bad "/api/auth/me didn't return correct user" "$(cat /tmp/me.json)"
fi

# ---------- 4. Duplicate signup rejected ----------
hr "4. Duplicate signup rejected"
STATUS=$(curl -s -o /tmp/dup.json -w '%{http_code}' \
  -X POST "$BASE/api/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"$NAME\"}")
check_status 409 "POST /api/auth/signup (duplicate)" "$STATUS"

# ---------- 5. Logout ----------
hr "5. Logout"
STATUS=$(curl -s -o /tmp/logout.json -w '%{http_code}' -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
  -X POST "$BASE/api/auth/logout")
check_status 200 "POST /api/auth/logout" "$STATUS"
# After logout, /api/auth/me should return 200 with user:null
# (the endpoint intentionally returns 200 instead of 401 — frontend checks
# the `user` field in the response body, not the HTTP status)
STATUS=$(curl -s -o /tmp/me-after-logout.json -w '%{http_code}' -b "$COOKIE_JAR" "$BASE/api/auth/me")
check_status 200 "GET /api/auth/me (after logout)" "$STATUS"
if grep -q '"user":null' /tmp/me-after-logout.json; then
  ok "/api/auth/me returns user:null after logout"
else
  bad "/api/auth/me didn't return user:null after logout" "$(cat /tmp/me-after-logout.json)"
fi

# ---------- 6. Email/password login (correct password) ----------
hr "6. Email/password login"
STATUS=$(curl -s -o /tmp/login.json -w '%{http_code}' -c "$COOKIE_JAR" \
  -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
check_status 200 "POST /api/auth/login (correct password)" "$STATUS"
if grep -q "\"email\":\"$EMAIL\"" /tmp/login.json; then
  ok "login returned correct user"
else
  bad "login response missing user" "$(cat /tmp/login.json)"
fi

# ---------- 7. Login with wrong password ----------
hr "7. Login with wrong password"
STATUS=$(curl -s -o /tmp/wrong.json -w '%{http_code}' \
  -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"wrongpassword\"}")
check_status 401 "POST /api/auth/login (wrong password)" "$STATUS"

# ---------- 8. Email-direct (passwordless) ----------
hr "8. Email-direct (passwordless) — new user"
DIRECT_EMAIL="direct-${TIMESTAMP}@example.com"
STATUS=$(curl -s -o /tmp/direct1.json -w '%{http_code}' -c "$COOKIE_JAR" \
  -X POST "$BASE/api/auth/email-direct" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$DIRECT_EMAIL\"}")
check_status 200 "POST /api/auth/email-direct (new user)" "$STATUS"
if grep -q '"createdNew":true' /tmp/direct1.json; then
  ok "email-direct created new user"
else
  bad "email-direct did not create new user" "$(cat /tmp/direct1.json)"
fi

# 8b. Same email again → should NOT create new
hr "8b. Email-direct — returning user"
STATUS=$(curl -s -o /tmp/direct2.json -w '%{http_code}' \
  -X POST "$BASE/api/auth/email-direct" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$DIRECT_EMAIL\"}")
check_status 200 "POST /api/auth/email-direct (returning user)" "$STATUS"
if grep -q '"createdNew":false' /tmp/direct2.json; then
  ok "email-direct reused existing user"
else
  bad "email-direct created a second account" "$(cat /tmp/direct2.json)"
fi

# 8c. /api/auth/email-direct/enabled returns {enabled:true}
hr "8c. Email-direct enabled flag"
STATUS=$(curl -s -o /tmp/enabled.json -w '%{http_code}' "$BASE/api/auth/email-direct/enabled")
check_status 200 "GET /api/auth/email-direct/enabled" "$STATUS"
if grep -q '"enabled":true' /tmp/enabled.json; then
  ok "enabled endpoint returns true"
else
  bad "enabled endpoint didn't return true" "$(cat /tmp/enabled.json)"
fi

# ---------- 9. Input validation ----------
hr "9. Input validation"
# 9a. Invalid email on signup
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/signup" \
  -H "Content-Type: application/json" -d '{"email":"not-an-email","password":"abcdef","name":"x"}')
check_status 400 "signup rejects invalid email" "$STATUS"
# 9b. Short password on signup
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/signup" \
  -H "Content-Type: application/json" -d '{"email":"x@y.com","password":"abc","name":"x"}')
check_status 400 "signup rejects short password" "$STATUS"
# 9c. Invalid email on email-direct
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/email-direct" \
  -H "Content-Type: application/json" -d '{"email":"not-an-email"}')
check_status 400 "email-direct rejects invalid email" "$STATUS"
# 9d. Empty body
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/email-direct" \
  -H "Content-Type: application/json" -d '{}')
check_status 400 "email-direct rejects empty body" "$STATUS"

# ---------- 10. Body size limit ----------
hr "10. Body size limit (>4 KB rejected on email-direct)"
BIG=$(printf 'x%.0s' {1..6000})
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/email-direct" \
  -H "Content-Type: application/json" -d "{\"email\":\"$BIG@x.com\"}")
check_status 413 "email-direct rejects oversized body" "$STATUS"

# ---------- 11. Security headers ----------
hr "11. Security headers (set by Edge middleware)"
HEADERS=$(curl -sI "$BASE/" )
for h in "x-content-type-options: nosniff" "x-frame-options: DENY" "referrer-policy: strict-origin-when-cross-origin"; do
  if echo "$HEADERS" | grep -qi "$h"; then
    ok "header present: $h"
  else
    bad "header missing: $h"
  fi
done

# ---------- 12. Authenticated route protection ----------
# /api/auth/me without cookie → 200 with user:null (by design)
hr "12. Authenticated routes protected"
STATUS=$(curl -s -o /tmp/me-anon.json -w '%{http_code}' "$BASE/api/auth/me")
check_status 200 "GET /api/auth/me (no cookie) returns 200" "$STATUS"
if grep -q '"user":null' /tmp/me-anon.json; then
  ok "/api/auth/me returns user:null when no session"
else
  bad "/api/auth/me didn't return user:null when no session" "$(cat /tmp/me-anon.json)"
fi
rm -f /tmp/me-anon.json

# ---------- Summary ----------
hr "SUMMARY"
printf '  Pass: %d\n  Fail: %d\n' "$PASS" "$FAIL"
rm -f "$COOKIE_JAR" /tmp/health.json /tmp/signup.json /tmp/me.json /tmp/dup.json \
      /tmp/logout.json /tmp/me-after-logout.json /tmp/login.json /tmp/wrong.json \
      /tmp/direct1.json /tmp/direct2.json /tmp/enabled.json 2>/dev/null

if [ "$FAIL" -gt 0 ]; then exit 1; fi
exit 0
