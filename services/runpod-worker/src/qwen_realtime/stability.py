from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class StableTranscript:
    rollback_tokens: int = 5
    stable_text: str = ""
    unstable_text: str = ""
    last_hypothesis: str = ""
    revision: int = 0
    rewrite_violations: int = 0

    def update(
        self,
        hypothesis: str,
        final: bool = False,
        holdback_tokens: int | None = None,
        candidate_stable: str | None = None,
    ) -> tuple[str, str]:
        self.revision += 1
        if final:
            self.stable_text = hypothesis
            self.unstable_text = ""
            self.last_hypothesis = hypothesis
            return self.stable_text, self.unstable_text
        if candidate_stable is None:
            holdback = self.rollback_tokens if holdback_tokens is None else max(self.rollback_tokens, holdback_tokens)
            split = max(0, len(hypothesis) - holdback)
            candidate = hypothesis[:split]
        else:
            candidate = candidate_stable
        if self.stable_text and not hypothesis.startswith(self.stable_text):
            # The wire contract never retracts committed text. Track this as an
            # acceptance metric; the next final event remains authoritative.
            self.rewrite_violations += 1
            unstable = hypothesis
        else:
            if len(candidate) >= len(self.stable_text):
                self.stable_text = candidate
            unstable = hypothesis[len(self.stable_text) :]
        self.unstable_text = unstable
        self.last_hypothesis = hypothesis
        return self.stable_text, self.unstable_text
