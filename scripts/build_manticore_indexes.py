#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


SEARCH_FIELDS = (
    "number", "mail", "snils", "inn", "passport", "fio", "date_of_birth",
    "telegram", "vk", "facebook", "imsi", "imei", "grz", "vin",
)
CATALOG_FIELDS = (
    "id", "name_table", "name", "info", "relevance_date", "country",
    "access_level", "type", "trust", "count", "search_mail", "search_fio",
    "search_number", "search_telegram", "search_passport", "search_snils",
    "search_inn", "search_imei", "search_imsi", "search_facebook", "search_vk",
    "search_grz", "search_vin", "updated_at", "created_at",
)
BINARY_TYPES = {"binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob"}
INTEGER_TYPES = {"tinyint", "smallint", "mediumint", "int", "integer", "bigint"}
INDEX_SCHEMA_VERSION = 3
DOCUMENT_ID_SHIFT = 32
MAX_SOURCE_ROW_ID = (1 << DOCUMENT_ID_SHIFT) - 1
IDENTIFIER = re.compile(r"^[A-Za-z0-9_]+$")
STOP_REQUESTED = False
ACTIVE_PROCESS = None


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def config_value(name: str, value: str, *, path: bool = False) -> str:
    # Config directives are deliberately single-line, unquoted values. Reject
    # comment/block/escape syntax rather than silently changing a credential.
    if not value or any(ord(char) < 32 for char in value) or any(char in value for char in '#{}'):
        raise RuntimeError(f"Unsafe configuration value: {name}")
    if not path and ("\\" in value or value != value.strip()):
        raise RuntimeError(f"Unsafe configuration value: {name}")
    return value


def password_from_environment(*names: str, default: str | None = None) -> str:
    for name in names:
        filename = os.getenv(name + "_FILE")
        if filename:
            try:
                return Path(filename).read_text(encoding="utf-8").rstrip("\r\n")
            except OSError as error:
                raise RuntimeError(f"Cannot read {name}_FILE") from error
        if os.getenv(name):
            return os.environ[name]
    if default is not None:
        return default
    raise RuntimeError(f"Missing required environment variable: {names[0]}")


def positive_number(name: str, default: str, *, integer: bool = True):
    try:
        value = int(os.getenv(name, default)) if integer else float(os.getenv(name, default))
    except ValueError as error:
        raise RuntimeError(f"{name} must be a positive number") from error
    if not 0 < value < float("inf"):
        raise RuntimeError(f"{name} must be a positive number")
    return value


