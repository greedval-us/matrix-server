import unittest

from test_indexer import load_indexer


class JsonImportIndexerTests(unittest.TestCase):
    def config(self, table, columns):
        indexer = load_indexer()
        shard = {"segments": [{"database_id": 7, "table_name": table, "start_id": 1, "end_id": 2}]}
        plan = {"databases": [{"id": 7, "columns": columns}]}
        settings = indexer.load_settings(bootstrap=True)
        settings.update(mysql_host="host", mysql_port=3306, mysql_user="user",
                        mysql_password="password", mysql_database="source_data", range_step=1000,
                        indexer_mem_limit="32M")
        return indexer.build_indexer_config(0, shard, plan, settings)

    def test_imported_document_payload_and_search_fields_are_extracted_from_original_json(self):
        for json_type in ("json", "longtext"):
            columns = [{"name": "id", "data_type": "int"}, {"name": "matrix_json", "data_type": json_type}]
            query = self.config("json_import_" + "5" * 32, columns)
            self.assertIn("`matrix_json` AS payload", query)
            self.assertIn("$.number", query)
            self.assertIn("$.date_of_birth", query)
            self.assertIn("7 * 4294967296 + id", query)

    def test_ordinary_tables_keep_existing_column_payload(self):
        columns = [{"name": "id", "data_type": "int"}, {"name": "matrix_json", "data_type": "json"}]
        self.assertIn("JSON_OBJECT(", self.config("old_source", columns))
        columns.append({"name": "mail", "data_type": "varchar"})
        self.assertIn("JSON_OBJECT(", self.config("json_import_" + "5" * 32, columns))
