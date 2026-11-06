import copy
import importlib.util
import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_manticore_indexes.py"


def fresh_indexer():
    spec = importlib.util.spec_from_file_location("matrix_indexer_lifecycle", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class IncrementalLifecycleTests(unittest.TestCase):
    """Exercise disk persistence while replacing only external services and binaries."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        environment = {
            "MANTICORE_DATA_DIR": str(self.root),
            "MANTICORE_CONFIG": str(self.root / "config" / "manticore.conf"),
            "MANTICORE_PID_FILE": str(self.root / "runtime" / "searchd.pid"),
            "MANTICORE_ROWS_PER_SHARD": "10",
            "MANTICORE_SOURCE_CHUNK_ROWS": "10",
            "MYSQL_HOST": "external-source", "MYSQL_USER": "source_reader",
            "MYSQL_PASSWORD": "source-secret", "MYSQL_DATABASE": "source_data",
            "CATALOG_MYSQL_HOST": "mysql", "CATALOG_MYSQL_USER": "catalog_reader",
            "CATALOG_MYSQL_PASSWORD": "catalog-secret", "CATALOG_MYSQL_DATABASE": "matrix",
        }
        for key in ("SYSTEMROOT", "WINDIR"):
            if key in os.environ:
                environment[key] = os.environ[key]
        env_patch = patch.dict(os.environ, environment, clear=True)
        env_patch.start()
        self.addCleanup(env_patch.stop)
        self.catalog = [{"id": 7, "name_table": "source_people", "name": "People"}]
        self.maximum_ids = {"source_people": 3, "source_accounts": 4}
        self.queries = []
        self.builds = []
        self.checked = []
        self.reloads = []
        self.allowed_source_tables = {"source_people"}
        self.fail_publication = False

    def query(self, connection, sql):
        self.queries.append((connection["mysql_host"], connection["mysql_database"], sql))
        if "FROM `data_base`" in sql:
            self.assertEqual((connection["mysql_host"], connection["mysql_database"]), ("mysql", "matrix"))
            return copy.deepcopy(self.catalog)
        self.assertEqual((connection["mysql_host"], connection["mysql_database"]),
                         ("external-source", "source_data"))
        tables = {name for name in self.maximum_ids
                  if "'" + name + "'" in sql or "`" + name + "`" in sql}
        self.assertTrue(tables, "Source metadata must explicitly restrict its source tables")
        self.assertLessEqual(tables, self.allowed_source_tables,
                             "Known immutable sources must not be rediscovered")
        if "information_schema.COLUMNS" in sql:
            return [{"table_name": name, "column_name": field, "data_type": kind,
                     "ordinal_position": position, "is_nullable": "NO"}
                    for name in sorted(tables)
                    for position, (field, kind) in enumerate((("id", "int"), ("mail", "varchar")), 1)]
        if "information_schema.TABLES" in sql:
            # Support the old discovery boundary so RED exposes the missing refresh.
            return [{"table_name": name, "max_id": self.maximum_ids[name]} for name in sorted(tables)]
        if re.search(r"MAX\s*\(\s*`?id`?\s*\)", sql, re.IGNORECASE):
            self.assertEqual(len(tables), 1)
            return [{"max_id": self.maximum_ids[next(iter(tables))]}]
        self.fail("Unexpected database query: " + sql)

    def invoke(self, *arguments):
        # A new Python module loses all globals, as a replacement container does.
        module = fresh_indexer()
        settings = module.load_settings()
        lock = SimpleNamespace(flock=lambda *args: None, LOCK_EX=1, LOCK_NB=2)

        def build(command, **kwargs):
            self.assertEqual(command[0], "indexer")
            self.assertEqual(command[1:3], ["--config", str(settings["indexer_config"])])
            name = command[-1]
            self.assertRegex(name, r"^matrix_row_\d{4}$")
            config = settings["indexer_config"].read_text(encoding="utf-8")
            self.assertIn("sql_host = external-source", config)
            self.assertIn("sql_db = source_data", config)
            self.assertNotIn("catalog-secret", config)
            self.builds.append((name, config))
            # Production publication finds real on-disk index files.
            (settings["indexes_dir"] / (name + ".sph")).write_bytes(
                (name + ":build=" + str(len(self.builds))).encode("ascii"))
            return SimpleNamespace(wait=lambda: 0)

        def check(command, **kwargs):
            self.assertEqual(command[0], "indextool")
            self.assertIn("--check", command)
            self.checked.append(command[-1])
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        def reload_searchd(reload_settings, completed=None):
            active = reload_settings["active_config"].read_text(encoding="utf-8")
            self.reloads.append((list(completed or []), active))
            for index in completed or []:
                self.assertIn(f"  local = matrix_row_{index:04d}\n", active)
            if self.fail_publication and completed == [0, 1]:
                raise RuntimeError("new shard visibility was not acknowledged")

        with patch.object(sys, "argv", [str(SCRIPT), *arguments]), \
             patch.dict(sys.modules, {"fcntl": lock}), \
             patch.object(module, "query_json_rows", side_effect=self.query), \
             patch.object(module.subprocess, "Popen", side_effect=build), \
             patch.object(module.subprocess, "run", side_effect=check), \
             patch.object(module, "reload_searchd", side_effect=reload_searchd):
            return module.main()

    def read_json(self, filename):
        return json.loads((self.root / "state" / filename).read_text(encoding="utf-8"))

    def shard_snapshot(self, name):
        path = self.root / "indexes" / (name + ".sph")
        return path.read_bytes(), path.stat().st_mtime_ns

    def preserve_old_shard_timestamp(self):
        path = self.root / "indexes" / "matrix_row_0000.sph"
        os.utime(path, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
        return self.shard_snapshot("matrix_row_0000")

    def add_accounts(self):
        self.catalog.append({"id": 8, "name_table": "source_accounts", "name": "Accounts"})
        self.allowed_source_tables = {"source_accounts"}

    def test_fresh_processes_append_new_shards_without_rebuilding_completed_partial_shard(self):
        self.assertEqual(self.invoke(), 0)
        original_plan = self.read_json("index-plan.json")
        self.assertEqual(original_plan["shards"], [{"id_span": 3, "segments": [{
            "database_id": 7, "table_name": "source_people", "start_id": 1, "end_id": 3, "id_span": 3,
        }]}])
        original_shard = self.preserve_old_shard_timestamp()
        self.assertEqual(self.read_json("indexer.json")["completed_shards"], [0])

        self.allowed_source_tables = set()
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.shard_snapshot("matrix_row_0000"), original_shard)
        self.assertEqual([name for name, _ in self.builds], ["matrix_row_0000"])

        self.add_accounts()
        self.assertEqual(self.invoke(), 0)
        extended = self.read_json("index-plan.json")
        self.assertEqual(len(extended["shards"]), 2,
                         "A registered new table must append a shard even when the old shard has room")
        self.assertEqual(extended["shards"][0], original_plan["shards"][0])
        self.assertEqual(extended["databases"][0], original_plan["databases"][0])
        self.assertEqual(extended["shards"][1], {"id_span": 4, "segments": [{
            "database_id": 8, "table_name": "source_accounts", "start_id": 1, "end_id": 4, "id_span": 4,
        }]})
        self.assertEqual(self.shard_snapshot("matrix_row_0000"), original_shard)
        self.assertEqual([name for name, _ in self.builds], ["matrix_row_0000", "matrix_row_0001"])
        self.assertEqual(self.checked, ["matrix_row_0000", "matrix_row_0001"])
        self.assertIn("FROM `source_accounts`", self.builds[-1][1])
        self.assertNotIn("FROM `source_people`", self.builds[-1][1])
        self.assertEqual(self.read_json("indexer.json")["completed_shards"], [0, 1])
        self.assertEqual([row["id"] for row in self.read_json("database-catalog.json")["databases"]], [7, 8])
        both_shards = {name: self.shard_snapshot(name) for name in ("matrix_row_0000", "matrix_row_0001")}

        self.allowed_source_tables = set()
        self.assertEqual(self.invoke(), 0)
        self.assertEqual({name: self.shard_snapshot(name) for name in both_shards}, both_shards)
        self.assertEqual(len(self.builds), 2)
        self.assertEqual(self.read_json("indexer.json")["status"], "completed")
        active = (self.root / "config" / "manticore.conf").read_text(encoding="utf-8")
        self.assertIn("  local = matrix_row_0000\n", active)
        self.assertIn("  local = matrix_row_0001\n", active)
        self.assertNotIn("source-secret", active)
        self.assertNotIn("catalog-secret", active)
        self.assertEqual(sum("FROM `data_base`" in sql for _, _, sql in self.queries), 4,
                         "Each explicit indexing job must check the operational catalogue")

    def test_failed_new_shard_reload_preserves_old_checkpoint_and_resumes_after_restart(self):
        self.assertEqual(self.invoke(), 0)
        original_shard = self.preserve_old_shard_timestamp()
        self.add_accounts()
        self.fail_publication = True
        with self.assertRaisesRegex(RuntimeError, "visibility was not acknowledged"):
            self.invoke()
        failed_state = self.read_json("indexer.json")
        self.assertEqual(failed_state["completed_shards"], [0])
        self.assertEqual(failed_state["status"], "failed")
        self.assertEqual(self.shard_snapshot("matrix_row_0000"), original_shard)
        self.assertIn("  local = matrix_row_0000\n",
                      (self.root / "config" / "manticore.conf").read_text(encoding="utf-8"))

        self.fail_publication = False
        self.allowed_source_tables = set()
        before_resume = len(self.reloads)
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.reloads[before_resume][0], [0])
        self.assertEqual(self.shard_snapshot("matrix_row_0000"), original_shard)
        self.assertEqual([name for name, _ in self.builds],
                         ["matrix_row_0000", "matrix_row_0001", "matrix_row_0001"])
        self.assertEqual(self.read_json("indexer.json")["completed_shards"], [0, 1])
        self.assertEqual(self.read_json("indexer.json")["status"], "completed")

    def test_bootstrap_restart_preserves_published_config_plan_checkpoint_and_shards(self):
        self.assertEqual(self.invoke(), 0)
        paths = [self.root / "config" / "manticore.conf",
                 self.root / "state" / "index-plan.json", self.root / "state" / "indexer.json",
                 self.root / "state" / "database-catalog.json", self.root / "indexes" / "matrix_row_0000.sph"]
        before = {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in paths}
        module = fresh_indexer()
        with patch.object(sys, "argv", [str(SCRIPT), "--bootstrap"]), \
             patch.dict(sys.modules, {"fcntl": None}), \
             patch.object(module, "query_json_rows", side_effect=AssertionError("bootstrap queried a DB")), \
             patch.object(module.subprocess, "Popen", side_effect=AssertionError("bootstrap rebuilt a shard")), \
             patch.object(module, "reload_searchd", side_effect=AssertionError("bootstrap reloaded searchd")):
            self.assertEqual(module.main(), 0)
        self.assertEqual({path: (path.read_bytes(), path.stat().st_mtime_ns) for path in paths}, before)

    def test_missing_checkpoint_never_rebuilds_existing_indexes(self):
        self.assertEqual(self.invoke(), 0)
        original = self.preserve_old_shard_timestamp()
        (self.root / "state" / "indexer.json").unlink()
        self.allowed_source_tables = set()
        with self.assertRaisesRegex(RuntimeError, "checkpoint is missing"):
            self.invoke()
        self.assertEqual(self.shard_snapshot("matrix_row_0000"), original)
        self.assertEqual(len(self.builds), 1)

    def test_missing_plan_never_rediscovers_or_overwrites_indexed_tables(self):
        self.assertEqual(self.invoke(), 0)
        original = self.preserve_old_shard_timestamp()
        active = (self.root / "config" / "manticore.conf").read_bytes()
        (self.root / "state" / "index-plan.json").unlink()
        self.allowed_source_tables = set()
        with self.assertRaisesRegex(RuntimeError, "plan is missing"):
            self.invoke()
        self.assertEqual(self.shard_snapshot("matrix_row_0000"), original)
        self.assertEqual((self.root / "config" / "manticore.conf").read_bytes(), active)
        self.assertEqual(len(self.builds), 1)


if __name__ == "__main__":
    unittest.main()
