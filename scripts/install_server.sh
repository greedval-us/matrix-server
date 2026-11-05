#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${MATRIX_PROJECT_ROOT:-/opt/matrix}"
DATA_ROOT="${MANTICORE_DATA_DIR:-/var/lib/matrix}"
SOURCE_DATABASE="${SOURCE_MYSQL_DATABASE:-source_data}"
CONFIG_ROOT="/etc/matrix-search"
MANTICORE_CONFIG="${DATA_ROOT}/state/manticore.conf"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash scripts/install_server.sh" >&2
  exit 1
fi

for command in mariadb indexer indextool searchd node python3 openssl runuser; do
  command -v "${command}" >/dev/null || {
    echo "Required command is missing: ${command}" >&2
    exit 1
  }
done

if [[ ! -f "${PROJECT_ROOT}/node/main.mjs" ]]; then
  echo "Matrix server files are missing under ${PROJECT_ROOT}" >&2
  exit 1
fi

if [[ ! "${SOURCE_DATABASE}" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "SOURCE_MYSQL_DATABASE must be a SQL identifier" >&2
  exit 1
fi
if ! id -u matrix >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "${PROJECT_ROOT}" --no-create-home --shell /usr/sbin/nologin matrix
fi

existing_value() {
  local file="$1"
  local name="$2"
  [[ -f "${file}" ]] || return 0
  sed -n "s/^${name}=//p" "${file}" | head -n 1
}

# The directory is traversable but not listable; each env file still has its own group and 0640 mode.
install -d -m 0751 -o root -g root "${CONFIG_ROOT}"
install -d -m 0750 -o manticore -g manticore \
  "${DATA_ROOT}" "${DATA_ROOT}/indexes" "${DATA_ROOT}/log" \
  "${DATA_ROOT}/runtime" "${DATA_ROOT}/state"
# gRPC can read the world-readable checkpoint by name, but cannot list Manticore directories.
chmod 0751 "${DATA_ROOT}" "${DATA_ROOT}/state"
reader_password="$(existing_value "${CONFIG_ROOT}/indexer.env" MYSQL_PASSWORD)"
api_key="$(existing_value "${CONFIG_ROOT}/grpc.env" MATRIX_API_KEY)"
reader_password="${reader_password:-$(openssl rand -hex 32)}"
api_key="${api_key:-$(openssl rand -hex 32)}"
lan_ip="$(hostname -I | awk '{print $1}')"
if [[ -z "${lan_ip}" ]]; then
  echo "Could not determine the server LAN address" >&2
  exit 1
fi

install -d -m 0751 -o root -g root "${CONFIG_ROOT}/tls"
if [[ ! -s "${CONFIG_ROOT}/tls/server.key" || ! -s "${CONFIG_ROOT}/tls/server.crt" ]]; then
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 \
    -subj "/CN=$(hostname)" \
    -addext "subjectAltName=DNS:$(hostname),IP:127.0.0.1,IP:${lan_ip}" \
    -keyout "${CONFIG_ROOT}/tls/server.key" \
    -out "${CONFIG_ROOT}/tls/server.crt"
fi
chown root:matrix "${CONFIG_ROOT}/tls/server.key"
chmod 0640 "${CONFIG_ROOT}/tls/server.key"
chown root:root "${CONFIG_ROOT}/tls/server.crt"
chmod 0644 "${CONFIG_ROOT}/tls/server.crt"

mariadb <<SQL
CREATE USER IF NOT EXISTS 'manticore_reader'@'127.0.0.1' IDENTIFIED BY '${reader_password}';
ALTER USER 'manticore_reader'@'127.0.0.1' IDENTIFIED BY '${reader_password}';
GRANT SELECT ON \`${SOURCE_DATABASE}\`.* TO 'manticore_reader'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

cat >"${CONFIG_ROOT}/indexer.env" <<EOF
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=manticore_reader
MYSQL_PASSWORD=${reader_password}
MYSQL_DATABASE=${SOURCE_DATABASE}
MYSQL_CATALOG_TABLE=data_base
MANTICORE_DATA_DIR=${DATA_ROOT}
MANTICORE_CONFIG=${MANTICORE_CONFIG}
MANTICORE_ROWS_PER_SHARD=40000000
MANTICORE_SOURCE_CHUNK_ROWS=20000000
MANTICORE_RANGE_STEP=500000
MANTICORE_INDEXER_MEM_LIMIT=2047M
EOF
chown root:manticore "${CONFIG_ROOT}/indexer.env"
chmod 0640 "${CONFIG_ROOT}/indexer.env"

cat >"${CONFIG_ROOT}/grpc.env" <<EOF
MATRIX_API_KEY=${api_key}
MATRIX_GRPC_HOST=${lan_ip}
MATRIX_GRPC_PORT=50051
MATRIX_GRPC_ENDPOINT=${lan_ip}:50051
MATRIX_GRPC_TLS_CERT=${CONFIG_ROOT}/tls/server.crt
MATRIX_GRPC_TLS_KEY=${CONFIG_ROOT}/tls/server.key
MATRIX_GRPC_TLS_CA=${CONFIG_ROOT}/tls/server.crt
MANTICORE_URL=http://127.0.0.1:9308
MANTICORE_TABLE=matrix_records
MANTICORE_INDEX_STATE=${DATA_ROOT}/state/indexer.json
MATRIX_DATABASE_CATALOG=${DATA_ROOT}/state/database-catalog.json
MATRIX_SEARCH_PAGE_SIZE=1000
MATRIX_MAX_QUERY_TIME_MS=5000
MATRIX_MAX_CONCURRENT_SEARCHES=16
EOF
chown root:matrix "${CONFIG_ROOT}/grpc.env"
chmod 0640 "${CONFIG_ROOT}/grpc.env"

install -m 0644 "${PROJECT_ROOT}/systemd/matrix-search-grpc.service" \
  /etc/systemd/system/matrix-search-grpc.service
install -m 0644 "${PROJECT_ROOT}/systemd/matrix-manticore-indexer.service" \
  /etc/systemd/system/matrix-manticore-indexer.service
install -d -m 0755 -o root -g root /usr/local/lib/matrix-search
install -m 0755 -o root -g root \
  "${PROJECT_ROOT}/scripts/build_manticore_indexes.py" \
  /usr/local/lib/matrix-search/build_manticore_indexes.py
install -d -m 0755 /etc/systemd/system/matrix-search-grpc.service.d
cat >/etc/systemd/system/matrix-search-grpc.service.d/paths.conf <<EOF
[Service]
WorkingDirectory=${PROJECT_ROOT}
ExecStart=
ExecStart=/usr/bin/node "${PROJECT_ROOT}/node/main.mjs"
EOF
install -d -m 0755 /etc/systemd/system/manticore.service.d
cat >/etc/systemd/system/manticore.service.d/matrix.conf <<EOF
[Service]
ExecStart=
ExecStart=/usr/bin/searchd --config ${MANTICORE_CONFIG}
ExecStop=
ExecStop=/usr/bin/searchd --config ${MANTICORE_CONFIG} --stopwait
EOF

set -a
# shellcheck disable=SC1091
source "${CONFIG_ROOT}/indexer.env"
set +a
systemctl stop matrix-manticore-indexer.service 2>/dev/null || true
indexer_init_args=(--init-config)
if [[ "${MATRIX_CLEAN_INDEXES:-0}" == "1" ]]; then
  indexer_init_args+=(--clean)
fi
runuser -u manticore --preserve-environment -- \
  /usr/bin/python3 /usr/local/lib/matrix-search/build_manticore_indexes.py "${indexer_init_args[@]}"
runuser -u manticore --preserve-environment -- \
  /usr/bin/python3 /usr/local/lib/matrix-search/build_manticore_indexes.py --check-config

systemctl daemon-reload
systemctl enable manticore.service matrix-search-grpc.service
systemctl restart manticore.service
systemctl restart matrix-search-grpc.service
systemctl enable matrix-manticore-indexer.service

echo "Matrix search server is installed."
echo "TLS gRPC endpoint: $(hostname):50051 (${lan_ip})"
echo "API key is stored in ${CONFIG_ROOT}/grpc.env."
echo "Client CA certificate: ${CONFIG_ROOT}/tls/server.crt"
echo "Start indexing: sudo systemctl start matrix-manticore-indexer.service"
