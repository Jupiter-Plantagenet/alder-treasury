#!/usr/bin/env bash
# Round 6: generate the LOCAL test CA + 127.0.0.1/localhost server certificate + proxy secret + login device-cookie key
# under .local/tls/ (git-ignored). Keys never leave .local/ and are never printed. The CA is NOT installed in the OS
# trust store: Node test clients add it via tests/tls-trust.ts, Vite/release proxies pin it for the API hop, and test
# browsers accept it per Playwright context (Chromium can instead pin the leaf SPKI in .local/tls/server.spki).
# Idempotent: refuses to overwrite existing material (delete .local/tls explicitly to rotate).
set -euo pipefail; export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."; d=.local/tls; mkdir -p "$d"; cd "$d"
[ -f ca.key ] && { echo "TLS material exists in $d (not overwritten)"; exit 0; }
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ca.key -out ca.pem -days 90 -subj "/CN=Alder Local Test CA (round6, not system-installed)" -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout server.key -out server.csr -subj "/CN=127.0.0.1" 2>/dev/null
printf "subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n" > leaf.ext
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out server.pem -days 60 -extfile leaf.ext 2>/dev/null
openssl rand -hex 32 > proxy-secret; openssl rand -hex 32 > device-key
openssl x509 -in server.pem -noout -pubkey | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl enc -base64 > server.spki
openssl verify -CAfile ca.pem server.pem
