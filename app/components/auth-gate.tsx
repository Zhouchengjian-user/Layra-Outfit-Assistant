"use client";

import { createContext, type FormEvent, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { LayraMark } from "./layra-mark";

type Provider = "invite" | "account";
type AuthContextValue = { logout: () => Promise<void>; provider: Provider };
type AuthPayload = { authenticated?: boolean; provider?: Provider; inviteAvailable?: boolean; accountAvailable?: boolean; error?: string };

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth 必须在 AuthGate 内使用");
  return value;
}

async function readPayload(response: Response): Promise<AuthPayload> {
  return response.json().catch(() => ({})) as Promise<AuthPayload>;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "authenticated" | "anonymous">("checking");
  const [provider, setProvider] = useState<Provider>("invite");
  const [accountAvailable, setAccountAvailable] = useState(false);
  const [inviteAvailable, setInviteAvailable] = useState(true);
  const [view, setView] = useState<"account" | "invite">("invite");
  const [inviteCode, setInviteCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
        const payload = await readPayload(response);
        if (!active) return;
        const hasAccount = payload.accountAvailable === true;
        setAccountAvailable(hasAccount);
        setInviteAvailable(payload.inviteAvailable === true);
        setView(hasAccount ? "account" : "invite");
        setProvider(payload.provider || "invite");
        setState(response.ok && payload.authenticated ? "authenticated" : "anonymous");
        const error = new URLSearchParams(window.location.search).get("auth_error");
        if (error) {
          setMessage(error === "denied" ? "登录已取消，请重试。" : "账号登录失败，请重试或使用邀请码。");
          window.history.replaceState({}, "", window.location.pathname);
        } else if (response.status === 503) setMessage(payload.error || "登录服务尚未配置，请联系管理员");
      } catch (error) {
        if (!active) return;
        setState("anonymous");
        setMessage(error instanceof Error ? error.message : "暂时无法连接登录服务，请稍后重试");
      }
    };
    void check();
    const requireLogin = () => setState("anonymous");
    window.addEventListener("yida:auth-required", requireLogin);
    return () => { active = false; window.removeEventListener("yida:auth-required", requireLogin); };
  }, []);

  const loginWithInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        cache: "no-store", body: JSON.stringify({ inviteCode: inviteCode.trim() }),
      });
      const payload = await readPayload(response);
      if (!response.ok || !payload.authenticated) throw new Error(payload.error || "邀请码无效，请确认后重试");
      setInviteCode("");
      setProvider("invite");
      setState("authenticated");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登录失败，请稍后重试");
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
      window.localStorage.removeItem("yida:city");
      window.localStorage.removeItem("yida:location");
      window.localStorage.removeItem("yida:generations");
      setProvider("invite");
      setView(accountAvailable ? "account" : "invite");
      setState("anonymous");
      setMessage("");
    }
  }, [accountAvailable]);

  if (state === "checking") {
    return <main className="auth-shell"><section className="auth-card auth-loading" aria-live="polite"><span className="auth-mark"><LayraMark /></span><p>正在确认登录状态…</p></section></main>;
  }

  if (state === "anonymous") {
    return <main className="auth-shell"><section className="auth-card">
      <div className="auth-brand"><span className="auth-mark"><LayraMark /></span><div><b>LAYRA</b><small>AI OUTFIT STUDIO</small></div></div>
      <div className="auth-copy"><span>PRIVATE WARDROBE</span><h1>欢迎回到你的私人衣柜</h1><p>{view === "invite" ? "输入分配给你的邀请码。同一邀请码在不同设备登录，都会回到同一个衣柜。" : "使用火山引擎身份服务登录或创建账号，继续管理你的衣柜与搭配。"}</p></div>
      {view === "invite" ? <form className="auth-form" onSubmit={loginWithInvite}>
        <label htmlFor="invite-code">邀请码</label><input id="invite-code" type="password" value={inviteCode} onChange={event => setInviteCode(event.target.value)} placeholder="请输入邀请码" autoComplete="current-password" maxLength={128} autoFocus />
        {message && <p className="auth-error" role="status">{message}</p>}
        <button type="submit" disabled={submitting || !inviteCode.trim()}>{submitting ? "正在处理…" : "进入 LAYRA"}<span>→</span></button>
      </form> : <div className="auth-form">
        {message && <p className="auth-error" role="status">{message}</p>}
        <a className="auth-account-link" href="/api/auth/agent/login">使用账号登录<span>→</span></a>
      </div>}
      {accountAvailable && inviteAvailable && <div className="auth-links"><button onClick={() => { setView(view === "invite" ? "account" : "invite"); setMessage(""); }}>{view === "invite" ? "使用账号登录" : "使用邀请码"}</button></div>}
      <p className="auth-footnote">{view === "invite" ? "邀请码只用于识别你的个人数据，请勿转发给其他人。" : "照片与衣柜数据仅在你的账号下可见。"}</p>
    </section></main>;
  }

  return <AuthContext.Provider value={{ logout, provider }}>{children}</AuthContext.Provider>;
}
