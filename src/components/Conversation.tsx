import { motion, useReducedMotion } from "motion/react";
import { FileAudio, Mic, WifiOff } from "lucide-react";
import { useEffect, useRef } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { ConversationItem } from "@/conversationProjection";
import { formatTime, speakerNumber } from "@/lib/format";
import type { AsrModel, ControlStage, PartialEvent, ProcessingProfile } from "@/types";

export type { ConversationItem } from "@/conversationProjection";

interface ConversationProps {
  items: ConversationItem[];
  partial: PartialEvent | null;
  startedAt?: string;
  stage?: ControlStage;
  live: boolean;
  loading?: boolean;
  error?: string;
  model?: AsrModel;
  processingProfile?: ProcessingProfile;
}

function EmptyConversation({
  stage,
  error,
  model,
  processingProfile,
}: {
  stage?: ControlStage;
  error?: string;
  model?: AsrModel;
  processingProfile?: ProcessingProfile;
}) {
  if (error) {
    return (
      <div className="conversation-empty conversation-empty--error" role="alert">
        <WifiOff />
        <strong>文字起こしを読み込めません</strong>
        <p>{error}</p>
      </div>
    );
  }
  const supportsMicrophone = Boolean((processingProfile?.input_modes || model?.input_modes)?.includes("microphone"));
  return (
    <div className="conversation-empty">
      <span className="empty-icon-pair">{supportsMicrophone ? <Mic /> : null}<FileAudio /></span>
      <strong>新しい文字起こしを開始</strong>
      <p>{stage === "ready"
        ? (supportsMicrophone ? "下部のマイク、または音声ファイルから開始してください。" : "下部から音声ファイルを選択してください。")
        : "開始すると利用可能なGPUを割り当て、選択モデルを準備します。"}</p>
    </div>
  );
}

function Bubble({
  item,
  startedAt,
  live,
}: {
  item: ConversationItem;
  startedAt?: string;
  live?: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const speaker = speakerNumber(item.speaker);
  const offset = item.audioStartMs;
  return (
    <motion.article
      className={`transcript-message transcript-message--speaker-${speaker % 2 === 0 ? "even" : "odd"}`}
      initial={reducedMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="speaker-meta">
        <span>{speaker}</span>
        <strong>話者 {speaker}</strong>
        <time>{formatTime(startedAt || item.createdAt, startedAt ? offset : 0)}</time>
        {item.provisional
          ? <small><i />高精度確定中</small>
          : item.fallback ? <small><i />高精度失敗・リアルタイム確定</small>
          : live ? <small><i />ライブ</small> : null}
      </div>
      <div className="message-bubble">
        <p>{item.text}</p>
        {item.contextHits.length ? (
          <footer>
            {item.contextHits.slice(0, 3).map((hit) => <span key={hit}>{hit}</span>)}
          </footer>
        ) : null}
      </div>
    </motion.article>
  );
}

export function Conversation({
  items,
  partial,
  startedAt,
  stage,
  live,
  loading,
  error,
  model,
  processingProfile,
}: ConversationProps) {
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (live && (items.length || partial)) endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [items.length, live, partial]);

  if (loading) {
    return (
      <div className="conversation-scroll conversation-loading" aria-label="文字起こしを読み込み中">
        {Array.from({ length: 5 }, (_, index) => (
          <div className="transcript-message" key={index}>
            <Skeleton className="speaker-skeleton" />
            <Skeleton className="bubble-skeleton" />
          </div>
        ))}
      </div>
    );
  }

  if (!items.length && !partial) {
    return <EmptyConversation stage={stage} error={error} model={model} processingProfile={processingProfile} />;
  }

  return (
    <div className="conversation-scroll">
      <div className="conversation-column">
        {items.map((item) => <Bubble key={item.id} item={item} startedAt={startedAt} live={live} />)}
        {partial ? (
          <article className={`transcript-message transcript-message--live transcript-message--speaker-${speakerNumber(partial.speaker_hint) % 2 === 0 ? "even" : "odd"}`}>
            <div className="speaker-meta">
              <span>{speakerNumber(partial.speaker_hint)}</span>
              <strong>話者 {speakerNumber(partial.speaker_hint)}</strong>
              <time>{formatTime(startedAt || new Date().toISOString(), partial.audio_end_ms)}</time>
              <small><i />ライブ</small>
            </div>
            <div className="message-bubble message-bubble--partial" aria-live="polite">
              <p>
                <span>{partial.stable_text}</span>
                <em>{partial.unstable_text}</em>
                <i className="typing-caret" aria-hidden="true" />
              </p>
            </div>
          </article>
        ) : null}
        <div ref={endRef} />
      </div>
    </div>
  );
}
