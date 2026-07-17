import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api, ApiError } from "@/api";
import { LoginScreen } from "@/components/LoginScreen";
import { StudioWorkspace } from "@/components/StudioWorkspace";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

function AppSkeleton() {
  return (
    <div className="studio-shell" aria-label="画面を読み込み中">
      <aside className="desktop-sidebar skeleton-sidebar">
        <Skeleton className="skeleton-logo" />
        <Skeleton className="skeleton-new" />
        {Array.from({ length: 7 }, (_, index) => <Skeleton className="skeleton-history" key={index} />)}
      </aside>
      <div className="studio-main">
        <header className="studio-header"><Skeleton className="skeleton-title" /></header>
        <div className="conversation-loading app-loading">
          {Array.from({ length: 5 }, (_, index) => <Skeleton className="bubble-skeleton" key={index} />)}
        </div>
      </div>
    </div>
  );
}

function FatalState({ title, message, retry }: { title: string; message: string; retry: () => void }) {
  return (
    <main className="fatal-state">
      <strong>{title}</strong>
      <p>{message}</p>
      <Button variant="subtle" onClick={retry}><RefreshCw data-icon="inline-start" />再試行</Button>
    </main>
  );
}

export default function App() {
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: ["session"], queryFn: api.session, retry: false });
  const authenticated = session.isSuccess;
  const status = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    enabled: authenticated,
    refetchInterval: 2_000,
    retry: 2,
  });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      queryClient.clear();
      window.location.assign("/");
    },
  });

  if (session.isPending) return <AppSkeleton />;
  if (session.error instanceof ApiError && session.error.status === 401) {
    return <LoginScreen onSuccess={() => queryClient.invalidateQueries({ queryKey: ["session"] })} />;
  }
  if (session.error) {
    return <FatalState title="ASR Studioを読み込めません" message={session.error.message} retry={() => void session.refetch()} />;
  }
  const statusError = status.error?.message;

  return (
    <Routes>
      <Route
        path="/"
        element={<StudioWorkspace status={status.data} statusError={statusError} onRefreshStatus={() => void status.refetch()} onLogout={() => logout.mutate()} />}
      />
      <Route
        path="/transcriptions/:id"
        element={<StudioWorkspace status={status.data} statusError={statusError} onRefreshStatus={() => void status.refetch()} onLogout={() => logout.mutate()} />}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
