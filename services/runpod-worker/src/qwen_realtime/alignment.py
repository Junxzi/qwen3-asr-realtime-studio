from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class WordTiming:
    text: str
    start_ms: int
    end_ms: int
    confidence: float = 1.0


@dataclass(frozen=True, slots=True)
class SpeakerActivity:
    start_ms: int
    end_ms: int
    speaker: str
    confidence: float


@dataclass(frozen=True, slots=True)
class AttributedWord:
    text: str
    start_ms: int
    end_ms: int
    speaker: str
    confidence: float
    overlap: bool


def _overlap_ms(start_a: int, end_a: int, start_b: int, end_b: int) -> int:
    return max(0, min(end_a, end_b) - max(start_a, start_b))


def attribute_words(
    words: list[WordTiming],
    activities: list[SpeakerActivity],
    default_speaker: str = "speaker_0",
) -> list[AttributedWord]:
    attributed: list[AttributedWord] = []
    for word in words:
        by_speaker: dict[str, tuple[int, float]] = {}
        for activity in activities:
            overlap = _overlap_ms(word.start_ms, word.end_ms, activity.start_ms, activity.end_ms)
            if overlap:
                old_overlap, old_conf = by_speaker.get(activity.speaker, (0, 0.0))
                by_speaker[activity.speaker] = (
                    old_overlap + overlap,
                    max(old_conf, activity.confidence),
                )
        if by_speaker:
            ranking = sorted(by_speaker.items(), key=lambda item: (-item[1][0], item[0]))
            speaker, (_, speaker_confidence) = ranking[0]
            is_overlap = len(ranking) > 1 and ranking[1][1][0] > 0
        else:
            speaker, speaker_confidence, is_overlap = default_speaker, 0.5, False
        attributed.append(
            AttributedWord(
                text=word.text,
                start_ms=word.start_ms,
                end_ms=word.end_ms,
                speaker=speaker,
                confidence=min(word.confidence, speaker_confidence),
                overlap=is_overlap,
            )
        )
    return attributed


def provisional_words(text: str, duration_ms: int) -> list[WordTiming]:
    """Fallback only; production final results should come from ForcedAligner."""
    units = [unit for unit in text.split() if unit] or list(text)
    if not units:
        return []
    width = max(1, duration_ms // len(units))
    return [
        WordTiming(unit, index * width, min(duration_ms, (index + 1) * width), 0.5)
        for index, unit in enumerate(units)
    ]
