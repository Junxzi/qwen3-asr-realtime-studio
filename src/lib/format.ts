import type { TranscriptUtterance, TranscriptionSession } from "@/types";

export function formatClock(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatTime(iso: string, offsetMs = 0) {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(Date.parse(iso) + offsetMs));
}

export function formatRelativeDate(iso: string, now = new Date()) {
  const target = new Date(iso);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const date = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const difference = Math.round((today.getTime() - date.getTime()) / 86_400_000);
  if (difference === 0) return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(target);
  if (difference === 1) return "昨日";
  if (difference < 7) return `${difference}日前`;
  return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric" }).format(target);
}

export function groupSessions(sessions: TranscriptionSession[], now = new Date()) {
  const groups = new Map<string, TranscriptionSession[]>();
  for (const session of sessions) {
    const date = new Date(session.started_at);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const difference = Math.round((today.getTime() - target.getTime()) / 86_400_000);
    const key = difference === 0 ? "今日" : difference === 1 ? "昨日" : difference < 7 ? "過去7日" : "以前";
    groups.set(key, [...(groups.get(key) || []), session]);
  }
  return ["今日", "昨日", "過去7日", "以前"]
    .map((label) => ({ label, sessions: groups.get(label) || [] }))
    .filter((group) => group.sessions.length > 0);
}

export function speakerNumber(speaker?: string) {
  const match = speaker?.match(/(\d+)/);
  return match ? Number(match[1]) : 1;
}

export function utteranceOffset(utterance: TranscriptUtterance) {
  return utterance.audio_start_ms;
}

export function percentile(values: Array<number | null | undefined>, percentileValue = 0.95) {
  const numeric = values.filter((value): value is number => Number.isFinite(value)).sort((left, right) => left - right);
  if (!numeric.length) return null;
  const index = Math.min(numeric.length - 1, Math.max(0, Math.ceil(numeric.length * percentileValue) - 1));
  return numeric[index];
}
