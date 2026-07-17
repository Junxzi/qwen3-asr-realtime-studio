import type { FinalEvent, TranscriptUtterance, WordInfo } from "./types";

export interface ConversationItem {
  id: string;
  speaker: string;
  text: string;
  words: WordInfo[];
  audioStartMs: number;
  audioEndMs: number;
  createdAt: string;
  contextHits: string[];
  latencyMs: number | null;
  provisional?: boolean;
  fallback?: boolean;
}

export function liveConversationItems(finals: FinalEvent[], startedAt?: string): ConversationItem[] {
  return finals.flatMap((item, index) => {
    const createdAt = startedAt || new Date().toISOString();
    const absoluteStart = item.audio_start_ms ?? 0;
    if (item.finalization_status === "authoritative" && item.speaker_turns?.length) {
      return item.speaker_turns.map((turn, turnIndex) => ({
        id: `${item.utterance_id}:turn:${turnIndex}`,
        speaker: turn.speaker,
        text: turn.text,
        words: [turn],
        audioStartMs: absoluteStart + turn.start_ms,
        audioEndMs: absoluteStart + turn.end_ms,
        createdAt,
        contextHits: turnIndex === 0 ? item.context_hits || [] : [],
        latencyMs: item.latency_ms ?? null,
      }));
    }
    return [{
      id: item.utterance_id,
      speaker: item.words?.[0]?.speaker || (index % 2 ? "speaker_2" : "speaker_1"),
      text: item.text,
      words: item.words || [],
      audioStartMs: absoluteStart,
      audioEndMs: item.audio_end_ms || item.words?.at(-1)?.end_ms || 0,
      createdAt,
      contextHits: item.context_hits || [],
      latencyMs: item.latency_ms ?? null,
      provisional: item.finalization_status === "pending",
      fallback: item.finalization_status === "fallback",
    }];
  });
}

export function historyConversationItems(utterances: TranscriptUtterance[]): ConversationItem[] {
  return utterances.flatMap((utterance) => {
    const speakers = new Set(utterance.words.map((word) => word.speaker));
    if (speakers.size < 2) {
      return [{
        id: utterance.id,
        speaker: utterance.speaker,
        text: utterance.text,
        words: utterance.words,
        audioStartMs: utterance.audio_start_ms,
        audioEndMs: utterance.audio_end_ms,
        createdAt: utterance.created_at,
        contextHits: utterance.context_hits,
        latencyMs: utterance.latency_ms,
      }];
    }

    const groups: WordInfo[][] = [];
    for (const word of utterance.words) {
      const current = groups.at(-1);
      if (!current || current[0]?.speaker !== word.speaker) groups.push([word]);
      else current.push(word);
    }
    return groups.map((words, index) => ({
      id: `${utterance.id}:speaker-turn:${index}`,
      speaker: words[0]?.speaker || utterance.speaker,
      text: words.map((word) => word.text).join(" ").trim(),
      words,
      audioStartMs: utterance.audio_start_ms + (words[0]?.start_ms || 0),
      audioEndMs: utterance.audio_start_ms + (words.at(-1)?.end_ms || 0),
      createdAt: utterance.created_at,
      contextHits: index === 0 ? utterance.context_hits : [],
      latencyMs: utterance.latency_ms,
    }));
  });
}
