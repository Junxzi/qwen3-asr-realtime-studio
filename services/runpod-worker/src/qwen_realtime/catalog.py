from __future__ import annotations

import html
import json
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Literal

_FORBIDDEN = ("<|", "|>", "im_start", "im_end", "chatml", "<audio", "</audio")
_NON_WORD = re.compile(r"[^0-9A-Z\u3041-\u3096\u30A1-\u30FA\u30FC\u4E00-\u9FFF]+")


def normalize_reading(value: str) -> str:
    """NFKC-normalize and convert katakana to hiragana for fuzzy matching."""
    value = unicodedata.normalize("NFKC", value).upper()
    chars: list[str] = []
    for char in value:
        code = ord(char)
        if 0x30A1 <= code <= 0x30F6:
            chars.append(chr(code - 0x60))
        else:
            chars.append(char)
    return _NON_WORD.sub("", "".join(chars))


def _validate_catalog_text(value: str) -> str:
    if not value or len(value) > 256:
        raise ValueError("catalog strings must contain 1-256 characters")
    lowered = unicodedata.normalize("NFKC", value).lower()
    if any(token in lowered for token in _FORBIDDEN):
        raise ValueError("catalog string contains a forbidden prompt-control sequence")
    if any(ord(char) < 32 and char not in "\t" for char in value):
        raise ValueError("catalog string contains a control character")
    return value


@dataclass(frozen=True, slots=True)
class Term:
    term_id: str
    read: str
    write: str
    aliases: tuple[str, ...] = ()
    priority: float = 1.0

    def __post_init__(self) -> None:
        _validate_catalog_text(self.term_id)
        _validate_catalog_text(self.read)
        _validate_catalog_text(self.write)
        for alias in self.aliases:
            _validate_catalog_text(alias)
        if not 0.1 <= self.priority <= 10.0:
            raise ValueError("priority must be between 0.1 and 10.0")

    @property
    def readings(self) -> tuple[str, ...]:
        return (self.read, *self.aliases)


@dataclass(frozen=True, slots=True)
class Catalog:
    revision: str
    terms: tuple[Term, ...]

    @classmethod
    def load(cls, path: Path) -> "Catalog":
        payload = json.loads(path.read_text(encoding="utf-8"))
        revision = _validate_catalog_text(str(payload["revision"]))
        terms = tuple(
            Term(
                term_id=str(item["id"]),
                read=str(item["read"]),
                write=str(item["write"]),
                aliases=tuple(str(value) for value in item.get("aliases", [])),
                priority=float(item.get("priority", 1.0)),
            )
            for item in payload["terms"]
        )
        ids = [term.term_id for term in terms]
        if len(ids) != len(set(ids)):
            raise ValueError("catalog term ids must be unique")
        return cls(revision=revision, terms=terms)

    @classmethod
    def empty(cls) -> "Catalog":
        return cls(revision="empty", terms=())


CatalogStatus = Literal["ready", "missing", "empty", "invalid"]


@dataclass(frozen=True, slots=True)
class CatalogState:
    catalog: Catalog
    status: CatalogStatus
    required: bool

    @property
    def ready(self) -> bool:
        if self.status == "invalid":
            return False
        return not self.required or self.status == "ready"

    @property
    def errors(self) -> list[str]:
        if self.status == "invalid":
            return ["CATALOG_PATH is invalid"]
        if self.required and self.status == "missing":
            return ["CATALOG_PATH is required for the selected Context model"]
        if self.required and self.status == "empty":
            return [
                "CATALOG_PATH must contain at least one term for the selected Context model"
            ]
        return []

    @property
    def warnings(self) -> list[str]:
        if self.required or self.status not in {"missing", "empty"}:
            return []
        if self.status == "missing":
            return ["catalog file is absent; worker will use the empty catalog revision"]
        return ["catalog contains no terms; Context retrieval is disabled"]


def load_catalog_state(path: Path, *, required: bool) -> CatalogState:
    if not path.is_file():
        return CatalogState(Catalog.empty(), "missing", required)
    try:
        catalog = Catalog.load(path)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError, ValueError):
        return CatalogState(Catalog.empty(), "invalid", required)
    if catalog.revision == "empty":
        return CatalogState(Catalog.empty(), "invalid", required)
    if not catalog.terms:
        return CatalogState(catalog, "empty", required)
    return CatalogState(catalog, "ready", required)


def weighted_edit_distance(left: str, right: str) -> float:
    """Levenshtein distance with cheaper long-vowel and voiced-kana confusion."""
    if not left:
        return float(len(right))
    if not right:
        return float(len(left))
    previous = [float(index) for index in range(len(right) + 1)]
    voiced = str.maketrans("がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ", "かきくけこさしすせそたちつてとはひふへほはひふへほ")
    for i, lchar in enumerate(left, 1):
        current = [float(i)]
        for j, rchar in enumerate(right, 1):
            if lchar == rchar:
                substitution = 0.0
            elif lchar == "ー" or rchar == "ー":
                substitution = 0.35
            elif lchar.translate(voiced) == rchar.translate(voiced):
                substitution = 0.4
            else:
                substitution = 1.0
            current.append(
                min(
                    previous[j] + 1.0,
                    current[j - 1] + 1.0,
                    previous[j - 1] + substitution,
                )
            )
        previous = current
    return previous[-1]


def _best_window_distance(hypothesis: str, reading: str) -> float:
    if not hypothesis:
        return float(len(reading))
    if reading in hypothesis:
        return 0.0
    width = len(reading)
    lower = max(1, width - 3)
    upper = min(len(hypothesis), width + 3)
    best = weighted_edit_distance(hypothesis, reading)
    for size in range(lower, upper + 1):
        for start in range(0, len(hypothesis) - size + 1):
            best = min(best, weighted_edit_distance(hypothesis[start : start + size], reading))
    return best


class ContextRetriever:
    def __init__(self, catalog: Catalog, top_k: int = 20) -> None:
        self.catalog = catalog
        self.top_k = top_k

    def retrieve(self, hypothesis: str) -> list[Term]:
        normalized = normalize_reading(hypothesis)
        if not normalized:
            return []
        scored: list[tuple[float, str, Term]] = []
        for term in self.catalog.terms:
            best = min(
                _best_window_distance(normalized, normalize_reading(reading))
                / max(1, len(normalize_reading(reading)))
                for reading in term.readings
            )
            score = best / term.priority
            scored.append((score, term.term_id, term))
        scored.sort(key=lambda item: (item[0], item[1]))
        return [term for _, _, term in scored[: self.top_k]]

    @staticmethod
    def prompt(terms: Iterable[Term]) -> str:
        # The caller can only pass validated catalog entries; client strings never enter here.
        return "".join(
            f"<term><read>{html.escape(term.read, quote=True)}</read>"
            f"<write>{html.escape(term.write, quote=True)}</write></term>"
            for term in terms
        )
