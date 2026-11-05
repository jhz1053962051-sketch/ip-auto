/**
 * VPN Gate 数据源抓取与解析（纯 Node，无第三方依赖）
 *
 * 参考来源（仅借鉴流程与字段布局，代码为本项目自写）：
 *   - https://github.com/hezhanleiok/gate  vpngate.py（无 LICENSE，仅读思路）
 *   - https://www.vpngate.net/api/iphone/   官方 CSV 接口
 *
 * 官方 CSV 首行 "*vpn_servers"，第二行是 "#HostName,IP,Score,Ping,Speed,
 * CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,
 * LogType,Operator,Message,OpenVPN_ConfigData_Base64"，最后一行 "*"。
 */
import { httpRequest } from './http.mjs';

export const VPNGATE_API = 'http://www.vpngate.net/api/iphone/';
export const VPNGATE_API_TLS = 'https://www.vpngate.net/api/iphone/';
/** 社区镜像（官方站点被墙时的兜底） */
export const VPNGATE_MIRROR =
  'https://raw.githubusercontent.com/fdciabdul/Vpngate-Scraper-API/main/json/data.json';

/** 极简 CSV 解析：处理双引号包裹与转义引号 */
export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * 从 OpenVPN 配置里抽出 SSTP 可用信息。
 * VPN Gate 的 SSTP 复用 443 端口 + TCP，OpenVPN 配置里的 proto tcp / remote 端口可作依据。
 * @returns {{ok:boolean, host?:string, port?:number, reason?:string}}
 */
export function sstpFromConfig(host, configB64) {
  if (!configB64) return { ok: false, reason: 'no-config' };
  let cfg;
  try {
    cfg = Buffer.from(configB64, 'base64').toString('utf8');
  } catch {
    return { ok: false, reason: 'bad-base64' };
  }
  const proto = cfg.match(/^\s*proto\s+(\S+)/im);
  if (!proto) return { ok: false, reason: 'no-proto' };
  const p = proto[1].toLowerCase();
  if (!/^tcp/.test(p)) return { ok: false, reason: `proto-${p}` };

  const remote = cfg.match(/^\s*remote\s+(\S+)(?:\s+(\d+))?/im);
  let hostName = host;
  let port = 0;
  if (remote) {
    const rh = remote[1];
    if (remote[2]) port = Number(remote[2]);
    // VPN Gate 常见写法：remote 是 IP，hostname 才是 opengw.net 主机名
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(rh)) hostName = rh;
  }
  if (!Number.isFinite(port) || port <= 0) port = 443;
  // CSV 里的 HostName 常是不带域名的短名（public-vpn-129），补全为 opengw.net
  if (!hostName.includes('.') && !/^\d+\.\d+\.\d+\.\d+$/.test(hostName)) hostName = `${hostName}.opengw.net`;
  // 关键：SSTP 走的是 / 这个节点的 TLS 端口，机房节点一律 443，
  // 但真实家宽节点（vpnNNNNNNNN.opengw.net）的 SSTP 端口 = OpenVPN 配置里的 remote 端口
  // （1223 / 995 / 8443 …）。写死 443 会把所有住宅节点误判为不可用。
  return { ok: true, host: hostName, port };
}

/** 解析官方 CSV 文本 */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && l.trim() !== '*');
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].replace(/^#/, '').toLowerCase().includes('hostname')) { headerIdx = i; break; }
  }
  if (headerIdx === -1) throw new Error('VPN Gate CSV 缺少表头行');
  const header = parseCsvLine(lines[headerIdx].replace(/^#/, '')).map((h) => h.trim().toLowerCase());

  const idxOf = (...names) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };
  const iHost = idxOf('hostname');
  const iIp = idxOf('ip');
  const iCL = idxOf('countrylong');
  const iCS = idxOf('countryshort');
  const iScore = idxOf('score');
  const iPing = idxOf('ping');
  const iSpeed = idxOf('speed');
  const iSessions = idxOf('numvpnsessions');
  let iCfg = idxOf('openvpn_configdata_base64');
  if (iCfg === -1) iCfg = header.findIndex((h) => h.includes('base64'));

  const rows = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const f = parseCsvLine(line);
    if (f.length < 7) continue;
    const host = (f[iHost] || '').trim();
    const ip = (f[iIp] || '').trim();
    if (!host || !ip) continue;
    rows.push({
      host,
      ip,
      country: (f[iCL] || '').trim(),
      countryCode: (f[iCS] || '').trim().toUpperCase(),
      score: Number(f[iScore] || 0) || 0,
      ping: Number(f[iPing] || 0) || 0,
      speed: Number(f[iSpeed] || 0) || 0,
      sessions: Number(f[iSessions] || 0) || 0,
      configB64: iCfg >= 0 ? (f[iCfg] || '').trim() : '',
    });
  }
  return rows;
}

