/**
 * 出站地址守卫 —— 判断一个主机名是否指向「本机 / 内网」。
 *
 * 有两处都需要它，且必须用同一套判定，否则会出现「一边挡住、另一边放行」的缺口：
 *  1. `sources/web.ts`：用户给的 URL 会被服务端代抓，天然是 SSRF 面；
 *  2. `byok.ts`：用户给的模型网关地址同样由服务端代请求。
 *
 * 踩过的坑：`new URL('http://[::1]/').hostname` 是带方括号的 `'[::1]'`，
 * 用 `host === '::1'` 比对永远不成立 —— IPv6 回环就这样从守卫底下漏了过去。
 * 所以这里先把方括号剥掉再判。
 *
 * 已知残余风险：本模块只看**字面量**，不做 DNS 解析。一个指向 127.0.0.1 的
 * 公网域名仍能通过（DNS rebinding）。要彻底堵住得在 fetch 层做 IP 校验，
 * 代价与收益不成比例，这里明确记录该限制。
 */

/** IPv4 私有 / 保留段 */
function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;

  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8、10/8、回环
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 169 && b === 254) return true; // 169.254/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  return false;
}

/** IPv6 回环 / ULA / link-local / IPv4-mapped（入参已剥掉方括号） */
function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::' || h === '::1') return true;

  // ::ffff:127.0.0.1 这种点分写法
  const dotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return isPrivateIpv4(dotted[1]);

  // ::ffff:7f00:1 —— Node 的 URL 解析器会把上面那种写法归一化成这个形态
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return isPrivateIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }

  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 唯一本地地址
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 链路本地
  return false;
}

/**
 * 主机名是否属于「不该被服务端代访」的范围。
 * 空主机名一律视为不安全 —— 调用方拿到的多半是解析失败的结果。
 */
export function isPrivateHostname(rawHost: string): boolean {
  let host = (rawHost ?? '').trim().toLowerCase();
  if (!host) return true;

  // IPv6 字面量在 hostname 里带方括号：[::1] / [fd00::1]
  if (host.startsWith('[') && host.endsWith(']')) {
    return isPrivateIpv6(host.slice(1, -1));
  }

  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // 内网 / 保留后缀
  if (/\.(local|internal|intranet|lan|home|corp)$/.test(host)) return true;

  // 纯数字主机名是 IP 的十进制简写（如 http://2130706433/），一律拒绝
  if (/^\d+$/.test(host)) return true;

  if (isPrivateIpv4(host)) return true;

  // 没有方括号的裸 IPv6，兜住
  if (host.includes(':')) return isPrivateIpv6(host);

  return false;
}
