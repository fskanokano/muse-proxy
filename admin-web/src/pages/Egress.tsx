import { useCallback, useEffect, useState } from "react";
import { Save } from "lucide-react";
import { api, type EgressStatus } from "../api";
import { Badge, Button, Card, CardBody, CardHeader, Label, Segmented, Spinner, Switch } from "../components/ui";

export default function Egress() {
  const [st, setSt] = useState<EgressStatus | null>(null);
  const [mode, setMode] = useState<"primary" | "secondary">("primary");
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.get<EgressStatus>("api/egress");
      setSt(s);
      setMode(s.mode);
      setSelected(s.selected);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const usable = (st?.secondaries ?? []).filter((x) => x.usable).map((x) => x.ip);
  const effective = selected.length ? usable.filter((ip) => selected.includes(ip)) : usable;

  const toggle = (ip: string) => {
    const on = effective.includes(ip);
    if (on && effective.length <= 1) {
      setMsg({ ok: false, text: "至少保留一个启用的出口 IP" });
      return;
    }
    const next = on ? effective.filter((x) => x !== ip) : [...effective, ip];
    const sameAsAll = next.length === usable.length && usable.every((x) => next.includes(x));
    setSelected(sameAsAll ? [] : next);
    setMsg(null);
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await api.put<{ ok: boolean; settings: { egress_mode: string } }>("api/egress", {
        mode,
        egress_ips_enabled: selected,
      });
      setMsg({ ok: true, text: `已保存并生效（${res.settings.egress_mode}）` });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  if (loading && !st) {
    return (
      <div className="flex justify-center py-16 text-muted-foreground">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="出口 IP 模式" desc="反向代理到上游 AI 时用的源地址，保存即时生效（本机直连，无需 reload）" />
        <CardBody>
          <div>
            <Label>模式</Label>
            <Segmented
              options={[
                { value: "primary", label: "主出口 IP" },
                { value: "secondary", label: "副出口轮询" },
              ]}
              value={mode}
              onChange={setMode}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              主出口：走本机默认路由，上游只看到主公网 IP。副出口：在启用的副出口间按请求轮换，上游看到的源 IP 动态变化。
            </p>
          </div>
          {msg && (
            <p className={`rounded-lg px-3 py-2 text-[12px] ${msg.ok ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300"}`}>
              {msg.text}
            </p>
          )}
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Spinner className="h-4 w-4" /> : <Save className="h-4 w-4" />} 保存并生效
          </Button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="出口发现" desc="本机策略路由自动发现，名字即路由表名" />
        <CardBody>
          {st?.default && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2">
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[12px] font-semibold">main（主出口）</span>
                  <Badge variant="outline">默认路由</Badge>
                </div>
                <div className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
                  {st.default.ip}{st.default.public_ip ? ` → ${st.default.public_ip}` : ""}
                </div>
              </div>
            </div>
          )}
          {(st?.secondaries ?? []).length === 0 && <p className="text-[12px] text-muted-foreground">暂无发现的副出口 IP。</p>}
          {(st?.secondaries ?? []).map((e) => {
            const on = effective.includes(e.ip);
            return (
              <div key={e.ip} className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[12px] font-semibold">{e.name}</span>
                    {!e.usable && <Badge variant="outline">不可用</Badge>}
                    {on && e.usable && <Badge variant="success">启用</Badge>}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] tabular-nums text-muted-foreground">
                    {e.ip}{e.public_ip ? ` → ${e.public_ip}` : " → 公网未知"}
                  </div>
                </div>
                <Switch checked={on} disabled={!e.usable} onCheckedChange={() => toggle(e.ip)} />
              </div>
            );
          })}
          <p className="text-[11px] text-muted-foreground">默认全选；副模式下至少保留一个启用。</p>
        </CardBody>
      </Card>
    </div>
  );
}
