/**
 * 假的 `cloudflare:sockets` —— 用内存流模拟一个 SSTP 服务器。
 *
 * 目的：让 check-worker.js 原样跑一遍「HTTP 升级 → CALL_CONNECT → LCP → PAP
 * → IPCP(Nak) → 隧道内 TCP → 明文 HTTP」，并且**独立实现**校验和/组包，
 * 用第三方视角校验被测代码的字节级正确性。
 *
 * 注意：这个文件只用于本地验证，不属于交付物。
 */

export const state = {
  connectLog: [],
  opts: {},
  lastServer: null,
};

export function resetState(opts = {}) {
  state.connectLog = [];
  state.opts = opts;
  state.lastServer = null;
}

/* ------------------------------ 工具 ------------------------------ */
const cat = (...ps) => {
  let n = 0;
  for (const p of ps) n += p.length;
  const o = new Uint8Array(n);
  let k = 0;
  for (const p of ps) {
    o.set(p, k);
    k += p.length;
  }
  return o;
};
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const ipBytes = (ip) => new Uint8Array(ip.split('.').map(Number));

/** 反码求和；校验时把结果与 0 比较即可（0 表示正确） */
function sum16(bytes, off, len) {
  let s = 0;
  for (let i = off; i < off + len - 1; i += 2) s += u16(bytes, i);
  if (len & 1) s += bytes[off + len - 1] << 8;
  while (s >> 16) s = (s & 0xffff) + (s >> 16);
  return ~s & 0xffff;
}

