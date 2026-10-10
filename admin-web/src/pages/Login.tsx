import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound } from "lucide-react";
import { api, getGwKey, setGwKey, setToken } from "../api";
import { Button, Card, CardBody, CardHeader, Input, Label } from "../components/ui";

export default function Login() {
  const nav = useNavigate();
  const [password, setPassword] = useState("");
  const [gwKey, setGwKeyInput] = useState(getGwKey());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    if (!password) {
      setErr("请输入管理密码");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      setGwKey(gwKey.trim());
      const res = await api.post<{ token: string }>("api/login", { password });
      setToken(res.token);
      nav("/egress", { replace: true });
    } catch (e) {
      setErr((e as Error).message || "登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-sm flex-col justify-center px-4">
      <Card>
        <CardHeader title="muse-proxy 后台管理" desc="请输入管理员密码（MP_ADMIN_PASSWORD）" />
        <CardBody>
          <div>
            <Label>管理密码</Label>
            <Input
              type="password"
              value={password}
              placeholder="••••••••"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
            />
          </div>
          <div>
            <Label>网关密钥（经网关 /mp 访问时填，直连留空）</Label>
            <Input
              type="password"
              value={gwKey}
              placeholder="网关边缘 key，可空"
              onChange={(e) => setGwKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
            />
          </div>
          {err && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-[12px] text-red-300">{err}</p>}
          <Button onClick={() => void submit()} disabled={busy} className="w-full">
            <KeyRound className="h-4 w-4" /> {busy ? "登录中…" : "登录"}
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}
