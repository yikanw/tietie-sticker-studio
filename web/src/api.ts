import { useEffect, useState, useCallback } from "react";
import type { Env, Project, CodexEnv } from "./types";

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `请求失败 ${r.status}`);
  return j as T;
}

export const api = {
  get: <T,>(url: string) => req<T>("GET", url),
  post: <T,>(url: string, body?: unknown) => req<T>("POST", url, body ?? {}),
  put: <T,>(url: string, body?: unknown) => req<T>("PUT", url, body ?? {}),
};

export function act(id: string, action: Record<string, unknown>) {
  return api.post<{ ok?: boolean; zip?: string; count?: number }>(`/api/projects/${id}/act`, action);
}

export function useEnv() {
  const [env, setEnv] = useState<Env | null>(null);
  const reload = useCallback(() => api.get<Env>("/api/env").then(setEnv).catch(() => {}), []);
  useEffect(() => {
    reload();
  }, [reload]);
  // Codex 还在启动时轮询，连上就停
  useEffect(() => {
    if (!env || env.codex.ok || env.codex.error) return;
    const t = setTimeout(reload, 1500);
    return () => clearTimeout(t);
  }, [env, reload]);
  return { env, reload, setEnv };
}

// 订阅项目实时状态
export function useProject(id: string) {
  const [project, setProject] = useState<Project | null>(null);
  const [codex, setCodex] = useState<CodexEnv | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const es = new EventSource(`/api/projects/${id}/events`);
    es.addEventListener("project", (e) => setProject(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("env", (e) => setCodex(JSON.parse((e as MessageEvent).data)));
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [id]);
  return { project, codex, connected };
}

export const fileUrl = (pid: string, name: string, rev?: number) => `/files/${pid}/${name}${rev ? `?r=${rev}` : ""}`;

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}