def load_settings(bootstrap: bool = False) -> dict:
    data_dir = Path(config_value("MANTICORE_DATA_DIR", os.getenv(
        "MANTICORE_DATA_DIR", "/var/lib/matrix"), path=True)).resolve()
    active_config = os.getenv("MANTICORE_CONFIG", "/etc/manticoresearch/manticore.conf")
    pid_file = os.getenv("MANTICORE_PID_FILE", "/run/manticore/searchd.pid")
    settings = {
        "data_dir": data_dir,
        "indexes_dir": data_dir / "indexes",
        "log_dir": data_dir / "log",
        "state_path": data_dir / "state" / "indexer.json",
        "plan_path": data_dir / "state" / "index-plan.json",
        "catalog_path": data_dir / "state" / "database-catalog.json",
        "lock_path": data_dir / "private" / "indexer.lock",
        "indexer_config": data_dir / "private" / "current-indexer.conf",
        "active_config": Path(config_value("MANTICORE_CONFIG", active_config, path=True)),
        "pid_file": Path(config_value("MANTICORE_PID_FILE", pid_file, path=True)),
        "listen_host": os.getenv("MANTICORE_LISTEN_HOST", "127.0.0.1"),
        "reload_url": os.getenv("MANTICORE_RELOAD_URL", ""),
        "reload_timeout": positive_number("MANTICORE_RELOAD_TIMEOUT", "30", integer=False),
        "reload_poll_interval": positive_number("MANTICORE_RELOAD_POLL_INTERVAL", "0.25", integer=False),
    }
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", settings["listen_host"]):
        raise RuntimeError("Invalid MANTICORE_LISTEN_HOST")
    if settings["reload_url"]:
        url = urlsplit(settings["reload_url"])
        if (url.scheme not in ("http", "https") or not url.hostname or url.username
                or url.password or url.path not in ("", "/") or url.query or url.fragment):
            raise RuntimeError("MANTICORE_RELOAD_URL must be an HTTP origin")
    if bootstrap:
        return settings

    for field, default in (("host", "127.0.0.1"), ("port", "3306"),
                           ("user", ""), ("database", "source_data")):
        name = "SOURCE_MYSQL_" + field.upper()
        value = os.getenv(name) or os.getenv("MYSQL_" + field.upper(), default)
        settings["mysql_" + field] = config_value(name, value)
    settings["mysql_password"] = config_value("SOURCE_MYSQL_PASSWORD", password_from_environment(
        "SOURCE_MYSQL_PASSWORD", "MYSQL_PASSWORD"))
    catalog = {}
    for field in ("host", "port", "user", "database"):
        name = "CATALOG_MYSQL_" + field.upper()
        catalog["mysql_" + field] = config_value(name, os.getenv(name) or str(settings["mysql_" + field]))
    catalog["mysql_password"] = config_value("CATALOG_MYSQL_PASSWORD", password_from_environment(
        "CATALOG_MYSQL_PASSWORD", default=settings["mysql_password"]))
    for connection in (settings, catalog):
        try:
            connection["mysql_port"] = int(connection["mysql_port"])
        except ValueError as error:
            raise RuntimeError("MySQL port must be an integer") from error
        if not 0 < connection["mysql_port"] <= 65535:
            raise RuntimeError("MySQL port must be between 1 and 65535")
        quote_identifier(connection["mysql_database"])
    settings.update({
        "catalog_connection": catalog,
        "catalog_table": os.getenv("MYSQL_CATALOG_TABLE", "data_base"),
        "rows_per_shard": positive_number("MANTICORE_ROWS_PER_SHARD", "40000000"),
        "source_chunk_rows": positive_number("MANTICORE_SOURCE_CHUNK_ROWS", "20000000"),
        "range_step": positive_number("MANTICORE_RANGE_STEP", "500000"),
        "indexer_mem_limit": os.getenv("MANTICORE_INDEXER_MEM_LIMIT", "2047M"),
    })
    quote_identifier(settings["catalog_table"])
    if not re.fullmatch(r"[1-9][0-9]*[KMGkmg]?", settings["indexer_mem_limit"]):
        raise RuntimeError("Invalid MANTICORE_INDEXER_MEM_LIMIT")
    if settings["source_chunk_rows"] > settings["rows_per_shard"]:
        raise RuntimeError("MANTICORE_SOURCE_CHUNK_ROWS must not exceed a shard")
    return settings


def atomic_write(path: Path, content: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".next")
    temporary.write_text(content, encoding="utf-8")
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def quote_identifier(value: str) -> str:
    if not IDENTIFIER.fullmatch(value):
        raise RuntimeError(f"Unsafe MariaDB identifier: {value!r}")
    return f"`{value}`"


def quote_sql_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "''") + "'"


def query_mariadb(settings: dict, sql: str) -> list[str]:
    environment = os.environ.copy()
    environment["MYSQL_PWD"] = settings["mysql_password"]
    result = subprocess.run(
        [
            "mariadb", "--batch", "--raw", "--skip-column-names",
            "--host", settings["mysql_host"],
            "--port", str(settings["mysql_port"]),
            "--user", settings["mysql_user"],
            settings["mysql_database"],
            "--execute", sql,
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
    )
    if result.returncode != 0:
        message = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"MariaDB metadata query failed: {message}")
    return [line for line in result.stdout.splitlines() if line.strip()]


def query_json_rows(settings: dict, sql: str) -> list[dict]:
    rows = []
    for line in query_mariadb(settings, sql):
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as error:
            raise RuntimeError(f"MariaDB returned invalid metadata JSON: {error}") from error
    return rows


def read_catalog(settings: dict) -> list[dict]:
    catalog_pairs = ",".join(
        f"{quote_sql_string(field)},{quote_identifier(field)}"
        for field in CATALOG_FIELDS
    )
    return query_json_rows(
        settings.get("catalog_connection", settings),
        f"SELECT JSON_OBJECT({catalog_pairs}) "
        f"FROM {quote_identifier(settings['catalog_table'])} ORDER BY id",
    )


