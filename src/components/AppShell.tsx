import { PanelLeft, PanelRight } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ControlStatus } from "@/types";

interface AppShellProps {
  title: string;
  status: ControlStatus;
  sidebar: ReactNode;
  modelControl: ReactNode;
  children: ReactNode;
  onDiagnostics: () => void;
  diagnosticsOpen: boolean;
}

export function AppShell({ title, status, sidebar, modelControl, children, onDiagnostics, diagnosticsOpen }: AppShellProps) {
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(() => window.matchMedia("(max-width: 820px)").matches);
  const healthy = status.stage === "ready";
  const sidebarOpen = mobileViewport ? mobileSidebarOpen : desktopSidebarOpen;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 820px)");
    const update = () => setMobileViewport(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const toggleSidebar = () => {
    if (mobileViewport) setMobileSidebarOpen((open) => !open);
    else setDesktopSidebarOpen((open) => !open);
  };

  return (
    <TooltipProvider delayDuration={350}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="icon"
            size="icon"
            className="sidebar-toggle"
            onClick={toggleSidebar}
            aria-label={sidebarOpen ? "履歴を閉じる" : "履歴を開く"}
            aria-expanded={sidebarOpen}
            aria-controls={mobileViewport ? "mobile-sidebar-panel" : "desktop-sidebar-panel"}
          >
            <PanelLeft />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{sidebarOpen ? "履歴を閉じる" : "履歴を開く"}</TooltipContent>
      </Tooltip>

      <div className={`studio-shell ${desktopSidebarOpen ? "" : "is-sidebar-closed"} ${diagnosticsOpen ? "is-diagnostics-open" : ""}`}>
        <aside
          id="desktop-sidebar-panel"
          className="desktop-sidebar"
          aria-hidden={!desktopSidebarOpen}
          inert={!desktopSidebarOpen}
        >
          {sidebar}
        </aside>
        <div className="studio-main">
          <header className="studio-header">
            <h1 title={title}>{title}</h1>
            <div className="header-status">
              {modelControl}
              <span className={`gpu-health ${healthy ? "is-healthy" : ""}`}><i />{healthy ? "GPU 健康" : "GPU オフライン"}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="icon"
                    size="icon"
                    className="diagnostics-toggle"
                    onClick={onDiagnostics}
                    aria-label={diagnosticsOpen ? "診断を閉じる" : "診断を開く"}
                    aria-expanded={diagnosticsOpen}
                    aria-controls="diagnostics-panel"
                  >
                    <PanelRight />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{diagnosticsOpen ? "診断を閉じる" : "診断を開く"}</TooltipContent>
              </Tooltip>
            </div>
          </header>
          {children}
        </div>
      </div>

      <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen} modal={false}>
        <SheetContent id="mobile-sidebar-panel" side="left" className="mobile-sidebar-sheet" showClose={false}>
          <SheetTitle className="sr-only">文字起こし履歴</SheetTitle>
          <SheetDescription className="sr-only">保存済みセッションの選択と管理</SheetDescription>
          <div onClick={(event) => {
            const target = event.target as HTMLElement;
            if (target.closest(".history-select") || target.closest(".new-transcription-button")) setMobileSidebarOpen(false);
          }}>
            {sidebar}
          </div>
        </SheetContent>
      </Sheet>
    </TooltipProvider>
  );
}
