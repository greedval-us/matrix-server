import importlib.util
import json
import os
import re
import sys
import tempfile
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_manticore_indexes.py"


def load_indexer():
    spec = importlib.util.spec_from_file_location("matrix_indexer", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ImportTests(unittest.TestCase):
    def test_import_does_not_require_linux_lock_module(self):
        with patch.dict(sys.modules, {"fcntl": None}):
            self.assertTrue(callable(load_indexer().main))

    def test_defaults_are_portable_and_explicit_source_settings_are_preserved(self):
        with patch.dict(os.environ, {"MYSQL_USER": "source_reader", "MYSQL_PASSWORD": "test-secret"}, clear=True):
            settings = load_indexer().load_settings()
        self.assertEqual(settings["data_dir"], Path("/var/lib/matrix").resolve())
        self.assertEqual(settings["mysql_database"], "source_data")
        self.assertEqual(settings["mysql_host"], "127.0.0.1")


@contextmanager
def sql_server(responses):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            requests.append((self.path, self.rfile.read(int(self.headers["Content-Length"])).decode()))
            response = responses[min(len(requests) - 1, len(responses) - 1)]
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


class IndexerTests(unittest.TestCase):
    def setUp(self):
        self.indexer = load_indexer()
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.environment = {
            "MANTICORE_DATA_DIR": str(self.root),
            "MANTICORE_CONFIG": str(self.root / "config" / "manticore.conf"),
            "MYSQL_HOST": "source-db", "MYSQL_USER": "source_reader",
            "MYSQL_PASSWORD": "source-secret", "MYSQL_DATABASE": "source_data",
        }
        for key in ("SYSTEMROOT", "WINDIR"):
            if key in os.environ:
                self.environment[key] = os.environ[key]
        self.env_patch = patch.dict(os.environ, self.environment, clear=True)
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

    def test_catalog_query_uses_operational_connection_only(self):
        os.environ.update(CATALOG_MYSQL_HOST="mysql", CATALOG_MYSQL_USER="catalog_reader",
                          CATALOG_MYSQL_PASSWORD="catalog-secret", CATALOG_MYSQL_DATABASE="matrix")
        settings = self.indexer.load_settings()
        queries = []

        def query(connection, sql):
            queries.append((connection["mysql_host"], connection["mysql_database"], sql))
            if "FROM `data_base`" in sql:
                return [{"id": 7, "name_table": "source_people"}]
            if "information_schema.COLUMNS" in sql:
                return [{"table_name": "source_people", "column_name": "id", "data_type": "int"},
                        {"table_name": "source_people", "column_name": "mail", "data_type": "varchar"},
                        {"table_name": "work_items", "column_name": "id", "data_type": "int"}]
            return [{"table_name": "source_people", "max_id": 3},
                    {"table_name": "work_items", "max_id": 999}]

        with patch.object(self.indexer, "query_json_rows", side_effect=query):
            plan = self.indexer.discover_plan(settings)
        self.assertEqual([(host, database) for host, database, _ in queries],
                         [("mysql", "matrix"), ("source-db", "source_data"), ("source-db", "source_data")])
        self.assertIn("TABLE_NAME IN ('source_people')", queries[1][2])
        self.assertIn("TABLE_NAME IN ('source_people')", queries[2][2])
        self.assertEqual([row["name_table"] for row in plan["databases"]], ["source_people"])
        config = self.indexer.build_indexer_config(0, plan["shards"][0], plan, settings)
        self.assertIn("sql_host = source-db", config)
        self.assertIn("sql_db = source_data", config)
        self.assertIn("7 * 4294967296 + id", config)
        self.assertNotIn("catalog-secret", config)
        self.assertNotIn("work_items", config)

    def test_source_aliases_and_password_files_retain_legacy_fallback(self):
        password_file = self.root / "source-password"
        password_file.write_text("file-secret\n", encoding="utf-8")
        os.environ.update(SOURCE_MYSQL_HOST="source-alias", SOURCE_MYSQL_USER="alias_reader",
                          SOURCE_MYSQL_PASSWORD_FILE=str(password_file))
        settings = self.indexer.load_settings()
        self.assertEqual(settings["mysql_host"], "source-alias")
        self.assertEqual(settings["mysql_user"], "alias_reader")
        self.assertEqual(settings["mysql_password"], "file-secret")
        self.assertEqual(settings["catalog_connection"]["mysql_host"], "source-alias")
        self.assertEqual(settings["catalog_connection"]["mysql_password"], "file-secret")

    def test_operational_password_file_and_private_paths(self):
        password_file = self.root / "catalog-password"
        password_file.write_text("catalog-file-secret\n", encoding="utf-8")
        os.environ.update(CATALOG_MYSQL_PASSWORD_FILE=str(password_file))
        settings = self.indexer.load_settings()
        self.assertEqual(settings["catalog_connection"]["mysql_password"], "catalog-file-secret")
        self.assertEqual(settings["indexer_config"], self.root / "private" / "current-indexer.conf")
        self.assertEqual(settings["lock_path"], self.root / "private" / "indexer.lock")
        self.assertEqual(settings["state_path"], self.root / "state" / "indexer.json")

    def test_legacy_source_settings_and_catalog_fallback(self):
        settings = self.indexer.load_settings()
        self.assertEqual(settings["mysql_host"], "source-db")
        self.assertEqual(settings["catalog_connection"]["mysql_user"], "source_reader")
        self.assertEqual(settings["catalog_connection"]["mysql_database"], "source_data")

    def test_resume_reuses_plan_without_database_discovery(self):
        settings = self.indexer.load_settings()
        settings["plan_path"].parent.mkdir(parents=True)
        settings["plan_path"].write_text(json.dumps({"schema_version": 3, "signature": "old-plan",
                                                    "databases": [], "shards": []}))
        with patch.object(self.indexer, "query_mariadb", side_effect=AssertionError("unexpected DB")):
            self.assertEqual(self.indexer.load_or_create_plan(settings)["signature"], "old-plan")

    def test_failed_reload_does_not_publish_completed_checkpoint(self):
        settings = self.indexer.load_settings()
        settings["plan_path"].parent.mkdir(parents=True)
        settings["plan_path"].write_text(json.dumps({
            "schema_version": 3, "signature": "plan", "databases": [{"id": 7}],
            "shards": [{"id_span": 3, "segments": [{"table_name": "source_people"}]}],
        }))
        lock = SimpleNamespace(flock=lambda *args: None, LOCK_EX=1, LOCK_NB=2)
        process = SimpleNamespace(wait=lambda: 0)
        with patch.object(sys, "argv", [str(SCRIPT)]), patch.dict(sys.modules, {"fcntl": lock}), \
             patch.object(self.indexer, "build_indexer_config", return_value="private source config"), \
             patch.object(self.indexer.subprocess, "Popen", return_value=process), \
             patch.object(self.indexer.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
             patch.object(self.indexer, "reload_searchd", side_effect=[None, RuntimeError("not visible")]):
            with self.assertRaisesRegex(RuntimeError, "not visible"):
                self.indexer.main()
        state = json.loads(settings["state_path"].read_text())
        self.assertEqual(state["completed_shards"], [])
        self.assertNotEqual(state["status"], "completed")
        self.assertEqual(settings["indexer_config"].read_text(), "private source config")
        self.assertFalse((self.root / "state" / "current-indexer.conf").exists())

    def test_init_config_moves_legacy_source_secret_out_of_public_state(self):
        settings = self.indexer.load_settings()
        settings["plan_path"].parent.mkdir(parents=True)
        settings["plan_path"].write_text(json.dumps({"schema_version": 3, "signature": "plan",
                                                    "databases": [], "shards": []}))
        legacy = self.root / "state" / "current-indexer.conf"
        legacy.write_text("sql_pass = legacy-secret\n")
        legacy_temporary = legacy.with_suffix(".conf.next")
        legacy_temporary.write_text("sql_pass = interrupted-legacy-secret\n")
        lock = SimpleNamespace(flock=lambda *args: None, LOCK_EX=1, LOCK_NB=2)
        with patch.object(sys, "argv", [str(SCRIPT), "--init-config"]), \
             patch.dict(sys.modules, {"fcntl": lock}), patch.object(self.indexer, "reload_searchd"), \
             patch.object(Path, "replace", side_effect=OSError("Cross-device link")):
            self.assertEqual(self.indexer.main(), 0)
        self.assertFalse(legacy.exists())
        self.assertFalse(legacy_temporary.exists())
        self.assertEqual(settings["indexer_config"].read_text(), "sql_pass = legacy-secret\n")

    def test_bootstrap_needs_no_credentials_database_or_linux_lock(self):
        os.environ.pop("MYSQL_USER")
        os.environ.pop("MYSQL_PASSWORD")
        os.environ["MANTICORE_LISTEN_HOST"] = "0.0.0.0"
        with patch.object(sys, "argv", [str(SCRIPT), "--bootstrap"]), \
             patch.object(self.indexer, "query_mariadb", side_effect=AssertionError("unexpected DB")), \
             patch.dict(sys.modules, {"fcntl": None}):
            self.assertEqual(self.indexer.main(), 0)
        config = (self.root / "config" / "manticore.conf").read_text()
        self.assertIn("table matrix_records {", config)
        self.assertIn("local = matrix_rows_empty", config)
        self.assertIn("listen = 0.0.0.0:9308:http", config)
        binlog_path = re.search(r"^  binlog_path = (.+)$", config, re.MULTILINE)
        self.assertIsNotNone(binlog_path)
        self.assertEqual(Path(binlog_path.group(1)), self.root / "runtime")
        self.assertTrue(Path(binlog_path.group(1)).is_dir())
        self.assertNotIn("sql_pass", config)
        self.assertFalse((self.root / "state" / "indexer.json").exists())
        self.assertFalse((self.root / "state" / "current-indexer.conf").exists())

    def test_bootstrap_preserves_published_config_on_restart(self):
        config_path = self.root / "config" / "manticore.conf"
        config_path.parent.mkdir()
        config_path.write_text("existing published configuration\n")
        with patch.object(sys, "argv", [str(SCRIPT), "--bootstrap"]):
            self.assertEqual(self.indexer.main(), 0)
        self.assertEqual(config_path.read_text(), "existing published configuration\n")

    def test_config_injection_and_invalid_ranges_are_rejected(self):
        for key, value in [("MYSQL_HOST", "host\nsource injected {"),
                           ("MYSQL_PASSWORD", "secret#comment"),
                           ("MANTICORE_LISTEN_HOST", "0.0.0.0\n}"),
                           ("MANTICORE_INDEXER_MEM_LIMIT", "2G\n}"),
                           ("MANTICORE_RANGE_STEP", "0"),
                           ("MYSQL_PORT", "70000"),
                           ("MYSQL_DATABASE", "bad-db"),
                           ("MANTICORE_DATA_DIR", str(self.root) + "\n}")]:
            with self.subTest(key=key), patch.dict(os.environ, {key: value}):
                with self.assertRaises(RuntimeError):
                    self.indexer.load_settings()

    def test_http_reload_waits_for_actual_shard_visibility(self):
        responses = [[{"total": 0, "error": "", "warning": ""}],
                     [{"data": [{"Table": "matrix_records"}], "error": ""}],
                     [{"data": [{"Table": "matrix_records"}, {"Table": "matrix_rows_empty"},
                                {"Table": "matrix_row_0000"}], "error": ""}],
                     [{"data": [{"Table": "matrix_records", "Create Table":
                                 "CREATE TABLE matrix_records type='distributed' "
                                 "local='matrix_rows_empty,matrix_row_0000'"}], "error": ""}]]
        with sql_server(responses) as (url, requests):
            settings = self.indexer.load_settings()
            settings.update(reload_url=url, reload_timeout=1, reload_poll_interval=0.001)
            self.indexer.reload_searchd(settings, [0])
        self.assertEqual(requests, [("/sql?mode=raw", "RELOAD TABLES"),
                                    ("/sql?mode=raw", "SHOW TABLES"),
                                    ("/sql?mode=raw", "SHOW TABLES"),
                                    ("/sql?mode=raw", "SHOW CREATE TABLE matrix_records")])

    def test_http_reload_waits_for_distributed_membership_after_shard_appears(self):
        visible = [{"data": [{"Table": "matrix_records"}, {"Table": "matrix_rows_empty"},
                             {"Table": "matrix_row_0000"}], "error": ""}]
        stale = [{"data": [{"Table": "matrix_records", "Create Table":
                           "CREATE TABLE matrix_records type='distributed' local='matrix_rows_empty'"}],
                  "error": ""}]
        ready = [{"data": [{"Table": "matrix_records", "Create Table":
                           "CREATE TABLE matrix_records type='distributed' "
                           "local='matrix_rows_empty' local='matrix_row_0000'"}], "error": ""}]
        with sql_server([[{"error": ""}], visible, stale, visible, ready]) as (url, requests):
            settings = self.indexer.load_settings()
            settings.update(reload_url=url, reload_timeout=1, reload_poll_interval=0.001)
            self.indexer.reload_searchd(settings, [0])
        self.assertEqual([sql for _, sql in requests], ["RELOAD TABLES", "SHOW TABLES",
                         "SHOW CREATE TABLE matrix_records", "SHOW TABLES", "SHOW CREATE TABLE matrix_records"])

    def test_http_reload_rejects_permanently_stale_distributed_membership(self):
        visible = [{"data": [{"Table": "matrix_records"}, {"Table": "matrix_rows_empty"},
                             {"Table": "matrix_row_0000"}], "error": ""}]

        def response(settings, sql, timeout):
            if sql == "SHOW TABLES":
                return visible
            if sql == "SHOW CREATE TABLE matrix_records":
                return [{"data": [{"Table": "matrix_records", "Create Table":
                         "CREATE TABLE matrix_records type='distributed' local='matrix_rows_empty'"}]}]
            return [{"error": ""}]

        settings = self.indexer.load_settings()
        settings.update(reload_url="http://manticore:9308", reload_timeout=0.01, reload_poll_interval=0.001)
        with patch.object(self.indexer, "sql_http", side_effect=response):
            with self.assertRaisesRegex(RuntimeError, "timed out"):
                self.indexer.reload_searchd(settings, [0])

    def test_http_reload_fails_on_sql_error_or_missing_table(self):
        for response in [[{"error": "cannot reload"}], [{"data": [], "error": ""}]]:
            with self.subTest(response=response), sql_server([response]) as (url, _):
                settings = self.indexer.load_settings()
                settings.update(reload_url=url, reload_timeout=0.01, reload_poll_interval=0.001)
                with self.assertRaises(RuntimeError):
                    self.indexer.reload_searchd(settings, [0])


if __name__ == "__main__":
    unittest.main()