def catalog_identities(catalog: list[dict]) -> tuple[dict, dict]:
    by_id, by_table = {}, {}
    for row in catalog:
        try:
            database_id = int(row["id"])
            table_name = str(row["name_table"])
            quote_identifier(table_name)
        except (KeyError, TypeError, ValueError) as error:
            raise RuntimeError("Invalid catalogue identity") from error
        if not 0 < database_id <= MAX_SOURCE_ROW_ID:
            raise RuntimeError("Catalogue ID exceeds the document-id allocation")
        if database_id in by_id or table_name in by_table:
            raise RuntimeError("Duplicate catalogue ID or source table name")
        by_id[database_id], by_table[table_name] = table_name, database_id
    return by_id, by_table


def plan_signature(databases: list[dict], shards: list[dict]) -> str:
    payload = json.dumps({"databases": databases, "shards": shards}, ensure_ascii=False,
                         sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def discover_plan(settings: dict, catalog_rows: list[dict] | None = None) -> dict:
    catalog = read_catalog(settings) if catalog_rows is None else catalog_rows
    catalog_identities(catalog)

    # Enumerate only explicitly catalogued source tables, always on the configured
    # source connection. Operational tables are never a source of row data.
    table_names = sorted({str(row["name_table"]) for row in catalog})
    for table_name in table_names:
        quote_identifier(table_name)
    allowed_tables = ",".join(quote_sql_string(name) for name in table_names)

    columns = query_json_rows(
        settings,
        "SELECT JSON_OBJECT("
        "'table_name',TABLE_NAME,'column_name',COLUMN_NAME,'data_type',DATA_TYPE,"
        "'ordinal_position',ORDINAL_POSITION,'is_nullable',IS_NULLABLE) "
        "FROM information_schema.COLUMNS "
        f"WHERE TABLE_SCHEMA={quote_sql_string(settings['mysql_database'])} "
        f"AND TABLE_NAME IN ({allowed_tables}) "
        "ORDER BY TABLE_NAME,ORDINAL_POSITION",
    ) if table_names else []
    columns_by_table = {}
    for column in columns:
        columns_by_table.setdefault(column["table_name"], []).append({
            "name": column["column_name"],
            "data_type": column["data_type"],
            "is_nullable": column.get("is_nullable"),
        })

    databases = []
    segments = []
    for raw_database in catalog:
        database = {
            field: "" if raw_database.get(field) is None else raw_database[field]
            for field in CATALOG_FIELDS
        }
        database["id"] = int(database["id"])
        table_name = str(database["name_table"])
        table_columns = columns_by_table.get(table_name)
        if not table_columns:
            raise RuntimeError(f"Catalog table does not exist: {table_name}")
        id_column = next((column for column in table_columns if column["name"].lower() == "id"), None)
        if id_column is None:
            raise RuntimeError(f"Source table has no id column: {table_name}")
        if id_column["data_type"].lower() not in INTEGER_TYPES or id_column["is_nullable"] != "NO":
            raise RuntimeError(f"Source table must have a non-null integer id: {table_name}")
        # Imported immutable tables can have explicit IDs without AUTO_INCREMENT.
        # Only new tables reach discovery, so old source tables are never scanned.
        bounds = query_json_rows(settings,
            "SELECT JSON_OBJECT('max_id',COALESCE(MAX(`id`),0),'min_id',MIN(`id`)) "
            f"FROM {quote_identifier(table_name)}")
        if len(bounds) != 1 or "max_id" not in bounds[0]:
            raise RuntimeError(f"Cannot read source row-id bounds: {table_name}")
        max_id = int(bounds[0]["max_id"] or 0)
        if bounds[0].get("min_id") is not None and int(bounds[0]["min_id"]) <= 0:
            raise RuntimeError(f"Source table must use positive row IDs: {table_name}")
        if max_id > MAX_SOURCE_ROW_ID:
            raise RuntimeError(
                f"Source table {table_name} exceeds the 32-bit row-id allocation: {max_id}"
            )
        database["columns"] = table_columns
        database["max_id"] = max_id
        databases.append(database)
        for start in range(1, max_id + 1, settings["source_chunk_rows"]):
            end = min(start + settings["source_chunk_rows"] - 1, max_id)
            segments.append({
                "database_id": database["id"],
                "table_name": table_name,
                "start_id": start,
                "end_id": end,
                "id_span": end - start + 1,
            })

    shards = []
    current_segments = []
    current_span = 0
    for segment in segments:
        if current_segments and current_span + segment["id_span"] > settings["rows_per_shard"]:
            shards.append({"id_span": current_span, "segments": current_segments})
            current_segments = []
            current_span = 0
        current_segments.append(segment)
        current_span += segment["id_span"]
    if current_segments:
        shards.append({"id_span": current_span, "segments": current_segments})

    return {
        "schema_version": INDEX_SCHEMA_VERSION,
        "created_at": now(),
        "signature": plan_signature(databases, shards),
        "databases": databases,
        "shards": shards,
    }


def write_catalog(plan: dict, path: Path) -> None:
    databases = [
        {field: database.get(field, "") for field in CATALOG_FIELDS}
        for database in plan["databases"]
    ]
    atomic_write(
        path,
        json.dumps({
            "schema_version": INDEX_SCHEMA_VERSION,
            "updated_at": now(),
            "databases": databases,
        }, ensure_ascii=False, indent=2) + "\n",
        0o644,
    )


def extend_plan(settings: dict, plan: dict) -> dict:
    catalog = read_catalog(settings)
    live_ids, _ = catalog_identities(catalog)
    known_ids, known_tables = catalog_identities(plan["databases"])
    for database_id, table_name in live_ids.items():
        if database_id in known_ids and known_ids[database_id] != table_name:
            raise RuntimeError("Cannot reuse an indexed catalogue ID for a different table")
        if table_name in known_tables and known_tables[table_name] != database_id:
            raise RuntimeError("Cannot register an indexed source table under a different ID")
    added = [row for row in catalog if int(row["id"]) not in known_ids]
    if not added:
        return plan
    addition = discover_plan(settings, added)
    # Never refill even a partially occupied old shard. Its files may be live.
    databases = plan["databases"] + addition["databases"]
    shards = plan["shards"] + addition["shards"]
    return {
        **plan,
        "updated_at": now(),
        "databases": databases,
        "shards": shards,
        "signature": plan_signature(databases, shards),
        "predecessors": plan.get("predecessors", []) + [{
            "signature": plan["signature"], "shard_count": len(plan["shards"]),
            "database_count": len(plan["databases"]),
        }],
    }


def load_or_create_plan(settings: dict, *, refresh: bool = False) -> dict:
    changed = False
    try:
        plan = json.loads(settings["plan_path"].read_text(encoding="utf-8"))
    except FileNotFoundError:
        plan = discover_plan(settings)
        changed = True
    except (OSError, ValueError, TypeError) as error:
        raise RuntimeError(f"Cannot read index plan: {error}") from error
    if plan.get("schema_version") != INDEX_SCHEMA_VERSION:
        raise RuntimeError("Indexer schema changed; run once with --clean to build direct row indexes")
    if refresh and not changed:
        extended = extend_plan(settings, plan)
        changed = extended is not plan
        plan = extended
    if changed:
        # The old checkpoint is still valid against the recorded immutable prefix
        # if the process stops before writing its new signature.
        atomic_write(settings["plan_path"], json.dumps(plan, ensure_ascii=False, indent=2) + "\n", 0o644)
    write_catalog(plan, settings["catalog_path"])
    return plan


def load_state(path: Path, plan: dict) -> dict:
    exists = True
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        exists = False
        state = {}
    except (OSError, ValueError, TypeError) as error:
        raise RuntimeError(f"Cannot read index checkpoint: {error}") from error
    if not isinstance(state, dict) or (exists and not state):
        raise RuntimeError("Invalid index checkpoint; restore its matching backup")
    required = {"schema_version", "plan_signature", "total_shards", "completed_shards", "current_shard", "status"}
    if exists and not required.issubset(state):
        raise RuntimeError("Incomplete index checkpoint; restore its matching backup")
    if state and state.get("schema_version") != INDEX_SCHEMA_VERSION:
        raise RuntimeError("Indexer schema changed; run once with --clean to build direct row indexes")
    total_shards = len(plan["shards"])
    previous_total = total_shards
    if state and state.get("plan_signature") != plan["signature"]:
        predecessor = next((item for item in plan.get("predecessors", [])
                            if item["signature"] == state.get("plan_signature")), None)
        if predecessor is None:
            raise RuntimeError("Index plan/checkpoint mismatch; restore a matching backup")
        previous_total = predecessor["shard_count"]
        database_count = predecessor["database_count"]
        if (type(previous_total) is not int or not 0 <= previous_total <= total_shards
                or type(database_count) is not int or not 0 <= database_count <= len(plan["databases"])
                or plan_signature(plan["databases"][:database_count], plan["shards"][:previous_total])
                != predecessor["signature"]):
            raise RuntimeError("The checkpoint's original shard definitions changed")
    completed = state.get("completed_shards", [])
    current = state.get("current_shard", -1)
    if (not isinstance(completed, list)
            or any(type(value) is not int or not 0 <= value < previous_total for value in completed)
            or type(current) is not int or not -1 <= current < max(previous_total, 0)
            or (state and state.get("total_shards", previous_total) != previous_total)):
        raise RuntimeError("Invalid shard IDs or count in index checkpoint")
    status = state.get("status", "pending")
    if (status not in {"pending", "running", "paused", "failed", "completed"}
            or (status == "completed" and (len(set(completed)) != previous_total or current != -1))):
        raise RuntimeError("Invalid completion status in index checkpoint")
    if previous_total != total_shards and len(set(completed)) < total_shards:
        status = "pending"
    return {
        "version": 1,
        "schema_version": INDEX_SCHEMA_VERSION,
        "plan_signature": plan["signature"],
        "status": status,
        "total_shards": total_shards,
        "completed_shards": sorted(set(completed)),
        "current_shard": current,
        "updated_at": state.get("updated_at", now()),
    }


def save_state(path: Path, state: dict) -> None:
    state["updated_at"] = now()
    atomic_write(path, json.dumps(state, ensure_ascii=False, indent=2) + "\n", 0o644)


def shard_name(index: int) -> str:
    return f"matrix_row_{index:04d}"


def payload_expression(columns: list[dict]) -> str:
    parts = []
    for column in columns:
        name = column["name"]
        identifier = quote_identifier(name)
        if column["data_type"].lower() in BINARY_TYPES:
            value = f"IFNULL(TO_BASE64({identifier}),'')"
        else:
            value = f"IFNULL(CAST({identifier} AS CHAR CHARACTER SET utf8mb4),'')"
        parts.extend([quote_sql_string(name), value])
    return f"JSON_OBJECT({','.join(parts)})"


def search_expression(field: str, columns: list[dict]) -> str:
    actual = next(
        (column["name"] for column in columns if column["name"].lower() == field),
        None,
    )
    if not actual:
        return f"'' AS {quote_identifier(field)}"
    return (
        f"IFNULL(CAST({quote_identifier(actual)} AS CHAR CHARACTER SET utf8mb4),'') "
        f"AS {quote_identifier(field)}"
    )


def table_settings(path: Path, sources: list[str] | None = None) -> str:
    lines = ["  type = plain"]
    lines.extend(f"  source = {source}" for source in (sources or []))
    lines.extend([
        f"  path = {path}",
        "  stored_fields =",
        "  stored_only_fields = payload",
        "  dict = keywords",
        "  morphology = none",
        "  min_word_len = 1",
        "  min_infix_len = 3",
    ])
    return "\n".join(lines)


def build_indexer_config(index: int, shard: dict, plan: dict, settings: dict) -> str:
    name = shard_name(index)
    databases_by_id = {item["id"]: item for item in plan["databases"]}
    source_names = []
    source_sections = []
    for part, segment in enumerate(shard["segments"]):
        database = databases_by_id[segment["database_id"]]
        table_name = quote_identifier(segment["table_name"])
        global_id = (
            f"CAST({segment['database_id']} * {1 << DOCUMENT_ID_SHIFT} + id AS UNSIGNED) AS id"
        )
        selected = [global_id]
        selected.extend(search_expression(field, database["columns"]) for field in SEARCH_FIELDS)
        selected.append(f"{payload_expression(database['columns'])} AS payload")
        query = (
            f"SELECT {','.join(selected)} FROM {table_name} "
            "WHERE id>=$start AND id<=$end"
        )
        source = f"matrix_source_{index:04d}_{part:03d}"
        source_names.append(source)
        source_sections.append(f"""source {source} {{
  type = mysql
  sql_host = {settings['mysql_host']}
  sql_port = {settings['mysql_port']}
  sql_user = {settings['mysql_user']}
  sql_pass = {settings['mysql_password']}
  sql_db = {settings['mysql_database']}
  sql_query_pre = SET NAMES utf8mb4
  sql_query_range = SELECT {segment['start_id']},{segment['end_id']}
  sql_range_step = {settings['range_step']}
  sql_query = {query}
}}""")

    sources_text = "\n\n".join(source_sections)
    return f"""{sources_text}

table {name} {{
{table_settings(settings['indexes_dir'] / name, source_names)}
}}

indexer {{
  mem_limit = {settings['indexer_mem_limit']}
}}
"""


def build_active_config(completed: list[int], settings: dict) -> str:
    data_dir = settings["data_dir"]
    lines = [
        "table matrix_rows_empty {",
        "  type = rt",
        f"  path = {data_dir / 'runtime' / 'matrix_rows_empty'}",
    ]
    lines.extend(f"  rt_field = {field}" for field in SEARCH_FIELDS)
    lines.extend([
        "  rt_field = payload",
        "  stored_fields =",
        "  stored_only_fields = payload",
        "  dict = keywords",
        "  morphology = none",
        "  min_word_len = 1",
        "  min_infix_len = 3",
        "}",
        "",
    ])
    valid_shards = []
    for index in completed:
        name = shard_name(index)
        path = settings["indexes_dir"] / name
        if not path.with_suffix(".sph").is_file():
            raise RuntimeError(f"Completed index is missing: {name}; restore its files from backup")
        valid_shards.append(name)
        lines.extend([f"table {name} {{", table_settings(path), "}", ""])
    lines.extend(["table matrix_records {", "  type = distributed", "  local = matrix_rows_empty"])
    lines.extend(f"  local = {name}" for name in valid_shards)
    lines.extend([
        "}",
        "",
        "searchd {",
        f"  listen = {settings.get('listen_host', '127.0.0.1')}:9306:mysql",
        f"  listen = {settings.get('listen_host', '127.0.0.1')}:9308:http",
        f"  listen = {settings.get('listen_host', '127.0.0.1')}:9312",
        f"  log = {settings['log_dir'] / 'searchd.log'}",
        f"  query_log = {settings['log_dir'] / 'query.log'}",
        f"  pid_file = {settings['pid_file']}",
        f"  binlog_path = {data_dir / 'runtime'}",
        "  seamless_rotate = 1",
        "  preopen_tables = 1",
        "  unlink_old = 1",
        "}",
        "",
    ])
    return "\n".join(lines)


def clean_incomplete_shard(index: int, indexes_dir: Path) -> None:
    name = shard_name(index)
    for target in indexes_dir.glob(f"{name}.*"):
        if target.is_file() and target.parent.resolve() == indexes_dir.resolve():
            target.unlink()


def sql_http(settings: dict, sql: str, timeout: float) -> list[dict]:
    request = Request(settings["reload_url"].rstrip("/") + "/sql?mode=raw",
                      data=sql.encode("utf-8"), headers={"Content-Type": "text/plain"})
    try:
        with urlopen(request, timeout=timeout) as response:
            results = json.loads(response.read())
    except (OSError, URLError, ValueError) as error:
        raise RuntimeError("Manticore SQL reload request failed") from error
    if not isinstance(results, list) or not results or any(not isinstance(item, dict) for item in results):
        raise RuntimeError("Invalid Manticore SQL response")
    if any(item.get("error") for item in results):
        raise RuntimeError("Manticore SQL reload command failed")
    return results


def reload_searchd(settings: dict, completed: list[int] | None = None) -> None:
    if settings.get("reload_url"):
        deadline = time.monotonic() + settings["reload_timeout"]
        sql_http(settings, "RELOAD TABLES", settings["reload_timeout"])
        expected = {"matrix_records", "matrix_rows_empty"}
        expected.update(shard_name(index) for index in (completed or []))
        while time.monotonic() < deadline:
            results = sql_http(settings, "SHOW TABLES", max(0.001, deadline - time.monotonic()))
            visible = {str(row.get("Table", row.get("Index", "")))
                       for result in results for row in result.get("data", [])}
            if expected.issubset(visible):
                # A plain shard can become visible before the asynchronous
                # config reload updates the distributed table's child list.
                definitions = sql_http(settings, "SHOW CREATE TABLE matrix_records",
                                       max(0.001, deadline - time.monotonic()))
                for result in definitions:
                    for row in result.get("data", []):
                        ddl = row.get("Create Table", "")
                        if row.get("Table") != "matrix_records" or not isinstance(ddl, str):
                            continue
                        members = {name.strip() for group in re.findall(
                            r"\blocal\s*=\s*'([^']*)'", ddl, flags=re.IGNORECASE)
                                   for name in group.split(",")}
                        if (re.search(r"\btype\s*=\s*'distributed'", ddl, flags=re.IGNORECASE)
                                and members == expected - {"matrix_records"}):
                            return
            time.sleep(min(settings["reload_poll_interval"], max(0, deadline - time.monotonic())))
        raise RuntimeError("Manticore reload timed out waiting for published tables")
    try:
        pid = int(settings["pid_file"].read_text(encoding="utf-8").strip())
        os.kill(pid, signal.SIGHUP)
    except (OSError, ValueError):
        print("[manticore:index] searchd is not running; config will load on its next start", flush=True)


def clean_all_indexes(settings: dict) -> None:
    atomic_write(settings["active_config"], build_active_config([], settings), 0o600)
    reload_searchd(settings)
    time.sleep(1)
    for pattern in ("matrix_rel_*", "matrix_row_*"):
        for target in settings["indexes_dir"].glob(pattern):
            if target.is_file() and target.parent.resolve() == settings["indexes_dir"].resolve():
                target.unlink()
    for target in (
        settings["state_path"], settings["plan_path"], settings["catalog_path"],
        settings["indexer_config"],
    ):
        try:
            target.unlink()
        except FileNotFoundError:
            pass
    print("[manticore:index] old relation indexes and checkpoints removed", flush=True)


def handle_signal(signum, frame) -> None:
    del signum, frame
    global STOP_REQUESTED
    STOP_REQUESTED = True
    if ACTIVE_PROCESS and ACTIVE_PROCESS.poll() is None:
        ACTIVE_PROCESS.terminate()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build resumable direct-row Matrix Manticore indexes")
    parser.add_argument("--init-config", action="store_true")
    parser.add_argument("--clean", action="store_true")
    parser.add_argument("--max-new-shards", type=int, default=0)
    parser.add_argument("--check-config", action="store_true")
    parser.add_argument("--bootstrap", action="store_true", help="Create an empty search config without DB access")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.max_new_shards < 0:
        raise RuntimeError("--max-new-shards cannot be negative")
    settings = load_settings(bootstrap=args.bootstrap)
    for directory in (
        settings["indexes_dir"], settings["log_dir"], settings["state_path"].parent,
        settings["data_dir"] / "runtime",
    ):
        directory.mkdir(parents=True, exist_ok=True, mode=0o755)
    if args.bootstrap:
        if not settings["active_config"].exists():
            atomic_write(settings["active_config"], build_active_config([], settings), 0o600)
        return 0

    settings["indexer_config"].parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_file = settings["lock_path"].open("a+")
    import fcntl
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock_file.close()
        print("[manticore:index] another indexer is already running", file=sys.stderr)
        return 2
    try:
        return run_locked(settings, args)
    finally:
        lock_file.close()


def run_locked(settings: dict, args: argparse.Namespace) -> int:
    global ACTIVE_PROCESS

    legacy_config = settings["state_path"].parent / "current-indexer.conf"
    if legacy_config.is_file():
        os.chmod(legacy_config, 0o600)
        atomic_write(settings["indexer_config"], legacy_config.read_text(encoding="utf-8"), 0o600)
        legacy_config.unlink()
    # Interrupted writes from the old public location may also hold credentials.
    legacy_temporary = legacy_config.with_suffix(legacy_config.suffix + ".next")
    if legacy_temporary.is_file():
        legacy_temporary.unlink()

    if args.clean:
        clean_all_indexes(settings)

    has_indexes = any(settings["indexes_dir"].glob("matrix_row_*"))
    if not settings["plan_path"].exists() and (settings["state_path"].exists() or has_indexes):
        raise RuntimeError("Index plan is missing for existing state; restore a matching backup")
    if not settings["state_path"].exists() and has_indexes:
        raise RuntimeError("Index checkpoint is missing for existing indexes; restore a matching backup")
    plan = load_or_create_plan(settings, refresh=not (args.init_config or args.check_config))
    state = load_state(settings["state_path"], plan)
    completed = set(state["completed_shards"])
    state["completed_shards"] = sorted(completed)
    atomic_write(settings["active_config"], build_active_config(state["completed_shards"], settings), 0o600)
    reload_searchd(settings, state["completed_shards"])
    if args.init_config:
        state["status"] = "pending" if not completed else state["status"]
        state["current_shard"] = -1
        save_state(settings["state_path"], state)
        print(
            f"[manticore:index] direct-row plan ready databases={len(plan['databases'])} "
            f"shards={len(plan['shards'])}",
            flush=True,
        )
        return 0

    if not plan["shards"]:
        state.update(status="completed", current_shard=-1)
        save_state(settings["state_path"], state)
        return 0

    if args.check_config:
        next_shard = next(
            (index for index in range(len(plan["shards"])) if index not in completed),
            None,
        )
        if next_shard is None:
            print("[manticore:index] all shard configs are already built", flush=True)
            return 0
        atomic_write(
            settings["indexer_config"],
            build_indexer_config(next_shard, plan["shards"][next_shard], plan, settings),
            0o600,
        )
        result = subprocess.run(
            ["indextool", "--checkconfig", "--config", str(settings["indexer_config"])],
            check=False,
            capture_output=True,
            text=True,
        )
        output = "\n".join(part for part in (result.stdout, result.stderr) if part)
        if output:
            print(output.rstrip(), flush=True)
        lowered = output.lower()
        valid = "config valid" in lowered and "fatal:" not in lowered and "error:" not in lowered
        return 0 if valid else (result.returncode or 1)

    built_this_run = 0
    for index, shard in enumerate(plan["shards"]):
        if STOP_REQUESTED:
            break
        if index in completed:
            continue
        clean_incomplete_shard(index, settings["indexes_dir"])
        state.update(status="running", current_shard=index)
        save_state(settings["state_path"], state)
        atomic_write(
            settings["indexer_config"],
            build_indexer_config(index, shard, plan, settings),
            0o600,
        )
        name = shard_name(index)
        source_tables = sorted({segment["table_name"] for segment in shard["segments"]})
        table_summary = ",".join(source_tables[:3])
        if len(source_tables) > 3:
            table_summary += f",+{len(source_tables) - 3}"
        print(
            f"[manticore:index] shard={index + 1}/{len(plan['shards'])} name={name} "
            f"sources={len(shard['segments'])} tables={table_summary} id_span={shard['id_span']}",
            flush=True,
        )
        ACTIVE_PROCESS = subprocess.Popen([
            "indexer", "--config", str(settings["indexer_config"]), name,
        ])
        result = ACTIVE_PROCESS.wait()
        ACTIVE_PROCESS = None
        if result != 0:
            state["status"] = "paused" if STOP_REQUESTED else "failed"
            save_state(settings["state_path"], state)
            return 0 if STOP_REQUESTED else result

        check = subprocess.run(
            ["indextool", "--config", str(settings["indexer_config"]), "--check", name],
            check=False,
        )
        if check.returncode != 0:
            state["status"] = "failed"
            save_state(settings["state_path"], state)
            return check.returncode
        published = sorted(completed | {index})
        atomic_write(
            settings["active_config"],
            build_active_config(published, settings),
            0o600,
        )
        try:
            reload_searchd(settings, published)
        except RuntimeError:
            state["status"] = "failed"
            save_state(settings["state_path"], state)
            raise
        completed.add(index)
        state["completed_shards"] = published
        state.update(current_shard=-1, status="running")
        save_state(settings["state_path"], state)
        print(
            f"[manticore:index] published={name} completed={len(completed)}/{len(plan['shards'])}",
            flush=True,
        )
        built_this_run += 1
        if args.max_new_shards and built_this_run >= args.max_new_shards:
            break

    state["current_shard"] = -1
    state["status"] = "completed" if len(completed) == len(plan["shards"]) else "paused"
    save_state(settings["state_path"], state)
    return 0


if __name__ == "__main__":
    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"[manticore:index] fatal: {error}", file=sys.stderr, flush=True)
        raise
