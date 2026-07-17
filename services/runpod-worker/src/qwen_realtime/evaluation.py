from __future__ import annotations

import itertools
import math
import unicodedata
from dataclasses import dataclass
from typing import Any, Callable, Sequence


def normalized_text(value: str) -> str:
    return "".join(unicodedata.normalize("NFKC", value).split())


def edit_counts(
    reference: Sequence[Any],
    hypothesis: Sequence[Any],
    substitution_cost: Callable[[Any, Any], int] | None = None,
) -> tuple[int, int]:
    """Return (errors, reference units) with unit-cost Levenshtein DP."""
    substitution_cost = substitution_cost or (lambda left, right: int(left != right))
    previous = list(range(len(hypothesis) + 1))
    for index, ref in enumerate(reference, 1):
        current = [index]
        for h_index, hyp in enumerate(hypothesis, 1):
            current.append(
                min(
                    previous[h_index] + 1,
                    current[h_index - 1] + 1,
                    previous[h_index - 1] + substitution_cost(ref, hyp),
                )
            )
        previous = current
    return previous[-1], len(reference)


def _word_units(record: dict[str, Any], prefix: str) -> list[str]:
    words = record.get(f"{prefix}_words") or []
    if words:
        return [str(item["text"]) for item in words]
    value = str(record.get(f"{prefix}_text", ""))
    return value.split() if " " in value.strip() else list(normalized_text(value))


def _speaker_mappings(reference_words: list[dict[str, Any]], prediction_words: list[dict[str, Any]]):
    reference_speakers = sorted({str(item["speaker"]) for item in reference_words})
    prediction_speakers = sorted({str(item["speaker"]) for item in prediction_words})
    if not prediction_speakers or not reference_speakers:
        yield {}
        return
    padded_reference = reference_speakers + ["__none__"] * max(
        0, len(prediction_speakers) - len(reference_speakers)
    )
    for permutation in itertools.permutations(padded_reference, len(prediction_speakers)):
        yield dict(zip(prediction_speakers, permutation, strict=True))


def wder_counts(record: dict[str, Any]) -> tuple[int, int]:
    reference = list(record.get("reference_words") or [])
    prediction = list(record.get("prediction_words") or [])
    if not reference:
        return 0, 0
    best = math.inf
    for mapping in _speaker_mappings(reference, prediction):
        errors, _ = edit_counts(
            reference,
            prediction,
            lambda ref, hyp: int(
                normalized_text(str(ref["text"])) != normalized_text(str(hyp["text"]))
                or str(ref["speaker"]) != mapping.get(str(hyp["speaker"]), "__none__")
            ),
        )
        best = min(best, errors)
    return int(best), len(reference)


def _frame_sets(segments: list[dict[str, Any]], frame_ms: int = 10) -> dict[str, set[int]]:
    result: dict[str, set[int]] = {}
    for segment in segments:
        speaker = str(segment["speaker"])
        start = int(segment["start_ms"]) // frame_ms
        end = math.ceil(int(segment["end_ms"]) / frame_ms)
        result.setdefault(speaker, set()).update(range(start, end))
    return result


def der_jer(record: dict[str, Any]) -> tuple[float | None, float | None]:
    reference = _frame_sets(list(record.get("reference_segments") or []))
    prediction = _frame_sets(list(record.get("prediction_segments") or []))
    if not reference:
        return None, None
    ref_speakers = sorted(reference)
    pred_speakers = sorted(prediction)
    permutations = itertools.permutations(ref_speakers + ["__none__"] * max(0, len(pred_speakers) - len(ref_speakers)), len(pred_speakers))
    best_errors = math.inf
    best_jer = math.inf
    all_frames = set().union(*reference.values(), *prediction.values()) if prediction else set().union(*reference.values())
    ref_speaker_frames = sum(len(frames) for frames in reference.values())
    for permutation in permutations:
        mapping = dict(zip(pred_speakers, permutation, strict=True))
        errors = 0
        for frame in all_frames:
            ref_active = {speaker for speaker, frames in reference.items() if frame in frames}
            pred_active = {
                mapping[speaker]
                for speaker, frames in prediction.items()
                if frame in frames and mapping[speaker] != "__none__"
            }
            errors += len(ref_active.symmetric_difference(pred_active))
        jer_values = []
        for speaker in ref_speakers:
            matched_pred = next((pred for pred, ref in mapping.items() if ref == speaker), None)
            pred_frames = prediction.get(matched_pred, set()) if matched_pred else set()
            union = reference[speaker] | pred_frames
            jer_values.append(1.0 - len(reference[speaker] & pred_frames) / max(1, len(union)))
        best_errors = min(best_errors, errors)
        best_jer = min(best_jer, sum(jer_values) / len(jer_values))
    return best_errors / max(1, ref_speaker_frames), best_jer


@dataclass(slots=True)
class ScoreAccumulator:
    char_errors: int = 0
    char_reference: int = 0
    word_errors: int = 0
    word_reference: int = 0
    biased_errors: int = 0
    biased_reference: int = 0
    hallucinated_terms: int = 0
    negative_terms: int = 0
    recalled_terms: int = 0
    spoken_terms: int = 0
    wder_errors: int = 0
    wder_reference: int = 0
    der_values: list[float] | None = None
    jer_values: list[float] | None = None

    def __post_init__(self) -> None:
        self.der_values = []
        self.jer_values = []

    def add(self, record: dict[str, Any]) -> None:
        reference_text = normalized_text(str(record.get("reference_text", "")))
        prediction_text = normalized_text(str(record.get("prediction_text", "")))
        errors, count = edit_counts(list(reference_text), list(prediction_text))
        self.char_errors += errors
        self.char_reference += count
        errors, count = edit_counts(_word_units(record, "reference"), _word_units(record, "prediction"))
        self.word_errors += errors
        self.word_reference += count

        catalog = {str(item["id"]): normalized_text(str(item["write"])) for item in record.get("catalog_terms", [])}
        spoken = {str(term_id) for term_id in record.get("spoken_term_ids", [])}
        hits = {str(term_id) for term_id in record.get("context_hits", [])[:20]}
        self.spoken_terms += len(spoken)
        self.recalled_terms += len(spoken & hits)
        for term_id, written in catalog.items():
            if term_id in spoken:
                self.biased_reference += 1
                self.biased_errors += int(bool(written) and written not in prediction_text)
            else:
                self.negative_terms += 1
                self.hallucinated_terms += int(bool(written) and written in prediction_text)

        errors, count = wder_counts(record)
        self.wder_errors += errors
        self.wder_reference += count
        der, jer = der_jer(record)
        if der is not None:
            self.der_values.append(der)
        if jer is not None:
            self.jer_values.append(jer)

    def result(self) -> dict[str, float | None]:
        def ratio(numerator: float, denominator: float) -> float | None:
            return numerator / denominator if denominator else None

        return {
            "cer": ratio(self.char_errors, self.char_reference),
            "wer": ratio(self.word_errors, self.word_reference),
            "bwer": ratio(self.biased_errors, self.biased_reference),
            "term_hallucination_rate": ratio(self.hallucinated_terms, self.negative_terms),
            "recall_at_20": ratio(self.recalled_terms, self.spoken_terms),
            "wder": ratio(self.wder_errors, self.wder_reference),
            "der": sum(self.der_values) / len(self.der_values) if self.der_values else None,
            "jer": sum(self.jer_values) / len(self.jer_values) if self.jer_values else None,
        }


def score_records(records: list[dict[str, Any]]) -> dict[str, float | None]:
    accumulator = ScoreAccumulator()
    for record in records:
        accumulator.add(record)
    return accumulator.result()
