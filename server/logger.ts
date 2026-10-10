// 请求日志: JSONL 落盘 + 内存环 (管理后台分页/搜索读取)。
import fs from "node:fs";
import { accessLogFile, env } from "./config.js";

export interface MpLogEntry {
  time: string;
  method: string;
  uri: string;
  status: number;
  latency_ms: number;
  client_ip: string;
  /** 内网绑定 IP, "default" = 未绑定走默认路由, "" = 未经过上游 (如边缘拒绝/静态)。 */
  egress_ip: string;
  egress_name: string;
  egress_public: string;
  upstream_status: number | null;
}

const RING_LIMIT = 5000;
const ring: MpLogEntry[] = [];
let lastTruncateCheck = 0;

export function logRequest(e: MpLogEntry): void {
  ring.push(e);
  if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
  try {
    fs.mkdirSync(env.dataDir, { recursive: true });
    fs.appendFileSync(accessLogFile(), `${JSON.stringify(e)}\n`, "utf8");
    const st = fs.statSync(accessLogFile());
    // 防爆盘: >100MB 每小时截断一次 (内存环保留热数据)。
    if (st.size > 100 * 1024 * 1024 && Date.now() - lastTruncateCheck > 3600_000) {
      lastTruncateCheck = Date.now();
      fs.truncateSync(accessLogFile(), 0);
    }
  } catch {
    /* 落盘失败不影响主流程 */
  }
}

export interface LogQuery {
  q?: string;
  limit?: number;
  offset?: number;
}

/** 文件倒序分页 (坏行跳过); 文件缺失回退内存环。 */
export function readLogs(query: LogQuery): { total: number; items: MpLogEntry[] } {
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 2000);
  const offset = Math.max(query.offset ?? 0, 0);
  const kw = (query.q ?? "").toLowerCase();
  const match = (e: MpLogEntry): boolean => {
    if (!kw) return true;
    return (
      e.uri.toLowerCase().includes(kw) ||
      e.method.toLowerCase().includes(kw) ||
      e.client_ip.includes(kw) ||
      (e.egress_ip || "").includes(kw) ||
      (e.egress_public || "").includes(kw) ||
      (e.egress_name || "").toLowerCase().includes(kw) ||
      String(e.status).includes(kw)
    );
  };
  try {
    const TAIL_LINES = 50_000;
    const stat = fs.statSync(accessLogFile());
    let lines: string[];
    if (stat.size <= 50 * 1024 * 1024) {
      lines = fs.readFileSync(accessLogFile(), "utf8").split("\n");
    } else {
      const fd = fs.openSync(accessLogFile(), "r");
      try {
        const CHUNK = 64 * 1024;
        let pos = stat.size;
        const chunks: Buffer[] = [];
        let newlines = 0;
        while (pos > 0 && newlines <= TAIL_LINES) {
          const len = Math.min(CHUNK, pos);
          pos -= len;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, pos);
          chunks.unshift(buf);
          for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) newlines++;
        }
        const text = Buffer.concat(chunks).toString("utf8");
        lines = text.split("\n");
        if (lines.length > TAIL_LINES) lines = lines.slice(lines.length - TAIL_LINES);
      } finally {
        fs.closeSync(fd);
      }
    }
    const rows: MpLogEntry[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = (lines[i] ?? "").trim();
      if (!line) continue;
      try {
        const e = JSON.parse(line) as MpLogEntry;
        if (match(e)) rows.push(e);
      } catch {
        /* 坏行跳过 */
      }
    }
    return { total: rows.length, items: rows.slice(offset, offset + limit) };
  } catch {
    const rows = ring.slice().reverse().filter(match);
    return { total: rows.length, items: rows.slice(offset, offset + limit) };
  }
}
