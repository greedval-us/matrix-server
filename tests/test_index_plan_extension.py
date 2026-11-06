import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_indexer import load_indexer


class PlanExtensionTests(unittest.TestCase):
    def setUp(self):
        self.indexer = load_indexer()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        environment = {
            "MANTICORE_DATA_DIR": str(self.root),
            "MANTICORE_CONFIG": str(self.root / "config" / "manticore.conf"),
            "SOURCE_MYSQL_HOST": "source-db", "SOURCE_MYSQL_USER": "reader",
            "SOURCE_MYSQL_PASSWORD": "test-secret", "SOURCE_MYSQL_DATABASE": "source_data",
            "CATALOG_MYSQL_HOST": "mysql", "CATALOG_MYSQL_DATABASE": "matrix",
        }
        env = patch.dict(os.environ, environment, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.settings = self.indexer.load_settings()
        self.catalog = [{"id": 7, "name_table": "source_people"}]
        self.maximums = {"source_people": 3, "source_accounts": 5, "source_extra": 2}
        self.id_overrides = {}
        self.queries = []
        database = patch.object(self.indexer, "query_json_rows", side_effect=self.query)
        database.start()
        self.addCleanup(database.stop)

    def query(self, connection, sql):
        self.queries.append((connection["mysql_host"], sql))
        if "FROM `data_base`" in sql:
            return copy.deepcopy(self.catalog)
        if "information_schema.COLUMNS" in sql:
            return [{"table_name": name, "column_name": column, "data_type": kind,
                     "is_nullable": "NO", **(self.id_overrides if column == "id" else {})}
                    for name in self.maximums if f"'{name}'" in sql
                    for column, kind in (("id", "int"), ("mail", "varchar"))]
        if "information_schema.TABLES" in sql:
            # A fully imported table need not have AUTO_INCREMENT.
            return [{"table_name": name, "max_id": 0}
                    for name in self.maximums if f"'{name}'" in sql]
        for name, maximum in self.maximums.items():
            if f"FROM `{name}`" in sql and "MAX(" in sql:
                return [{"max_id": maximum}]
        raise AssertionError(f"Unexpected metadata query: {sql}")

    def initial(self):
        plan = self.indexer.load_or_create_plan(self.settings)
        state = self.indexer.load_state(self.settings["state_path"], plan)
        state.update(completed_shards=[0], total_shards=1, status="completed")
        self.indexer.save_state(self.settings["state_path"], state)
        self.queries.clear()
        return plan

    def test_imported_table_without_auto_increment_uses_actual_maximum_id(self):
        plan = self.indexer.load_or_create_plan(self.settings)
        self.assertEqual(plan["databases"][0]["max_id"], 3)
        self.assertEqual(plan["shards"][0]["segments"][0]["end_id"], 3)

    def test_new_table_appends_shards_and_adopts_saved_completed_prefix(self):
        old = self.initial()
        self.catalog.append({"id": 8, "name_table": "source_accounts"})
        extended = self.indexer.load_or_create_plan(self.settings, refresh=True)
        self.assertEqual(extended["shards"][:1], old["shards"])
        self.assertEqual(extended["databases"][:1], old["databases"])
        self.assertEqual(len(extended["shards"]), 2)
        self.assertEqual(extended["shards"][1]["segments"][0]["database_id"], 8)
        self.assertTrue(all("source_people" not in sql for _, sql in self.queries))
        self.assertEqual(self.queries[0][0], "mysql")
        self.assertTrue(all(host == "source-db" for host, _ in self.queries[1:]))
        # Simulate a crash after saving the extended plan, before adopting state.
        persisted = self.indexer.load_or_create_plan(self.settings)
        state = self.indexer.load_state(self.settings["state_path"], persisted)
        self.assertEqual(state["completed_shards"], [0])
        self.assertEqual(state["total_shards"], 2)
        self.assertEqual(state["plan_signature"], extended["signature"])
        self.assertNotEqual(state["status"], "completed")

    def test_no_new_tables_keeps_plan_bytes_and_does_not_query_source(self):
        old = self.initial()
        original = self.settings["plan_path"].read_bytes()
        self.maximums["source_people"] = 999
        self.catalog[0]["info"] = "changed display metadata"
        refreshed = self.indexer.load_or_create_plan(self.settings, refresh=True)
        self.assertEqual(refreshed, old)
        self.assertEqual(self.settings["plan_path"].read_bytes(), original)
        self.assertEqual(len(self.queries), 1)
        self.assertEqual(self.queries[0][0], "mysql")

    def test_multiple_extensions_recover_checkpoint_from_first_plan(self):
        self.initial()
        self.catalog.append({"id": 8, "name_table": "source_accounts"})
        self.indexer.load_or_create_plan(self.settings, refresh=True)
        self.catalog.append({"id": 9, "name_table": "source_extra"})
        extended = self.indexer.load_or_create_plan(self.settings, refresh=True)
        state = self.indexer.load_state(self.settings["state_path"], extended)
        self.assertEqual(state["completed_shards"], [0])
        self.assertEqual(state["total_shards"], 3)

    def test_identity_conflicts_do_not_modify_plan_or_published_catalog(self):
        self.initial()
        plan_before = self.settings["plan_path"].read_bytes()
        catalog_before = self.settings["catalog_path"].read_bytes()
        conflicts = [
            [{"id": 7, "name_table": "source_accounts"}],
            [{"id": 8, "name_table": "source_people"}],
            [{"id": 7, "name_table": "source_people"}, {"id": 8, "name_table": "source_people"}],
            [{"id": 8, "name_table": "source_accounts"}, {"id": 8, "name_table": "source_extra"}],
        ]
        for catalog in conflicts:
            with self.subTest(catalog=catalog):
                self.catalog = catalog
                with self.assertRaises(RuntimeError):
                    self.indexer.load_or_create_plan(self.settings, refresh=True)
                self.assertEqual(self.settings["plan_path"].read_bytes(), plan_before)
                self.assertEqual(self.settings["catalog_path"].read_bytes(), catalog_before)

    def test_missing_catalog_row_does_not_remove_indexed_source(self):
        old = self.initial()
        self.catalog = [{"id": 8, "name_table": "source_accounts"}]
        extended = self.indexer.load_or_create_plan(self.settings, refresh=True)
        self.assertEqual(extended["databases"][:1], old["databases"])
        self.assertEqual(extended["shards"][:1], old["shards"])

    def test_unknown_checkpoint_signature_and_invalid_completed_ids_are_rejected(self):
        plan = self.initial()
        state = json.loads(self.settings["state_path"].read_text())
        for changes in ({"plan_signature": "unrelated"}, {"completed_shards": [-1]},
                        {"completed_shards": [1]}, {"completed_shards": ["not-an-id"]}):
            with self.subTest(changes=changes):
                self.settings["state_path"].write_text(json.dumps({**state, **changes}))
                with self.assertRaises(RuntimeError):
                    self.indexer.load_state(self.settings["state_path"], plan)

    def test_checkpoint_cannot_claim_shards_added_after_its_plan(self):
        old = self.initial()
        self.catalog.append({"id": 8, "name_table": "source_accounts"})
        extended = self.indexer.load_or_create_plan(self.settings, refresh=True)
        self.settings["state_path"].write_text(json.dumps({
            "schema_version": 3, "plan_signature": old["signature"],
            "total_shards": 1, "completed_shards": [0, 1], "current_shard": -1, "status": "completed",
        }))
        with self.assertRaises(RuntimeError):
            self.indexer.load_state(self.settings["state_path"], extended)

    def test_truncated_valid_json_checkpoint_cannot_erase_completed_shards(self):
        plan = self.initial()
        original = json.loads(self.settings["state_path"].read_text())
        for key in ("completed_shards", "total_shards", "status", "current_shard"):
            with self.subTest(missing=key):
                truncated = {name: value for name, value in original.items() if name != key}
                self.settings["state_path"].write_text(json.dumps(truncated))
                with self.assertRaises(RuntimeError):
                    self.indexer.load_state(self.settings["state_path"], plan)

    def test_completed_status_cannot_hide_uncompleted_shards(self):
        plan = self.initial()
        original = json.loads(self.settings["state_path"].read_text())
        original["completed_shards"] = []
        self.settings["state_path"].write_text(json.dumps(original))
        with self.assertRaises(RuntimeError):
            self.indexer.load_state(self.settings["state_path"], plan)

    def test_invalid_new_source_id_type_or_nullability_never_changes_saved_plan(self):
        self.initial()
        original = self.settings["plan_path"].read_bytes()
        self.catalog.append({"id": 8, "name_table": "source_accounts"})
        for override in ({"data_type": "varchar"}, {"data_type": "decimal"},
                         {"data_type": "double"}, {"is_nullable": "YES"}):
            with self.subTest(override=override):
                self.id_overrides = override
                with self.assertRaisesRegex(RuntimeError, "non-null integer id"):
                    self.indexer.load_or_create_plan(self.settings, refresh=True)
                self.assertEqual(self.settings["plan_path"].read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
