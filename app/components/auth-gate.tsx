"use client";

import { createContext, type FormEvent, type ReactNode, useCallback, useContext, useEffect, useState } from "react";

type AuthContextValue = {
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth 必须在 AuthGate 内使用");
  return value;
}

type AuthPayload = {
  authenticated?: boolean;
  error?: string;
  code?: string;
};

async function readPayload(response: Response): Promise<AuthPayload> {
  return response.json().catch(() => ({})) as Promise<AuthPayload>;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "authenticated" | "anonymous">("checking");
  const [inviteCode, setInviteCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })
      .then(async response => ({ response, payload: await readPayload(response) }))
      .then(({ response, payload }) => {
        if (!active) return;
        setState(response.ok && payload.authenticated ? "authenticated" : "anonymous");
        if (response.status === 503) setMessage(payload.error || "登录服务尚未配置，请联系管理员");
      })
      .catch(() => {
        if (active) {
          setState("anonymous");
          setMessage("暂时无法连接登录服务，请稍后重试");
        }
      });
    const requireLogin = () => setState("anonymous");
    window.addEventListener("yida:auth-required", requireLogin);
    return () => {
      active = false;
      window.removeEventListener("yida:auth-required", requireLogin);
    };
  }, []);

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!inviteCode.trim() || submitting) return;
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ inviteCode: inviteCode.trim() }),
      });
      const payload = await readPayload(response);
      if (!response.ok || !payload.authenticated) {
        setMessage(payload.error || "邀请码无效，请确认后重试");
        return;
      }
      setInviteCode("");
      setState("authenticated");
    } catch {
      setMessage("暂时无法登录，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", cache: "no-store" });
    } finally {
      for (let index = window.sessionStorage.length - 1; index >= 0; index--) {
        const key = window.sessionStorage.key(index);
        if (key?.startsWith("yida:")) window.sessionStorage.removeItem(key);
      }
      setState("anonymous");
      setMessage("");
    }
  }, []);

  if (state === "checking") {
    return <main className="auth-shell"><section className="auth-card auth-loading" aria-live="polite"><span className="auth-mark">易</span><p>正在确认登录状态…</p></section></main>;
  }

  if (state === "anonymous") {
    return <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-brand"><span className="auth-mark">易</span><div><b>易搭</b><small>AI OUTFIT ASSISTANT</small></div></div>
        <div className="auth-copy"><span>PRIVATE WARDROBE</span><h1>欢迎回到你的私人衣柜</h1><p>输入分配给你的邀请码。同一邀请码在不同设备登录，都会回到同一个衣柜。</p></div>
        <form className="auth-form" onSubmit={login}>
          <label htmlFor="invite-code">邀请码</label>
          <input
            id="invite-code"
            type="password"
            value={inviteCode}
            onChange={event => setInviteCode(event.target.value)}
            placeholder="请输入邀请码"
            autoComplete="current-password"
            maxLength={128}
            autoFocus
          />
          {message && <p className="auth-error" role="alert">{message}</p>}
          <button type="submit" disabled={submitting || !inviteCode.trim()}>{submitting ? "正在登录…" : "进入易搭"}<span>→</span></button>
        </form>
        <p className="auth-footnote">邀请码只用于识别你的个人数据，请勿转发给其他人。</p>
      </section>
    </main>;
  }

  return <AuthContext.Provider value={{ logout }}>{children}</AuthContext.Provider>;
}