/* ----------------------------- 服务器 ----------------------------- */
export function createServer() {
  const o = state.opts;
  const exitIp = o.exitIp || '8.8.4.4';
  const assigned = o.assigned || '10.9.8.7';
  const body = o.body !== undefined ? o.body : `fl=1f2\nh=1.1.1.1\nip=${exitIp}\nts=1700000000\nvisit_scheme=http\n\n`;
  const httpStatus = o.httpStatus || 'HTTP/1.1 200 OK';

  let ctrl;
  const readable = new ReadableStream({ start(c) { ctrl = c; } });
  const push = (u8) => { try { ctrl.enqueue(u8); } catch {} };

  const st = {
    httpHead: null,          // 客户端发来的 HTTP 升级请求头
    sstpMergedWithHttp: false, // 违规：HTTP 请求与 SSTP 包合并发送
    controlPackets: 0,       // 我们发出去的 CALL_CONNECT_ACK 计数
    lcpAcked: false,         // 收到了客户端的 LCP Configure-Request
    peerConfSent: false,     // 我们主动发了 LCP Configure-Request
    peerConfAcked: false,    // 客户端 Ack 了我们的 Configure-Request
    papUser: null,
    papPass: null,
    ipcpNakSent: false,
    ipcpAckSent: false,
    ipcpReqCount: 0,
    synSeen: false,
    ipChecksumOk: null,
    tcpChecksumOk: null,
    udpOrOtherProto: null,
    clientIp: null,
    clientPort: 0,
    tunnelReq: null,         // 隧道内明文 HTTP 请求
    pppSeen: [],
  };

  let buf = new Uint8Array(0);
  let firstWrite = true;
  const conns = new Map(); // 源端口 → 会话状态

  /* ---- PPP 组包（服务器侧独立实现，不复用被测代码） ---- */
  const pppFrame = (protocol, code, id, options = []) => {
    let ol = 0;
    for (const op of options) ol += 2 + op.data.length;
    const b = new Uint8Array(6 + ol);
    b[0] = protocol >> 8;
    b[1] = protocol & 0xff;
    b[2] = code;
    b[3] = id;
    b[4] = (4 + ol) >> 8;
    b[5] = (4 + ol) & 0xff;
    let p = 6;
    for (const op of options) {
      b[p] = op.type;
      b[p + 1] = 2 + op.data.length;
      b.set(op.data, p + 2);
      p += 2 + op.data.length;
    }
    return b;
  };
  const sstpData = (frame) => {
    const l = 6 + frame.length;
    const b = new Uint8Array(l);
    b.set([0x10, 0x00, ((l >> 8) & 0x0f) | 0x80, l & 0xff, 0xff, 0x03], 0);
    b.set(frame, 6);
    return b;
  };
  const sendPpp = (protocol, code, id, options) => push(sstpData(pppFrame(protocol, code, id, options)));

  const sstpControl = (msgType) => {
    const b = new Uint8Array(8);
    b.set([0x10, 0x01, 0x80, 0x08], 0);
    b[4] = msgType >> 8;
    b[5] = msgType & 0xff;
    return b;
  };

  /* ---- 隧道内 TCP（服务器侧组包） ---- */
  const tcpSegment = (flags, seq, ack, fromIp, toIp, fromPort, toPort, payload = new Uint8Array(0)) => {
    const tcpLen = 20 + payload.length;
    const ipLen = 20 + tcpLen;
    const total = 8 + ipLen;
    const f = new Uint8Array(total);
    f.set([0x10, 0x00, ((total >> 8) & 0x0f) | 0x80, total & 0xff, 0xff, 0x03, 0x00, 0x21], 0);

    const ip = 8;
    f.set([0x45, 0x00, ipLen >> 8, ipLen & 0xff, 0x12, 0x34, 0x40, 0x00, 64, 6], ip);
    f.set(ipBytes(fromIp), ip + 12);
    f.set(ipBytes(toIp), ip + 16);
    const c = sum16(f, ip, 20);
    f[ip + 10] = c >> 8;
    f[ip + 11] = c & 0xff;

    const t = ip + 20;
    f[t] = fromPort >> 8; f[t + 1] = fromPort & 0xff;
    f[t + 2] = toPort >> 8; f[t + 3] = toPort & 0xff;
    f[t + 4] = seq >>> 24; f[t + 5] = (seq >>> 16) & 0xff; f[t + 6] = (seq >>> 8) & 0xff; f[t + 7] = seq & 0xff;
    f[t + 8] = ack >>> 24; f[t + 9] = (ack >>> 16) & 0xff; f[t + 10] = (ack >>> 8) & 0xff; f[t + 11] = ack & 0xff;
    f[t + 12] = 0x50;
    f[t + 13] = flags;
    f[t + 14] = 0xff; f[t + 15] = 0xff;
    if (payload.length) f.set(payload, t + 20);

    const ph = new Uint8Array(12 + tcpLen);
    ph.set(ipBytes(fromIp), 0);
    ph.set(ipBytes(toIp), 4);
    ph[8] = 0;
    ph[9] = 6;
    ph[10] = tcpLen >> 8;
    ph[11] = tcpLen & 0xff;
    ph.set(f.subarray(t, t + tcpLen), 12);
    const tc = sum16(ph, 0, 12 + tcpLen);
    f[t + 16] = tc >> 8;
    f[t + 17] = tc & 0xff;
    return f;
  };

  /** 用独立实现验算客户端发来的 IP/TCP 校验和（正确时与 0 求和为 0） */
  const verifySegment = (ip) => {
    st.ipChecksumOk = sum16(ip, 0, 20) === 0;
    st.udpOrOtherProto = ip[9];
    const ihl = (ip[0] & 0x0f) * 4;
    const tcpLen = u16(ip, 2) - ihl;
    const ph = new Uint8Array(12 + tcpLen);
    ph.set(ip.subarray(12, 20), 0);
    ph[8] = 0;
    ph[9] = 6;
    ph[10] = tcpLen >> 8;
    ph[11] = tcpLen & 0xff;
    ph.set(ip.subarray(ihl, ihl + tcpLen), 12);
    st.tcpChecksumOk = sum16(ph, 0, 12 + tcpLen) === 0;
  };

  /* ---- PPP 分发 ---- */
  const onPpp = (frame) => {
    if (frame[0] === 0xff && frame[1] === 0x03) frame = frame.subarray(2);
    const proto = u16(frame, 0);
    const code = frame[2];
    const id = frame[3];
    st.pppSeen.push(`${proto.toString(16)}/${code}`);

    if (proto === 0xc021) {
      if (code === 1) {
        st.lcpAcked = true;
        st.controlPackets++;
        push(sstpControl(0x0002)); // CALL_CONNECT_ACK，顺带验证客户端会跳过控制包
        const ack = new Uint8Array(frame);
        ack[2] = 2;
        push(sstpData(ack));
        if (!st.peerConfSent) {
          st.peerConfSent = true;
          // 主动发我们的 Configure-Request（MRU 1500），逼客户端走 peerAcked 分支
          sendPpp(0xc021, 1, 0x33, [{ type: 1, data: new Uint8Array([0x05, 0xdc]) }]);
        }
      } else if (code === 2) {
        st.peerConfAcked = true;
      }
    } else if (proto === 0xc023) {
      const ulen = frame[6];
      st.papUser = new TextDecoder().decode(frame.subarray(7, 7 + ulen));
      const plen = frame[7 + ulen];
      st.papPass = new TextDecoder().decode(frame.subarray(8 + ulen, 8 + ulen + plen));
      const ack = new Uint8Array(7);
      ack.set([0xc0, 0x23, 2, id, 0, 5, 0], 0);
      push(sstpData(ack));
    } else if (proto === 0x8021) {
      if (code === 1) {
        st.ipcpReqCount++;
        if (!st.ipcpNakSent) {
          // 真实行为：第一次用 Configure-Nak 建议地址
          st.ipcpNakSent = true;
          sendPpp(0x8021, 3, 0x21, [{ type: 3, data: ipBytes(assigned) }]);
        } else {
          st.ipcpAckSent = true;
          sendPpp(0x8021, 2, 0x22, [{ type: 3, data: ipBytes(assigned) }]);
        }
      } else if (code === 2) {
        st.peerIpcpAcked = true;
      }
    } else if (proto === 0x0021) {
      const ip = frame.subarray(2);
      verifySegment(ip);
      const ihl = (ip[0] & 0x0f) * 4;
      const flags = ip[ihl + 13];
      const seq = u32(ip, ihl + 4);
      const fromPort = u16(ip, ihl);
      const toPort = u16(ip, ihl + 2);
      const payOff = ihl + ((ip[ihl + 12] >> 4) & 0x0f) * 4;
      const payload = ip.subarray(payOff);

      st.clientIp = Array.from(ip.subarray(12, 16)).join('.');
      st.clientPort = fromPort;
      if (!conns.has(fromPort)) conns.set(fromPort, { srvSeq: 0x11223344, peerSeq: seq });

      const c = conns.get(fromPort);
      if ((flags & 0x02) !== 0) {
        // SYN → SYN-ACK
        st.synSeen = true;
        c.peerSeq = seq;
        push(tcpSegment(0x12, c.srvSeq, (seq + 1) >>> 0, o.serverIp || '1.1.1.1', st.clientIp, toPort, fromPort));
        return;
      }
      if (payload.length) {
        st.tunnelReq = new TextDecoder().decode(payload);
        const head = `${httpStatus}\r\nContent-Length: ${body.length}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n`;
        const bytes = new TextEncoder().encode(head + body);
        c.srvSeq = (c.srvSeq + 1) >>> 0;
        // PSH|FIN|ACK 一次发完（真实端点常见行为）
        push(tcpSegment(0x19, c.srvSeq, (seq + payload.length) >>> 0, o.serverIp || '1.1.1.1', st.clientIp, toPort, fromPort, bytes));
        c.srvSeq = (c.srvSeq + bytes.length) >>> 0;
      }
    }
  };

  /* ---- 收流 ---- */
  const handle = (chunk) => {
    buf = cat(buf, chunk);

    if (st.httpHead === null) {
      const s = new TextDecoder('latin1').decode(buf);
      const end = s.indexOf('\r\n\r\n');
      if (end === -1) return;
      st.httpHead = s.slice(0, end);
      // 违规检测：HTTP 头之后还有字节 → 说明 SSTP 包和请求合并发送了
      if (buf.length > end + 4) st.sstpMergedWithHttp = true;
      buf = buf.subarray(end + 4);
      push(new TextEncoder().encode(`${httpStatus}\r\nContent-Length: 18446744073709551615\r\n\r\n`));
    }

    while (buf.length >= 4) {
      const len = u16(buf, 2) & 0x0fff;
      if (len < 4 || buf.length < len) break;
      const pkt = buf.subarray(0, len);
      buf = buf.subarray(len);
      if ((pkt[1] & 1) === 0) onPpp(pkt.subarray(6, len));
    }
  };

  const writable = new WritableStream({
    write(chunk) {
      const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (firstWrite) {
        firstWrite = false;
        const s = new TextDecoder('latin1').decode(u8);
        if (!s.startsWith('SSTP_DUPLEX_POST ')) st.firstWriteNotHttp = s.slice(0, 40);
      }
      handle(u8);
    },
    close() {
      try { ctrl.close(); } catch {}
    },
  });

  return { readable, writable, st, ctrl };
}

export function connect(addr, opts) {
  state.connectLog.push({ addr, opts });
  const srv = createServer();
  state.lastServer = srv;
  return {
    opened: Promise.resolve(),
    readable: srv.readable,
    writable: srv.writable,
    closed: Promise.resolve(),
    close() {
      try { srv.ctrl.close(); } catch {}
    },
  };
}
