from qwen_realtime.evaluation import der_jer, score_records, wder_counts


def test_scores_bias_recall_hallucination_and_wder():
    record = {
        "reference_text": "野村證券です",
        "prediction_text": "野村證券です",
        "catalog_terms": [
            {"id": "nomura", "write": "野村證券"},
            {"id": "mizuho", "write": "みずほFG"},
        ],
        "spoken_term_ids": ["nomura"],
        "context_hits": ["nomura"],
        "reference_words": [{"text": "野村證券", "speaker": "A"}],
        "prediction_words": [{"text": "野村證券", "speaker": "speaker_0"}],
    }
    result = score_records([record])
    assert result["cer"] == 0
    assert result["bwer"] == 0
    assert result["term_hallucination_rate"] == 0
    assert result["recall_at_20"] == 1
    assert result["wder"] == 0


def test_der_and_jer_are_zero_after_speaker_permutation():
    record = {
        "reference_segments": [{"start_ms": 0, "end_ms": 1000, "speaker": "A"}],
        "prediction_segments": [{"start_ms": 0, "end_ms": 1000, "speaker": "speaker_1"}],
    }
    assert der_jer(record) == (0.0, 0.0)


def test_wder_counts_text_or_speaker_error():
    errors, count = wder_counts(
        {
            "reference_words": [
                {"text": "はい", "speaker": "A"},
                {"text": "株価", "speaker": "B"},
            ],
            "prediction_words": [
                {"text": "はい", "speaker": "s0"},
                {"text": "株式", "speaker": "s1"},
            ],
        }
    )
    assert (errors, count) == (1, 2)
