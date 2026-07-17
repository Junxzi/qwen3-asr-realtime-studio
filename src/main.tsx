import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "sonner";
import App from "./App";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 1000, refetchOnWindowFocus: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <Toaster theme="dark" position="bottom-center" closeButton />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
