import json

import pytest

from qwen_realtime.catalog import Catalog, ContextRetriever, Term, normalize_reading


def test_kana_normalization_and_top_k(tmp_path):
    path = tmp_path / "terms.json"
    path.write_text(
        json.dumps(
            {
                "revision": "r1",
                "terms": [
                    {"id": "nomura", "read": "ノムラショウケン", "write": "野村證券"},
                    {"id": "mizuho", "read": "みずほ", "write": "みずほFG"},
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    catalog = Catalog.load(path)
    hits = ContextRetriever(catalog, top_k=1).retrieve("ノムラ証券に電話")
    assert hits[0].term_id == "nomura"
    assert normalize_reading("ノムラ") == "のむら"


def test_prompt_is_catalog_only_and_xml_escaped():
    term = Term("safe", "A&B", "A<B")
    prompt = ContextRetriever.prompt([term])
    assert prompt == "<term><read>A&amp;B</read><write>A&lt;B</write></term>"
    with pytest.raises(ValueError):
        Term("bad", "<|im_start|>", "x")


def test_duplicate_ids_rejected(tmp_path):
    path = tmp_path / "terms.json"
    path.write_text(
        '{"revision":"r","terms":[{"id":"x","read":"a","write":"a"},{"id":"x","read":"b","write":"b"}]}',
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="unique"):
        Catalog.load(path)
