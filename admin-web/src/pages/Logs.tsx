import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtTime, type MpLogItem } from "../api";
import { Badge, Button, EmptyState, Input, Spinner } from "../components/ui";

const PAGE = 100;

function StatusCode({ code }: { code: unknown }) {
  if (typeof code !== "number" || !Number.isFinite(code) || code <= 0) {
    return <span className="inline-flex items-center justify-center whitespace-nowrap rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">—</span>;
  }
  const tone = code < 400 ? "bg-emerald-500 text-white" : code < 500 ? "bg-amber-500 text-white" : "bg-red-500 text-white";
  return (
    <span className={`inline-flex min-w-[44px] items-center justify-center whitespace-nowrap rounded-md px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums ${tone}`}>
      {code}
    </span>
  );
}

export default function Logs() {
  const [items, setItems] = useState<MpLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [keyword, setKeyword] = useState("");
  const [deb, setDeb] = useState("");
  const [offset, setOffset] = useState(0);
  const [auto, setAuto] = useState(true);
  const [loading, setLoading] = useState(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const kwTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    kwTimer.current = setTimeout(() => setDeb(keyword), 400);
    return () => {
      if (kwTimer.current) clearTimeout(kwTimer.current);
    };
  }, [keyword]);

  useEffect(() => {
    setOffset(0);
  }, [deb]);

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (deb) p.set("q", deb);
    p.set("limit", String(PAGE));
    p.set("offset", String(offset));
    try {
      const res = await api.get<{ total: number; items: MpLogItem[] }>(`api/logs?${p.toString()}`);
      setItems(res.items);
      setTotal(res.total);
    } finally {
      setLoading(false);
    }
  }, [deb, offset]);

  useEffect(() => {
    setLoading(true);
    void load().finally(() => setLoading(false));
    if (auto) timer.current = setInterval(() => void load(), 5000);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [load, auto]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input className="!w-56" placeholder="搜索 URI / 状态 / 出口 IP / 表名" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="accent-emerald-600" />
          自动刷新
        </label>
      </div>
      {loading ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Spinner className="h-6 w-6" />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-border/60 text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">时间</th>
                <th className="hidden px-3 py-2 font-medium sm:table-cell">客户端</th>
                <th className="px-3 py-2 font-medium">请求</th>
                <th className="px-3 py-2 text-center font-medium">状态</th>
                <th className="px-3 py-2 font-medium">出口 IP</th>
                <th className="px-3 py-2 text-right font-medium">耗时</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r, i) => (
                <tr key={`${r.time}-${i}`} className="border-t border-border/40 align-top hover:bg-muted/30">
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] tabular-nums text-muted-foreground">{fmtTime(r.time)}</td>
                  <td className="hidden px-3 py-2 font-mono text-[11px] sm:table-cell">{r.client_ip}</td>
                  <td className="px-3 py-2">
                    <span className="font-semibold">{r.method}</span>{" "}
                    <span className="break-all font-mono text-[11px]" title={r.uri}>{r.uri}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-center">
                    <StatusCode code={r.status} />
                  </td>
                  <td className="px-3 py-2" title={r.egress_ip && r.egress_public !== r.egress_ip ? `内网绑定 ${r.egress_ip}` : ""}>
                    {r.egress_public || r.egress_ip ? (
                      <>
                        <div className="break-all font-mono text-[11px] font-semibold">{r.egress_public || r.egress_ip}</div>
                        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                          {r.egress_name || "—"}
                          {r.egress_public && r.egress_ip && r.egress_public !== r.egress_ip && r.egress_ip !== "default" && <span> · 内 {r.egress_ip}</span>}
                        </div>
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[11px] tabular-nums">
                    {Number.isFinite(r.latency_ms) ? `${r.latency_ms}ms` : "—"}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <EmptyState title="没有匹配的日志" desc="调整关键词或对服务发起一些请求" />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-border/60 px-4 py-2.5 text-[12px] text-muted-foreground">
            <span>共 {total} 条 · 第 {Math.floor(offset / PAGE) + 1}/{Math.max(1, Math.ceil(total / PAGE))} 页</span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>上一页</Button>
              <Button variant="secondary" size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset((o) => o + PAGE)}>下一页</Button>
            </div>
          </div>
        </div>
      )}
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Badge variant="outline">提示</Badge> 上游看到的即公网列；表名即宿主机策略路由表名。
      </p>
    </div>
  );
}
