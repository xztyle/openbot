#!/bin/sh
set -eu

if [ -z "${TURN_SHARED_SECRET:-}" ] || [ "${#TURN_SHARED_SECRET}" -lt 32 ]; then
  echo "TURN_SHARED_SECRET must contain at least 32 bytes." >&2
  exit 1
fi
if [ -z "${TURN_PUBLIC_IP:-}" ] || [ -z "${TURN_REALM:-}" ]; then
  echo "TURN_PUBLIC_IP and TURN_REALM are required." >&2
  exit 1
fi

# A host that runs in a container on the TURN server's own machine has only a private address as its
# direct candidate, and the denied ranges of the config refuse it. Each device then reaches that host
# only through a second allocation that the host holds on this server. Naming the container's address
# here (an address or a range, comma-separated) lets the device's relay reach the host directly.
# Only addresses are accepted, so the value cannot add other config lines.
allowed_peer_ips=""
if [ -n "${TURN_ALLOWED_PEER_IPS:-}" ]; then
  for ip in $(printf '%s' "$TURN_ALLOWED_PEER_IPS" | tr ',' ' '); do
    case "$ip" in
      *[!0-9A-Fa-f.:-]*)
        echo "TURN_ALLOWED_PEER_IPS must list IP addresses or ranges." >&2
        exit 1
        ;;
    esac
    allowed_peer_ips="${allowed_peer_ips}allowed-peer-ip=${ip}
"
  done
fi

runtime_config="/tmp/openbot-turnserver.conf"
cp /etc/coturn/openbot.conf "$runtime_config"
{
  echo "external-ip=${TURN_PUBLIC_IP}"
  echo "realm=${TURN_REALM}"
  echo "server-name=${TURN_REALM}"
  # coturn checks the allowed list before the denied ranges.
  printf '%s' "$allowed_peer_ips"
  echo "static-auth-secret=${TURN_SHARED_SECRET}"
  if [ -n "${TURN_MIN_PORT:-}" ]; then
    echo "min-port=${TURN_MIN_PORT}"
  fi
  if [ -n "${TURN_MAX_PORT:-}" ]; then
    echo "max-port=${TURN_MAX_PORT}"
  fi
  if [ -n "${TURN_TLS_CERT_PATH:-}" ] && [ -n "${TURN_TLS_KEY_PATH:-}" ]; then
    echo "cert=${TURN_TLS_CERT_PATH}"
    echo "pkey=${TURN_TLS_KEY_PATH}"
  else
    echo "no-tls"
    echo "no-dtls"
  fi
} >> "$runtime_config"

turnserver -c "$runtime_config" &
turn_pid=$!

forward_term() { kill -TERM "$turn_pid" 2>/dev/null || true; }
forward_drain() { kill -USR1 "$turn_pid" 2>/dev/null || true; }
forward_cert_reload() { kill -USR2 "$turn_pid" 2>/dev/null || true; }
trap forward_term INT TERM
trap forward_drain USR1
trap forward_cert_reload USR2

if [ -n "${TURN_TLS_CERT_PATH:-}" ]; then
  (
    previous=""
    while kill -0 "$turn_pid" 2>/dev/null; do
      current="$(sha256sum "$TURN_TLS_CERT_PATH" 2>/dev/null | cut -d ' ' -f 1 || true)"
      if [ -n "$previous" ] && [ -n "$current" ] && [ "$current" != "$previous" ]; then
        kill -USR2 "$turn_pid" 2>/dev/null || true
      fi
      previous="$current"
      sleep 300
    done
  ) &
fi

wait "$turn_pid"
