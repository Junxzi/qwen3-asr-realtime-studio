import { useMutation } from "@tanstack/react-query";
import { ArrowRight, LockKeyhole, LoaderCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "@/api";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";

export function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const mutation = useMutation({ mutationFn: () => api.login(password), onSuccess });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate();
  };
  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-brand">
          <BrandMark />
          <span>InfoDeliver ASR Studio</span>
        </div>
        <div className="login-copy">
          <p>共有ワークスペース</p>
          <h1 id="login-title">文字起こし環境へログイン</h1>
          <span>用途に合わせてInfoDeliverの文字起こしモデルを選択できます。</span>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="password">操作パスワード</label>
          <div className="password-input">
            <LockKeyhole aria-hidden="true" />
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoFocus
            />
          </div>
          {mutation.error ? <p className="form-error" role="alert">{mutation.error.message}</p> : null}
          <Button type="submit" size="lg" disabled={mutation.isPending || !password}>
            {mutation.isPending ? <LoaderCircle className="spin" data-icon="inline-start" /> : null}
            ログイン
            {!mutation.isPending ? <ArrowRight data-icon="inline-end" /> : null}
          </Button>
        </form>
        <p className="login-security">音声本体はRailwayへ保存されません。認証CookieはHttpOnlyで管理されます。</p>
      </section>
    </main>
  );
}