/** 镜像 JSON → 统一行结构 */
export function parseMirror(json) {
  let items = json;
  if (!Array.isArray(items)) items = [items];
  const servers = [];
  for (const it of items) {
    if (!it) continue;
    if (Array.isArray(it.servers)) servers.push(...it.servers);
    else servers.push(it);
  }
  const rows = [];
  for (const s of servers) {
    const host = String(s.hostname || s.host || '').trim();
    const ip = String(s.ip || '').trim();
    if (!host || !ip) continue;
    rows.push({
      host,
      ip,
      country: String(s.countrylong || s.country_long || s.country || '').trim(),
      countryCode: String(s.countryshort || s.country_short || '').trim().toUpperCase(),
      score: Number(s.score || 0) || 0,
      ping: Number(s.ping || 0) || 0,
      speed: Number(s.speed || 0) || 0,
      sessions: Number(s.numvpnsessions || 0) || 0,
      configB64: String(s.openvpn_configdata_base64 || s.config_b64 || '').trim(),
    });
  }
  return rows;
}

/**
 * 依次尝试多个数据源；任一成功即返回。
 * @param {{proxy?:object, timeoutMs?:number, log?:(s:string)=>void}} opt
 */
export async function fetchVpngate(opt = {}) {
  const { proxy = null, timeoutMs = 45000, log = () => {} } = opt;
  const attempts = [
    { name: 'vpngate-https', url: VPNGATE_API_TLS, kind: 'csv' },
    { name: 'vpngate-http', url: VPNGATE_API, kind: 'csv' },
    { name: 'mirror-json', url: VPNGATE_MIRROR, kind: 'json' },
  ];
  const errors = [];
  for (const a of attempts) {
    try {
      log(`尝试数据源 ${a.name}: ${a.url}`);
      const r = await httpRequest(a.url, { proxy, timeoutMs });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const rows = a.kind === 'csv' ? parseCsv(r.body) : parseMirror(JSON.parse(r.body));
      if (!rows.length) throw new Error('解析结果为空');
      log(`数据源 ${a.name} 成功，共 ${rows.length} 行`);
      return { rows, source: a.name, url: a.url };
    } catch (e) {
      const msg = e?.message || String(e);
      log(`数据源 ${a.name} 失败: ${msg}`);
      errors.push(`${a.name}: ${msg}`);
    }
  }
  throw new Error(`全部数据源失败 → ${errors.join(' | ')}`);
}

/**
 * 行 → SSTP 节点（只保留 TCP 可用的）
 * @param {Array} rows
 * @param {{countries?:string[]}} opt
 */
export function toSstpNodes(rows, opt = {}) {
  const countries = (opt.countries || []).map((c) => c.toUpperCase()).filter(Boolean);
  const out = [];
  const stats = { total: 0, notTcp: 0, filtered: 0, noConfig: 0 };
  for (const r of rows) {
    stats.total++;
    if (countries.length && !countries.includes(r.countryCode)) { stats.filtered++; continue; }
    const s = sstpFromConfig(r.host, r.configB64);
    if (!s.ok) {
      if (s.reason === 'no-config') stats.noConfig++;
      else stats.notTcp++;
      continue;
    }
    out.push({
      host: s.host || r.host,
      ip: r.ip,
      port: s.port,
      country: r.country,
      countryCode: r.countryCode,
      proto: 'sstp',
      source: 'vpngate',
      link: `sstp://vpn:vpn@${s.host || r.host}:${s.port}`,
    });
  }
  return { nodes: out, stats };
}

/** 去重：host+port */
export function dedupeNodes(nodes) {
  const seen = new Set();
  const out = [];
  for (const n of nodes) {
    const k = `${n.host.toLowerCase()}:${n.port}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}
