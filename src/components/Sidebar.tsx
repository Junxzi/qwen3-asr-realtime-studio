import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { FileText, LogOut, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { LazyMotion, domAnimation, m } from "motion/react";
import { useMemo, useState, type FormEvent } from "react";
import { BrandMark } from "@/components/BrandMark";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeDate, groupSessions } from "@/lib/format";
import type { TranscriptionSession } from "@/types";

interface SidebarProps {
  sessions: TranscriptionSession[];
  selectedId?: string;
  search: string;
  busy?: boolean;
  loading?: boolean;
  error?: string;
  onSearch: (value: string) => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRetry: () => void;
  onLogout: () => void;
}

export function Sidebar({
  sessions,
  selectedId,
  search,
  busy,
  loading,
  error,
  onSearch,
  onNew,
  onSelect,
  onRename,
  onDelete,
  onRetry,
  onLogout,
}: SidebarProps) {
  const groups = useMemo(() => groupSessions(sessions), [sessions]);
  const [renameTarget, setRenameTarget] = useState<TranscriptionSession | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<TranscriptionSession | null>(null);
  const [mutating, setMutating] = useState(false);

  const openRename = (session: TranscriptionSession) => {
    setRenameTarget(session);
    setRenameValue(session.title);
  };
  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!renameTarget || !renameValue.trim()) return;
    setMutating(true);
    try {
      await onRename(renameTarget.id, renameValue.trim());
      setRenameTarget(null);
    } finally {
      setMutating(false);
    }
  };
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setMutating(true);
    try {
      await onDelete(deleteTarget.id);
      setDeleteTarget(null);
    } finally {
      setMutating(false);
    }
  };

  return (
    <div className="sidebar-inner">
      <div className="sidebar-brand">
        <BrandMark />
        <strong>InfoDeliver ASR Studio</strong>
      </div>

      <Button variant="ghost" className="new-transcription-button" onClick={onNew} disabled={busy}>
        <Plus data-icon="inline-start" />
        新しい文字起こし
      </Button>

      <div className="history-heading">
        <span>最近のセッション</span>
        <label className="history-search">
          <Search aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="履歴を検索"
            aria-label="履歴を検索"
          />
        </label>
      </div>

      <div className="history-scroll">
        {loading ? (
          <div className="history-loading" aria-label="履歴を読み込み中">
            {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="history-skeleton" />)}
          </div>
        ) : error ? (
          <div className="sidebar-message" role="alert">
            <p>{error}</p>
            <Button variant="subtle" size="sm" onClick={onRetry}>再試行</Button>
          </div>
        ) : groups.length ? groups.map((group) => (
          <section className="history-group" key={group.label}>
            <h2>{group.label}</h2>
            {group.sessions.map((session) => (
              <div className={`history-row ${selectedId === session.id ? "is-selected" : ""}`} key={session.id}>
                {selectedId === session.id ? (
                  <LazyMotion features={domAnimation}>
                    <m.span
                      className="history-selected-indicator"
                      initial={{ opacity: 0, scaleY: 0.45 }}
                      animate={{ opacity: 1, scaleY: 1 }}
                      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                    />
                  </LazyMotion>
                ) : null}
                <button className="history-select" onClick={() => onSelect(session.id)} disabled={busy}>
                  <FileText aria-hidden="true" />
                  <span>
                    <strong title={session.title}>{session.title}</strong>
                    <small>{formatRelativeDate(session.started_at)} · {session.utterance_count}件</small>
                  </span>
                </button>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button className="history-menu-trigger" aria-label={`${session.title}のメニュー`} disabled={busy}>
                      <MoreHorizontal />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content className="dropdown-content" sideOffset={6} align="end">
                      <DropdownMenu.Group>
                        <DropdownMenu.Item className="dropdown-item" onSelect={() => openRename(session)}>
                          <Pencil />名前を変更
                        </DropdownMenu.Item>
                        <DropdownMenu.Item className="dropdown-item dropdown-item--danger" onSelect={() => setDeleteTarget(session)}>
                          <Trash2 />削除
                        </DropdownMenu.Item>
                      </DropdownMenu.Group>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            ))}
          </section>
        )) : (
          <div className="sidebar-message">
            <p>{search ? "一致する履歴がありません" : "保存済みの文字起こしはまだありません"}</p>
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <div className="workspace-profile">
          <span>ID</span>
          <div>
            <strong>InfoDeliver Workspace</strong>
            <small>共有ワークスペース</small>
          </div>
          <Button variant="icon" size="icon" onClick={onLogout} aria-label="ログアウト">
            <LogOut />
          </Button>
        </div>
      </div>

      <Dialog open={Boolean(renameTarget)} onOpenChange={(open) => { if (!open) setRenameTarget(null); }}>
        <DialogContent>
          <DialogTitle>文字起こし名を変更</DialogTitle>
          <DialogDescription>共有履歴に表示する名称を変更します。</DialogDescription>
          <form className="dialog-form" onSubmit={submitRename}>
            <label htmlFor="transcription-title">名称</label>
            <input
              id="transcription-title"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              maxLength={160}
              autoFocus
            />
            <div className="dialog-actions">
              <Button variant="subtle" onClick={() => setRenameTarget(null)}>キャンセル</Button>
              <Button type="submit" disabled={mutating || !renameValue.trim()}>保存</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogTitle>文字起こし履歴を削除しますか？</AlertDialogTitle>
          <AlertDialogDescription>
            「{deleteTarget?.title}」の確定文字列、単語時刻、計測値を削除します。音声は保存されていません。
          </AlertDialogDescription>
          <div className="dialog-actions">
            <AlertDialogCancel asChild><Button variant="subtle">キャンセル</Button></AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button variant="danger" onClick={() => void confirmDelete()} disabled={mutating}>削除</Button>
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
